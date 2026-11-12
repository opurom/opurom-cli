import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';

// R6: safe comment/whitespace minification + measured size reporting.
// No bundler, no source maps, no Brotli/zstd, no dependency graph analysis.

export const SIZE_MANIFEST = '.opurom-size.json';

const SIZE_SKIP = new Set(['target', 'data', 'node_modules', '.git']);
// `server`, `shared` and `migrations` are full-chain outputs, never emitter assets.
const REMOVE_SKIP = new Set([...SIZE_SKIP, 'server', 'shared', 'migrations']);
// Generic names a user may own in an output directory: never deleted as "unused".
const PROTECTED_NAMES = new Set([
  'README.md', 'readme.md', 'Cargo.toml', 'Cargo.lock', 'LICENSE', 'LICENCE', 'NOTICE', 'CHANGELOG.md',
]);

function walkBytes(root, skip) {
  const bytes = new Map();
  const base = path.resolve(root);
  const walk = (dir, prefix) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, rel);
      else if (entry.isFile()) bytes.set(rel, fs.statSync(file).size);
    }
  };
  walk(base, '');
  return bytes;
}

export function sizeBytes(root) {
  return walkBytes(root, SIZE_SKIP);
}

// ------------------------------------------------------------------ minifier

const OPERATORS = new Set('+-*/%=!<>&|^~?'.split(''));
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);
const REGEX_KEYWORDS = new Set([
  'return', 'throw', 'case', 'delete', 'void', 'typeof', 'instanceof', 'in', 'of', 'yield', 'await', 'else', 'do',
]);
const IDENT_START = /[A-Za-z_$\u0080-\uFFFF]/;
const IDENT_PART = /[A-Za-z0-9_$\u0080-\uFFFF]/;
const NUM_PART = /[0-9a-fA-FxXoObBeEn_]/;
const LINEBREAK = /[\r\n\u2028\u2029]/;

function scanQuoted(source, start, quote) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === '\\') { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error('unterminated string literal');
}

function scanRegex(source, start) {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (LINEBREAK.test(ch)) break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      i += 1;
      while (IDENT_PART.test(source[i] ?? '')) i += 1;
      return i;
    }
    i += 1;
  }
  throw new Error('unterminated regular expression literal');
}

function scanTemplate(source, start) {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') i = scanInterpolation(source, i + 2);
    else i += 1;
  }
  throw new Error('unterminated template literal');
}

function scanInterpolation(source, start) {
  const state = { last: null, control: false, paren: [] };
  let depth = 1;
  let i = start;
  while (i < source.length) {
    if (source[i] === '`') {
      i = scanTemplate(source, i);
      state.last = { kind: 'template', text: '' };
      continue;
    }
    const token = nextToken(source, i, state.last);
    updateState(state, token);
    if (token.kind === 'punct') {
      if (token.text === '{') depth += 1;
      else if (token.text === '}') {
        depth -= 1;
        if (depth === 0) return token.end;
      }
    }
    i = token.end;
  }
  throw new Error('unterminated template interpolation');
}

function canRegexAfter(token) {
  if (!token) return true;
  if (token.kind === 'word') return REGEX_KEYWORDS.has(token.text);
  if (token.kind !== 'punct') return false;
  if (token.text === ')' && token.control) return true;
  return ![')', ']', '}', '++', '--', '.'].includes(token.text);
}

// One token, from index. Comments and whitespace are separate kinds;
// every other token is returned as its verbatim source slice by the caller.
function nextToken(source, index, last) {
  const ch = source[index];
  const nx = source[index + 1];
  if (/\s/.test(ch)) {
    let i = index;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    return { end: i, kind: 'ws', text: source.slice(index, i) };
  }
  if (ch === '/' && nx === '/') {
    let i = index + 2;
    while (i < source.length && !LINEBREAK.test(source[i])) i += 1;
    return { end: i, kind: 'comment', text: source.slice(index, i) };
  }
  if (ch === '/' && nx === '*') {
    const close = source.indexOf('*/', index + 2);
    if (close === -1) throw new Error('unterminated block comment');
    const end = close + 2;
    return { end, kind: 'comment', text: source.slice(index, end) };
  }
  if (ch === '/' && canRegexAfter(last)) {
    const end = scanRegex(source, index);
    return { end, kind: 'regex', text: source.slice(index, end) };
  }
  if (ch === '"' || ch === "'") {
    const end = scanQuoted(source, index, ch);
    return { end, kind: 'string', text: source.slice(index, end) };
  }
  if (ch === '`') {
    const end = scanTemplate(source, index);
    return { end, kind: 'template', text: source.slice(index, end) };
  }
  if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(nx ?? ''))) {
    let i = index;
    let dot = false;
    while (i < source.length) {
      const c = source[i];
      if (c === '.' && !dot) { dot = true; i += 1; }
      else if ((c === '+' || c === '-') && /[eE]/.test(source[i - 1] ?? '')) i += 1;
      else if (NUM_PART.test(c)) i += 1;
      else break;
    }
    return { end: i, kind: 'word', text: source.slice(index, i) };
  }
  if (IDENT_START.test(ch)) {
    let i = index + 1;
    while (IDENT_PART.test(source[i] ?? '')) i += 1;
    return { end: i, kind: 'word', text: source.slice(index, i) };
  }
  if (OPERATORS.has(ch)) {
    let i = index;
    while (i < source.length && OPERATORS.has(source[i])) {
      // Stop before a comment marker or an operator that really starts a regex.
      if (i > index && source[i] === '/' && (source[i + 1] === '/' || source[i + 1] === '*'
        || canRegexAfter({ kind: 'punct', text: source.slice(index, i) }))) break;
      i += 1;
    }
    return { end: i, kind: 'punct', text: source.slice(index, i) };
  }
  return { end: index + 1, kind: 'punct', text: ch };
}

function updateState(state, token) {
  if (token.kind === 'ws' || token.kind === 'comment') return;
  if (token.text === '(') {
    state.paren.push(state.control);
    state.control = false;
  } else if (token.text === ')') {
    token.control = state.paren.pop() ?? false;
    state.control = false;
  } else if (token.kind === 'word') {
    state.control = CONTROL_KEYWORDS.has(token.text);
  } else {
    state.control = false;
  }
  state.last = { kind: token.kind, text: token.text, control: token.control };
}

// Safe by construction: every non-whitespace token is copied verbatim from the
// source, comments are dropped, and each whitespace run collapses to one space —
// or one line break when the original run had one, so ASI cannot change.
// A comment always leaves at least one separator, so two tokens never merge.
// Shortcut: the legacy Annex B `<!--` line comment is not recognized; such a
// file would fail `node --check` (loudly) instead of being minified.
export function minifyJs(source) {
  const text = String(source);
  const state = { last: null, control: false, paren: [] };
  let out = '';
  let pending = null;
  let i = 0;
  if (text.startsWith('#!')) {
    const end = text.indexOf('\n');
    if (end === -1) return text;
    out = `${text.slice(0, end)}\n`;
    i = end + 1;
  }
  while (i < text.length) {
    const token = nextToken(text, i, state.last);
    if (token.kind === 'ws') {
      pending = { newline: Boolean(pending?.newline) || LINEBREAK.test(token.text) };
    } else if (token.kind === 'comment') {
      // A block comment contributes a line break only if its own text has one.
      pending = { newline: Boolean(pending?.newline) || LINEBREAK.test(token.text) };
    } else {
      if (pending && out) out += pending.newline ? '\n' : ' ';
      pending = null;
      out += token.text;
      updateState(state, token);
    }
    i = token.end;
  }
  return out;
}

// ------------------------------------------------- unused generated assets

export function parseTargetsOutput(text) {
  const map = new Map();
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^(\S+)\s+(.+)$/.exec(line.trim());
    if (match) map.set(match[1], match[2].split(',').map((name) => name.trim()).filter(Boolean));
  }
  return map;
}

export function emitterArtifacts(opuromc, log = () => {}) {
  let result;
  try {
    result = run(opuromc, ['targets']);
  } catch (error) {
    log(`unused asset removal skipped: ${error.message}`);
    return null;
  }
  if (result.status !== 0) {
    log('unused asset removal skipped: opuromc targets failed');
    return null;
  }
  const map = parseTargetsOutput(`${result.stdout}${result.stderr}`);
  return map.size ? map : null;
}

// `full` emits into web/ and native/ subdirectories, so each emitter scope is
// checked against its own file list; chain outputs (server, shared, migrations,
// IR) live outside those scopes and are never candidates.
function removalScopes(out, target, artifacts) {
  if (target === 'full') {
    const web = artifacts.get('web');
    const native = artifacts.get('native');
    if (!web || !native) return null;
    return [
      { dir: path.join(out, 'web'), expected: new Set(web) },
      { dir: path.join(out, 'native'), expected: new Set(native) },
      // Root scope: nothing the chain writes is an emitter asset, so any
      // emitter-named file left at the root is stale output from an older build.
      { dir: out, expected: new Set(), atRoot: true },
    ];
  }
  const list = artifacts.get(target);
  return list ? [{ dir: out, expected: new Set(list) }] : null;
}

// Deletes only files whose path (relative to their scope) is a known emitter
// asset of SOME target and is not part of this build's emitted file set.
export function removeUnusedAssets({ out, target, artifacts, log = () => {} }) {
  const removed = [];
  if (!artifacts) return removed;
  const scopes = removalScopes(path.resolve(out), target, artifacts);
  if (!scopes) {
    log(`unused asset removal skipped: no emitter file list for ${target}`);
    return removed;
  }
  const union = new Set([...artifacts.values()].flat());
  const seen = new Set();
  for (const scope of scopes) {
    if (!fs.existsSync(scope.dir)) continue;
    for (const [name, bytes] of walkBytes(scope.dir, REMOVE_SKIP)) {
      if (scope.atRoot && name.includes('/')) continue;
      const key = `${scope.dir}:${name}`;
      if (seen.has(key) || !union.has(name) || scope.expected.has(name)) continue;
      if (PROTECTED_NAMES.has(name)) continue;
      seen.add(key);
      const file = path.join(scope.dir, ...name.split('/'));
      fs.rmSync(file, { force: true });
      const shown = path.relative(path.resolve(out), file).split(path.sep).join('/');
      removed.push({ name: shown, bytes });
      log(`removed unused asset: ${shown} (${bytes} B)`);
    }
  }
  removed.sort((a, b) => a.name.localeCompare(b.name));
  if (!removed.length) log('removed unused generated assets: (none)');
  return removed;
}

// -------------------------------------------------------- minify + manifest

function nodeCheck(file) {
  const result = run(process.execPath, ['--check', file]);
  if (result.status !== 0) {
    const detail = `${result.stderr}${result.stdout}`.trim().split(/\r?\n/).slice(-3).join('\n');
    throw new Error(`minified output failed node --check: ${file}\n${detail}`);
  }
}

export function minifyJsFiles(out, { target = null, artifacts = null } = {}) {
  const abs = path.resolve(out);
  // Only the emitter's own .js outputs are in scope; when the emitter's file
  // list is unavailable, fall back to every .js under the output directory.
  const allowed = artifacts ? expectedJsPaths(abs, target, artifacts) : null;
  const files = [...sizeBytes(abs)]
    .filter(([name]) => name.endsWith('.js'))
    .map(([name]) => name)
    .filter((name) => !allowed || allowed.has(name))
    .sort();
  for (const name of files) {
    const file = path.join(abs, ...name.split('/'));
    fs.writeFileSync(file, minifyJs(fs.readFileSync(file, 'utf8')));
    nodeCheck(file);
  }
  return files;
}

function expectedJsPaths(out, target, artifacts) {
  const scopes = removalScopes(out, target, artifacts) ?? [];
  const allowed = new Set();
  for (const scope of scopes) {
    for (const name of scope.expected) {
      if (!name.endsWith('.js')) continue;
      const rel = path.relative(out, path.join(scope.dir, ...name.split('/'))).split(path.sep).join('/');
      allowed.add(rel);
    }
  }
  return allowed;
}

function manifestFile(out) {
  return path.join(path.resolve(out), SIZE_MANIFEST);
}

function readManifest(out) {
  const file = manifestFile(out);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`corrupt size manifest: ${file} (${error.message}); run build --minify again`);
  }
  if (parsed?.version !== 1 || typeof parsed.target !== 'string' || !parsed.files || !Array.isArray(parsed.removed)) {
    throw new Error(`corrupt size manifest: ${file}; run build --minify again`);
  }
  return parsed;
}

function bytesCell(value) {
  return Number.isFinite(value) ? `${value} B` : 'n/a';
}

function pct(before, after) {
  if (!Number.isFinite(before) || before <= 0) return 'n/a';
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

// Pure: rows come from the two maps, which callers fill from real statSync sizes.
export function formatSizeReport({ dir, target, before, after, removed = [], jsFiles = [], note = null }) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const rows = names.map((name) => {
    const b = before.get(name);
    const a = after.has(name) ? after.get(name) : (b === undefined ? undefined : 0);
    return {
      file: name,
      before: bytesCell(b),
      after: bytesCell(a),
      reduction: b === undefined || b <= 0 ? 'n/a' : pct(b, a ?? 0),
    };
  });
  const beforeTotal = [...before.values()].reduce((sum, n) => sum + n, 0);
  const afterTotal = [...before.keys()].reduce((sum, name) => sum + (after.get(name) ?? 0), 0);
  rows.push({
    file: 'total',
    before: bytesCell(beforeTotal),
    after: bytesCell(afterTotal),
    reduction: pct(beforeTotal, afterTotal),
  });
  const table = [
    `| ${['file', 'before', 'after', 'reduction'].join(' | ')} |`,
    '| --- | --- | --- | --- |',
    ...rows.map((row) => `| ${row.file} | ${row.before} | ${row.after} | ${row.reduction} |`),
  ].join('\n');
  const removedText = removed.length
    ? removed.map((entry) => `${entry.name} (${entry.bytes} B)`).join(', ')
    : '(none)';
  const extra = [...after.keys()].filter((name) => !before.has(name)).sort();
  const extraText = extra.length
    ? `files created after baseline: ${extra.join(', ')}`
    : 'files created after baseline: (none)';
  return [
    'OPUROM size (measured with fs.statSync; excludes target/, data/, dotfiles)',
    `dir: ${path.resolve(dir)}`,
    `target: ${target}`,
    ...(note ? [`note: ${note}`] : []),
    table,
    `measured reduction: ${pct(beforeTotal, afterTotal)} (before ${beforeTotal} B -> after ${afterTotal} B)`,
    `removed unused generated assets: ${removedText}`,
    `minified js files: ${jsFiles.length ? jsFiles.join(', ') : '(none)'}`,
    extraText,
    'Scope: comment/whitespace minification only — no bundler, no source maps, no Brotli/zstd, no dependency graph analysis.',
  ].join('\n');
}

// Runs under `build --minify`: measure -> remove unused -> minify JS (+ node --check)
// -> persist the measured baseline -> measure again.
export function finalizeMinifiedBuild({ out, target, opuromc, log = () => {} }) {
  const abs = path.resolve(out);
  const before = sizeBytes(abs);
  const artifacts = emitterArtifacts(opuromc, log);
  const removed = removeUnusedAssets({ out: abs, target, artifacts, log });
  const jsFiles = minifyJsFiles(abs, { target, artifacts });
  const manifest = {
    version: 1,
    target,
    at: new Date().toISOString(),
    files: Object.fromEntries([...before].sort((a, b) => a[0].localeCompare(b[0]))),
    removed,
    jsFiles,
  };
  fs.writeFileSync(manifestFile(abs), `${JSON.stringify(manifest, null, 2)}\n`);
  const after = sizeBytes(abs);
  const report = formatSizeReport({ dir: abs, target, before, after, removed, jsFiles });
  return { before, after, removed, jsFiles, report };
}

// `opurom size <dir>`: re-reads the baseline and re-measures the tree.
export function sizeReport({ dir, log = console.log }) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) throw new Error(`no such directory: ${abs}`);
  const manifest = readManifest(abs);
  const after = sizeBytes(abs);
  const before = manifest ? new Map(Object.entries(manifest.files)) : new Map(after);
  const report = formatSizeReport({
    dir: abs, target: manifest?.target ?? 'unknown', before, after,
    removed: manifest?.removed ?? [], jsFiles: manifest?.jsFiles ?? [],
    note: manifest ? null : 'no --minify baseline in this directory; before = after (measured now, no reduction recorded)',
  });
  log(report);
  return report;
}
