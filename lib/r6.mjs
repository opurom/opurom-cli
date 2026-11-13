import fs from 'node:fs';
import path from 'node:path';
import { run } from './proc.mjs';

// R6: lexical JS tokenizer, safe minification and measured size reporting.
// R10 adds opt-in reachability and segment-level maps; no bundler, no third-party
// dependency graph, no Brotli/zstd, no scope-hoisting.

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

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function positionAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: index - starts[lo] };
}

function interpolationEnd(text, start, limit) {
  const state = { last: null, control: false, paren: [] };
  let depth = 1;
  let i = start;
  while (i < limit) {
    const token = nextToken(text, i, state.last);
    const end = Math.min(token.end, limit);
    const bounded = { ...token, end, text: token.text.slice(0, end - i) };
    updateState(state, bounded);
    if (bounded.kind === 'punct') {
      if (bounded.text === '{') depth += 1;
      else if (bounded.text === '}') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    i = token.end;
  }
  return limit;
}

function templateRanges(text, start, end) {
  const ranges = [];
  let i = start + 1;
  while (i < end - 1) {
    const ch = text[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      const nestedEnd = scanTemplate(text, i);
      if (nestedEnd > i) {
        ranges.push(...templateRanges(text, i, nestedEnd));
        i = nestedEnd;
        continue;
      }
    }
    if (ch === '$' && text[i + 1] === '{') {
      const exprStart = i + 2;
      const exprEnd = interpolationEnd(text, exprStart, end);
      ranges.push([exprStart, exprEnd]);
      i = exprEnd + 1;
    } else i += 1;
  }
  return ranges;
}

// Same lexical states as minifyJs, with source offsets for R10 analysis/maps.
// Template interpolations are tokenized too; their outer literal stays opaque.
export function tokenizeJs(source) {
  const text = String(source);
  const starts = lineStarts(text);
  const tokens = [];
  const addRange = (from, to) => {
    const state = { last: null, control: false, paren: [] };
    let i = from;
    while (i < to) {
      const token = nextToken(text, i, state.last);
      const end = Math.min(token.end, to);
      const bounded = { ...token, start: i, end, text: token.text.slice(0, end - i) };
      tokens.push({ ...bounded, ...positionAt(starts, i) });
      if (token.kind === 'template' && token.end <= to) {
        for (const [begin, finish] of templateRanges(text, i, token.end)) {
          if (finish > begin) addRange(begin, finish);
        }
      }
      updateState(state, bounded);
      i = token.end;
    }
  };
  addRange(0, text.length);
  // Outer literals sort before their interpolation tokens at the same offset.
  return tokens.sort((a, b) => a.start - b.start || b.end - a.end);
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
    throw new Error(`generated output failed node --check: ${file}\n${detail}`);
  }
}

// Only the emitter's own .js outputs are in scope; without its file list,
// fall back to every .js under the output directory.
export function emitterJsFiles(out, { target = null, artifacts = null } = {}) {
  const abs = path.resolve(out);
  const allowed = artifacts ? expectedJsPaths(abs, target, artifacts) : null;
  return [...sizeBytes(abs)]
    .filter(([name]) => name.endsWith('.js'))
    .map(([name]) => name)
    .filter((name) => !allowed || allowed.has(name))
    .sort();
}

export function minifyJsFiles(out, { target = null, artifacts = null } = {}) {
  const abs = path.resolve(out);
  const files = emitterJsFiles(abs, { target, artifacts });
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
export function formatSizeReport({
  dir, target, before, after, removed = [], jsFiles = [], note = null, flags = null,
  removedFunctions = null, sourceMaps = null, treeShakeTable = null, scope = null,
  jsLabel = 'minified js files',
}) {
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
  const afterTotal = [...after.values()].reduce((sum, n) => sum + n, 0);
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
  const lines = [
    'OPUROM size (measured with fs.statSync; excludes target/, data/, dotfiles)',
    `dir: ${path.resolve(dir)}`,
    `target: ${target}`,
    ...(note ? [`note: ${note}`] : []),
    table,
    `measured reduction: ${pct(beforeTotal, afterTotal)} (before ${beforeTotal} B -> after ${afterTotal} B)`,
    `removed unused generated assets: ${removedText}`,
    `${jsLabel}: ${jsFiles.length ? jsFiles.join(', ') : '(none)'}`,
    extraText,
  ];
  if (flags?.treeShake) {
    const functionText = removedFunctions?.length
      ? removedFunctions.map((entry) => `${entry.file}: ${entry.name} (${entry.bytes} B)`).join(', ')
      : '(none)';
    lines.push(`tree shake removed functions: ${functionText}`);
    lines.push(`tree shake removed generated assets: ${removedText}`);
    if (treeShakeTable) lines.push(treeShakeTable);
  }
  if (flags?.sourcemap) {
    const mapText = sourceMaps?.length
      ? sourceMaps.map((entry) => `${entry.file} -> ${entry.map} (${entry.bytes} B)`).join(', ')
      : '(none)';
    lines.push(`source maps: ${mapText}`);
    lines.push('source map accuracy: generated line starts to original token positions; not line-exact or column-exact.');
  }
  lines.push(scope ?? 'Scope: comment/whitespace minification only — no bundler, no source maps, no Brotli/zstd, no dependency graph analysis.');
  return lines.join('\n');
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

function stripSourceMapComment(source) {
  return String(source).split('\n')
    .filter((line) => !/^\/\/#\s*sourceMappingURL=/.test(line.trim()))
    .join('\n');
}

function appendSourceMapComment(source, mapName) {
  return `${stripSourceMapComment(source).trimEnd()}\n//# sourceMappingURL=${mapName}\n`;
}

function r10Scope({ minify, treeShake, sourcemap }) {
  const work = [];
  if (treeShake) work.push('top-level function reachability over emitter JS');
  if (minify) work.push('comment/whitespace minification');
  if (sourcemap) work.push('segment-level line-start source maps (not line-exact/column-exact)');
  return `Scope: ${work.join(' + ')} — no bundler, no third-party dependency graph, no Brotli/zstd, no scope-hoisting. R11+: faithful column mappings, full dependency graphs and bundling.`;
}

// R10 pipeline: statSync baseline -> emitter asset removal -> reachability ->
// optional minification -> optional v3 maps -> statSync after + manifest.
export function finalizeBuild({
  out, target, opuromc, log = () => {}, minify = false, treeShake = false,
  sourcemap = false, transforms = null,
}) {
  if (treeShake && (!transforms?.treeShakeJs || !transforms?.formatTreeShakeTable)) {
    throw new Error('tree shaking requires the R10 analysis transforms');
  }
  if (sourcemap && !transforms?.buildSourceMap) {
    throw new Error('source maps require the R10 map transform');
  }
  const abs = path.resolve(out);
  const before = sizeBytes(abs);
  const artifacts = emitterArtifacts(opuromc, log);
  const removed = (minify || treeShake)
    ? removeUnusedAssets({ out: abs, target, artifacts, log })
    : [];
  const jsFiles = emitterJsFiles(abs, { target, artifacts });
  const originalSources = new Map();
  const removedFunctions = [];
  const sourceMaps = [];
  const treeShakeBefore = new Map();
  const treeShakeAfter = new Map();

  for (const name of jsFiles) {
    const file = path.join(abs, ...name.split('/'));
    const raw = fs.readFileSync(file, 'utf8');
    const original = stripSourceMapComment(raw);
    if (original !== raw) fs.writeFileSync(file, original);
    if (sourcemap) originalSources.set(name, original);
    let source = original;

    if (treeShake) {
      treeShakeBefore.set(name, fs.statSync(file).size);
      const shake = transforms.treeShakeJs(source, name);
      fs.writeFileSync(file, shake.code);
      nodeCheck(file);
      treeShakeAfter.set(name, fs.statSync(file).size);
      removedFunctions.push(...shake.removed);
      for (const entry of shake.removed) log(`tree shake: removed ${entry.file}: ${entry.name} (${entry.bytes} B)`);
      source = fs.readFileSync(file, 'utf8');
    }
    if (minify) {
      fs.writeFileSync(file, minifyJs(source));
      nodeCheck(file);
      source = fs.readFileSync(file, 'utf8');
    }
    if (sourcemap) {
      const generated = stripSourceMapComment(fs.readFileSync(file, 'utf8'));
      const mapName = `${path.basename(name)}.map`;
      const mapRel = name.includes('/') ? `${path.posix.dirname(name)}/${mapName}` : mapName;
      const mapFile = path.join(abs, ...mapRel.split('/'));
      const map = transforms.buildSourceMap({
        file: path.basename(name), sourceName: path.basename(name),
        source: originalSources.get(name), generated,
      });
      fs.writeFileSync(mapFile, `${JSON.stringify(map, null, 2)}\n`);
      fs.writeFileSync(file, appendSourceMapComment(generated, mapName));
      nodeCheck(file);
      const bytes = fs.statSync(mapFile).size;
      sourceMaps.push({ file: name, map: mapRel, bytes });
      log(`source map: ${mapRel} (${bytes} B)`);
    }
  }

  const flags = { minify, treeShake, sourcemap };
  const treeShakeTable = treeShake
    ? transforms.formatTreeShakeTable({ before: treeShakeBefore, after: treeShakeAfter })
    : null;
  const scope = r10Scope(flags);
  const note = sourcemap
    ? 'source maps map generated line starts to original token positions; not line-exact or column-exact.'
    : null;
  const jsLabel = minify ? 'minified js files' : 'processed js files';
  const manifest = {
    version: 1,
    target,
    at: new Date().toISOString(),
    files: Object.fromEntries([...before].sort((a, b) => a[0].localeCompare(b[0]))),
    removed,
    jsFiles,
    flags,
    removedFunctions,
    sourceMaps,
    treeShakeBefore: Object.fromEntries(treeShakeBefore),
    treeShakeAfter: Object.fromEntries(treeShakeAfter),
    treeShakeTable,
    scope,
    note,
    jsLabel,
  };
  fs.writeFileSync(manifestFile(abs), `${JSON.stringify(manifest, null, 2)}\n`);
  const after = sizeBytes(abs);
  const report = formatSizeReport({
    dir: abs, target, before, after, removed, jsFiles, note, flags,
    removedFunctions, sourceMaps, treeShakeTable, scope, jsLabel,
  });
  return {
    before, after, removed, jsFiles, flags, removedFunctions, sourceMaps,
    treeShakeBefore, treeShakeAfter, treeShakeTable, report,
  };
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
    note: manifest ? (manifest.note ?? null) : 'no --minify baseline in this directory; before = after (measured now, no reduction recorded)',
    flags: manifest?.flags ?? null,
    removedFunctions: manifest?.removedFunctions ?? null,
    sourceMaps: manifest?.sourceMaps ?? null,
    treeShakeTable: manifest?.treeShakeTable ?? null,
    scope: manifest?.scope ?? null,
    jsLabel: manifest?.jsLabel ?? (manifest?.flags?.minify === false ? 'processed js files' : 'minified js files'),
  });
  log(report);
  return report;
}
