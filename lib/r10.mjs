import { tokenizeJs } from './r6.mjs';

// R10: reachability over the emitter's own JS and honest segment-level maps.
// No bundler, no third-party dependency graph, no scope-hoisting.

const IDENT_START = /[A-Za-z_$\u0080-\uFFFF]/;
const KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'in',
  'instanceof', 'let', 'new', 'of', 'return', 'static', 'super', 'switch', 'this', 'throw', 'try',
  'typeof', 'undefined', 'var', 'void', 'while', 'with', 'yield', 'true', 'false', 'null',
]);
const DECLARATION_WORDS = new Set(['const', 'let', 'var', 'class']);
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function isWord(token) {
  return token?.kind === 'word';
}

function isPunct(token, text) {
  return token?.kind === 'punct' && token.text === text;
}

function isIdentifier(token) {
  return isWord(token) && IDENT_START.test(token.text) && !KEYWORDS.has(token.text);
}

function significant(source) {
  return tokenizeJs(String(source)).filter((token) => token.kind !== 'ws' && token.kind !== 'comment');
}

function matchParen(tokens, start) {
  let depth = 0;
  for (let i = start; i < tokens.length; i += 1) {
    if (isPunct(tokens[i], '(')) depth += 1;
    else if (isPunct(tokens[i], ')')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length;
}

function matchParenBackwards(tokens, start) {
  let depth = 0;
  for (let i = start; i >= 0; i -= 1) {
    if (isPunct(tokens[i], ')')) depth += 1;
    else if (isPunct(tokens[i], '(')) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// Conservative bindings: shadowed names never mark a top-level function as used.
function collectBindings(tokens) {
  const bindings = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (isWord(token) && DECLARATION_WORDS.has(token.text) && isIdentifier(tokens[i + 1])) {
      bindings.add(tokens[i + 1].text);
    }
    if (isWord(token) && token.text === 'function') {
      let j = i + 1;
      if (isPunct(tokens[j], '*')) j += 1;
      if (isIdentifier(tokens[j])) bindings.add(tokens[j].text);
      let open = j;
      while (open < tokens.length && !isPunct(tokens[open], '(') && !isPunct(tokens[open], ';')) open += 1;
      if (isPunct(tokens[open], '(')) {
        const close = matchParen(tokens, open);
        for (let p = open + 1; p < close; p += 1) if (isIdentifier(tokens[p])) bindings.add(tokens[p].text);
      }
    }
    if (isWord(token) && token.text === 'catch' && isPunct(tokens[i + 1], '(') && isIdentifier(tokens[i + 2])) {
      bindings.add(tokens[i + 2].text);
    }
    // The tokenizer emits `=>` as `=` then `>`; collect simple arrow parameters.
    if (isPunct(token, '=') && isPunct(tokens[i + 1], '>')) {
      if (isIdentifier(tokens[i - 1])) bindings.add(tokens[i - 1].text);
      else if (isPunct(tokens[i - 1], ')')) {
        const open = matchParenBackwards(tokens, i - 1);
        for (let p = open + 1; p < i - 1; p += 1) if (isIdentifier(tokens[p])) bindings.add(tokens[p].text);
      }
    }
  }
  return bindings;
}

function referencesIn(tokens, bindings = new Set()) {
  const refs = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!isIdentifier(token) || bindings.has(token.text)) continue;
    const previous = tokens[i - 1];
    const next = tokens[i + 1];
    if (isPunct(previous, '.')) continue;
    if (isPunct(next, ':')) continue;
    if (isWord(previous) && (DECLARATION_WORDS.has(previous.text) || previous.text === 'function')) continue;
    if (isPunct(previous, '*') && isWord(tokens[i - 2]) && tokens[i - 2].text === 'function') continue;
    refs.add(token.text);
  }
  return refs;
}

function readDeclaration(tokens, index) {
  const first = tokens[index];
  const asyncStart = isWord(first) && first.text === 'async'
    && isWord(tokens[index + 1]) && tokens[index + 1].text === 'function';
  const functionIndex = asyncStart ? index + 1 : index;
  const functionToken = tokens[functionIndex];
  if (!isWord(functionToken) || functionToken.text !== 'function') return null;
  const previous = tokens[index - 1];
  if (previous && !isPunct(previous, ';') && !isPunct(previous, '{') && !isPunct(previous, '}')) return null;

  let j = functionIndex + 1;
  if (isPunct(tokens[j], '*')) j += 1;
  const name = tokens[j];
  if (!isIdentifier(name)) return null;
  j += 1;
  if (!isPunct(tokens[j], '(')) return null;
  const paramsStart = j + 1;
  const paramsEnd = matchParen(tokens, j);
  if (paramsEnd >= tokens.length) return null;
  j = paramsEnd + 1;
  while (j < tokens.length && !isPunct(tokens[j], '{') && !isPunct(tokens[j], ';')) j += 1;
  if (!isPunct(tokens[j], '{')) return null;

  const bodyStart = j;
  let depth = 0;
  let k = bodyStart;
  for (; k < tokens.length; k += 1) {
    if (isPunct(tokens[k], '{')) depth += 1;
    else if (isPunct(tokens[k], '}')) {
      depth -= 1;
      if (depth === 0) { k += 1; break; }
    }
  }
  if (depth !== 0) return null;
  const bodyTokens = tokens.slice(bodyStart + 1, k - 1);
  const bindings = collectBindings(tokens.slice(bodyStart, k));
  for (const token of tokens.slice(paramsStart, paramsEnd)) if (isIdentifier(token)) bindings.add(token.text);
  return {
    name: name.text,
    start: first.start,
    end: tokens[k - 1].end,
    sigStart: index,
    sigEnd: k,
    bodyTokens,
    bindings,
  };
}

function collectDeclarations(tokens) {
  const declarations = [];
  const rootTokens = [];
  let depth = 0;
  for (let i = 0; i < tokens.length;) {
    if (depth === 0) {
      const declaration = readDeclaration(tokens, i);
      if (declaration) {
        declarations.push(declaration);
        i = declaration.sigEnd;
        continue;
      }
    }
    const token = tokens[i];
    rootTokens.push(token);
    if (isPunct(token, '{')) depth += 1;
    else if (isPunct(token, '}')) depth = Math.max(0, depth - 1);
    i += 1;
  }
  return { declarations, rootTokens };
}

function removeDeclarations(source, removals) {
  let code = source;
  for (const declaration of [...removals].sort((a, b) => b.start - a.start)) {
    code = code.slice(0, declaration.start) + code.slice(declaration.end);
  }
  return code;
}

export function analyzeReachability(source) {
  const text = String(source);
  const tokens = significant(text);
  const { declarations, rootTokens } = collectDeclarations(tokens);
  const counts = new Map();
  for (const declaration of declarations) counts.set(declaration.name, (counts.get(declaration.name) ?? 0) + 1);
  const duplicates = new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  const rootBindings = collectBindings(rootTokens);
  const rootReferences = referencesIn(rootTokens, rootBindings);
  const byName = new Map();
  for (const declaration of declarations) {
    if (!byName.has(declaration.name)) byName.set(declaration.name, []);
    byName.get(declaration.name).push(declaration);
    const bindings = new Set([...rootBindings, ...declaration.bindings]);
    declaration.bodyReferences = referencesIn(declaration.bodyTokens, bindings);
  }
  const reachable = new Set([...rootReferences].filter((name) => byName.has(name)));
  const queue = [...reachable];
  while (queue.length) {
    const name = queue.shift();
    for (const declaration of byName.get(name) ?? []) {
      for (const reference of declaration.bodyReferences) {
        if (byName.has(reference) && !reachable.has(reference)) {
          reachable.add(reference);
          queue.push(reference);
        }
      }
    }
  }
  const removed = declarations.filter((declaration) => !reachable.has(declaration.name) && !duplicates.has(declaration.name));
  return {
    declarations, duplicates, rootReferences, reachable, removed,
    code: removeDeclarations(text, removed),
  };
}

export function treeShakeJs(source, file = 'app.js') {
  const text = String(source);
  const analysis = analyzeReachability(text);
  const removed = analysis.removed.map((declaration) => ({
    file,
    name: declaration.name,
    bytes: Buffer.byteLength(text.slice(declaration.start, declaration.end), 'utf8'),
  }));
  return { code: analysis.code, removed, analysis };
}

function encodeVlq(value) {
  let number = value < 0 ? (-value) * 2 + 1 : value * 2;
  let encoded = '';
  do {
    let digit = number % 32;
    number = Math.floor(number / 32);
    if (number > 0) digit += 32;
    encoded += BASE64[digit];
  } while (number > 0);
  return encoded;
}

function mapSegments({ sourceTokens, generatedTokens, generated }) {
  const lineCount = String(generated).split(/\r?\n/).length;
  const segments = Array.from({ length: lineCount }, () => null);
  let sourceIndex = 0;
  let lastMatch = { line: 0, column: 0 };
  for (const token of generatedTokens) {
    if (token.line >= segments.length) continue;
    while (sourceIndex < sourceTokens.length && sourceTokens[sourceIndex].text !== token.text) sourceIndex += 1;
    if (sourceIndex < sourceTokens.length) {
      lastMatch = sourceTokens[sourceIndex];
      sourceIndex += 1;
    }
    if (!segments[token.line]) {
      segments[token.line] = {
        originalLine: lastMatch.line,
        originalColumn: lastMatch.column,
        name: isIdentifier(token) ? token.text : null,
      };
    }
  }
  if (!segments[0]) segments[0] = { originalLine: 0, originalColumn: 0, name: null };

  const names = [];
  const nameIndexes = new Map();
  const lines = [];
  let lastSource = 0;
  let lastOriginalLine = 0;
  let lastOriginalColumn = 0;
  let lastName = 0;
  for (const segment of segments) {
    if (!segment) { lines.push(''); continue; }
    const fields = [
      0,
      0 - lastSource,
      segment.originalLine - lastOriginalLine,
      segment.originalColumn - lastOriginalColumn,
    ];
    if (segment.name) {
      if (!nameIndexes.has(segment.name)) {
        nameIndexes.set(segment.name, names.length);
        names.push(segment.name);
      }
      const index = nameIndexes.get(segment.name);
      fields.push(index - lastName);
      lastName = index;
    }
    lines.push(fields.map(encodeVlq).join(''));
    lastSource = 0;
    lastOriginalLine = segment.originalLine;
    lastOriginalColumn = segment.originalColumn;
  }
  return { names, mappings: lines.join(';') };
}

// Source Map v3 with generated LINE-START segments only. Columns > 0 in the
// generated file are deliberately unmapped: this is not a line-exact/column-exact map.
export function buildSourceMap({ file, source, generated, sourceName = file }) {
  const sourceText = String(source ?? '');
  const generatedText = String(generated ?? '');
  const generatedName = String(file).split(/[\\/]/).pop();
  const { names, mappings } = mapSegments({
    sourceTokens: significant(sourceText),
    generatedTokens: significant(generatedText),
    generated: generatedText,
  });
  return {
    version: 3,
    file: generatedName,
    sources: [sourceName ?? generatedName],
    sourcesContent: [sourceText],
    names,
    mappings,
    x_opurom_accuracy: 'Generated line starts to original token positions; not line-exact or column-exact; generated columns > 0 are unmapped.',
    x_opurom_source: 'Emitter JS before tree shaking/minification; sourcesContent is that original text.',
  };
}

function bytesCell(value) {
  return Number.isFinite(value) ? `${value} B` : 'n/a';
}

function pct(before, after) {
  if (!Number.isFinite(before) || before <= 0) return 'n/a';
  return `${(((before - after) / before) * 100).toFixed(1)}%`;
}

export function formatTreeShakeTable({ before, after }) {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const rows = names.map((name) => {
    const b = before.get(name);
    const a = after.get(name) ?? (b === undefined ? undefined : 0);
    return `| ${name} | ${bytesCell(b)} | ${bytesCell(a)} | ${b === undefined || b <= 0 ? 'n/a' : pct(b, a ?? 0)} |`;
  });
  const beforeTotal = [...before.values()].reduce((sum, n) => sum + n, 0);
  const afterTotal = [...after.values()].reduce((sum, n) => sum + n, 0);
  return [
    'OPUROM tree shake (measured with fs.statSync; generated JS only)',
    '| file | before | after | reduction |',
    '| --- | --- | --- | --- |',
    ...rows,
    `| total | ${bytesCell(beforeTotal)} | ${bytesCell(afterTotal)} | ${pct(beforeTotal, afterTotal)} |`,
    `measured tree-shake reduction: ${pct(beforeTotal, afterTotal)} (before ${beforeTotal} B -> after ${afterTotal} B)`,
    'Accuracy: top-level function declarations only; no bundler, no third-party dependency graph, no scope-hoisting.',
  ].join('\n');
}

export const R10_TRANSFORMS = Object.freeze({ treeShakeJs, buildSourceMap, formatTreeShakeTable });
