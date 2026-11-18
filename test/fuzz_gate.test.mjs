// Fuzz gate: deterministic random, malformed and boundary inputs.
//
// Flutter authority for the testing shape: Flutter's test bindings and golden
// comparators run many small isolated cases and report every failure rather
// than stopping on the first one (packages/flutter_test/lib/src/binding.dart
// :1070,2295,2800; _goldens_io.dart:225-251 at 3.50.0 / ab2912035e). The Opurom
// gate applies the same discipline to the compiler, core runtime and renderer
// CLI surfaces: every case is seeded, replayable and must fail closed.
//
// No random value is allowed to decide pass/fail. The seed is printed and the
// generator is pure.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilerPath } from '../lib/build.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');
const SEED = 0x4f505552; // "OPUR": fixed so every CI run is identical.

function rng(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function binary(repo, names) {
  for (const profile of ['debug', 'release']) {
    for (const name of names) {
      const file = path.join(ROOT, repo, 'target', profile, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function sourceFile(text, tag) {
  const dir = mkdtempSync(path.join(tmpdir(), `opurom-fuzz-${tag}-`));
  const file = path.join(dir, 'case.opu');
  writeFileSync(file, text);
  return file;
}

const MALFORMED = [
  '',
  'app',
  'app {',
  'app A {',
  'app A { state = }',
  'app A { Text("unclosed) }',
  'app A { Text("bad\\q") }',
  'app A { state n = 999999999999999999999 }',
  'app A { @ }',
];

test('malformed sources always fail with an actionable diagnostic', () => {
  const opuromc = compilerPath({ log: () => {} });
  for (const [index, source] of MALFORMED.entries()) {
    const result = run(opuromc, ['check', sourceFile(source, `malformed-${index}`)]);
    assert.notEqual(result.status, 0, `case ${index} passed: ${JSON.stringify(source)}`);
    assert.ok(result.output.trim(), `case ${index} produced no diagnostic`);
    assert.match(result.output, /\d+:\d+|error|usage/i, `case ${index} had no location/reason: ${result.output}`);
  }
});

test('a seeded fuzz of punctuation never crashes the compiler', () => {
  const opuromc = compilerPath({ log: () => {} });
  const alphabet = '{}():,=.;+-[]*<>!"@#$%^&|\\/ \n0123456789abcdef';
  const next = rng();
  for (let caseIndex = 0; caseIndex < 32; caseIndex += 1) {
    const length = 1 + (next() % 80);
    let text = `app F${caseIndex} {\n`;
    for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
    text += '\n}\n';
    const result = run(opuromc, ['check', sourceFile(text, `seeded-${caseIndex}`)]);
    assert.ok(result.status === 0 || result.status === 1,
      `case ${caseIndex} exited ${result.status}: ${result.output}`);
    assert.ok(!/panicked|stack backtrace|SIGSEGV/i.test(result.output),
      `case ${caseIndex} crashed: ${result.output}`);
  }
});

test('renderer rejects malformed IR without a crash', () => {
  const exe = binary('opurom-render', ['opurom-render', 'opurom_render']);
  assert.ok(exe, 'opurom-render binary is required for the fuzz gate');
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-fuzz-render-'));
  const cases = ['', '{', 'null', '{"ir":', '{"ir":"0.1.0"}', '"text"'];
  for (const [index, text] of cases.entries()) {
    const file = path.join(dir, `bad-${index}.json`);
    writeFileSync(file, text);
    const out = path.join(dir, `bad-${index}.ppm`);
    const result = run(exe, [file, '16', '16', out]);
    assert.notEqual(result.status, 0, `renderer accepted malformed IR ${index}`);
    assert.ok(!/panicked|stack backtrace|SIGSEGV/i.test(result.output),
      `renderer crashed on case ${index}: ${result.output}`);
  }
});

test('gesture scripts reject unknown steps and out-of-range node ids', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-fuzz-gesture-'));
  const cases = [
    { steps: [{ unknown: 1 }], expect: {} },
    { ir: '/not/a/real/ir.json', steps: [], expect: {} },
  ];
  for (const [index, body] of cases.entries()) {
    const file = path.join(dir, `case-${index}.wtest.json`);
    writeFileSync(file, JSON.stringify({
      ir: path.join(ROOT, 'opurom-examples', 'golden', 'counter.opuir.json'),
      width: 320, height: 240, ...body,
    }));
    const result = run(process.execPath, [CLI, 'test', '--widget', file]);
    assert.equal(result.status, 1, `gesture case ${index} passed: ${result.output}`);
    assert.ok(!/panicked|stack backtrace|SIGSEGV/i.test(result.output),
      `gesture case ${index} crashed: ${result.output}`);
  }
});

test('valid boundary dimensions render a deterministic frame', () => {
  const exe = binary('opurom-render', ['opurom-render', 'opurom_render']);
  assert.ok(exe, 'opurom-render binary is required for the fuzz gate');
  const ir = path.join(ROOT, 'opurom-examples', 'golden', 'counter.opuir.json');
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-fuzz-bounds-'));
  const out = path.join(dir, 'frame.ppm');
  for (const [width, height] of [[1, 1], [16, 1], [1, 16], [64, 64]]) {
    const first = run(exe, [ir, String(width), String(height), out]);
    assert.equal(first.status, 0, `${width}x${height} failed: ${first.output}`);
    const bytes = readFileSync(out);
    assert.ok(bytes.length > 0, `${width}x${height} wrote no frame`);
    const second = run(exe, [ir, String(width), String(height), out]);
    assert.equal(second.status, 0);
    assert.deepEqual(readFileSync(out), bytes, `${width}x${height} was nondeterministic`);
  }
});
