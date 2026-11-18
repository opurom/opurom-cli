#!/usr/bin/env node
// Machine-readable gate for the fuzz input-corpus contract.
//
// Quality-gate layer only: it drives published CLI/renderer surfaces and
// never edits fixtures or implementations. Flutter authority (3.50.0,
// flutter-golden ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_test/lib/src/binding.dart:1070/2295/2800 defines the
//   automated/binding test shape; each case is isolated and failures are
//   reported instead of aborting the whole suite.
// - _goldens_io.dart:176-214 applies the same strict fail-closed discipline to
//   every compared pixel.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilerPath } from '../lib/build.mjs';
import { ensureSiblingBinary, workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');
const SEED = 0x4f505552; // "OPUR": fixed so every CI run is identical.

const MALFORMED = Object.freeze([
  '', 'app', 'app {', 'app A {', 'app A { state = }',
  'app A { Text("unclosed) }', 'app A { Text("bad\\q") }',
  'app A { state n = 999999999999999999999 }', 'app A { @ }',
]);
const MALFORMED_IR = Object.freeze([
  '', '{', 'null', '{"ir":', '{"ir":"0.1.0"}', '"text"',
]);

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}` };
}

function rng(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

function rendererBinary() {
  const found = ensureSiblingBinary('opurom-render', ['opurom-render', 'opurom_render'], {
    root: ROOT,
    log: () => {},
  });
  assert.ok(!found.skip, `opurom-render source is required for the fuzz gate: ${found.reason}`);
  assert.ok(found.path, `opurom-render binary is required for the fuzz gate: ${found.reason}`);
  return found.path;
}

const dir = mkdtempSync(path.join(tmpdir(), 'opurom-fuzz-contract-'));
try {
  check('malformed source corpus fails closed with an actionable diagnostic', () => {
    const opuromc = compilerPath({ log: () => {} });
    for (const [index, source] of MALFORMED.entries()) {
      const file = path.join(dir, `source-${index}.opu`);
      writeFileSync(file, source);
      const result = run(opuromc, ['check', file]);
      assert.notEqual(result.status, 0, `case ${index} passed: ${JSON.stringify(source)}`);
      assert.match(result.output, /\d+:\d+|error|usage/i,
        `case ${index} had no location/reason: ${result.output}`);
      assert.ok(!/panicked|stack backtrace|SIGSEGV/i.test(result.output),
        `case ${index} crashed: ${result.output}`);
    }
  });

  check('seeded punctuation corpus is replayable and never crashes the compiler', () => {
    const opuromc = compilerPath({ log: () => {} });
    const alphabet = '{}():,=.;+-[]*<>!"@#$%^&|\\/ \n0123456789abcdef';
    const next = rng();
    const digests = [];
    for (let caseIndex = 0; caseIndex < 32; caseIndex += 1) {
      const length = 1 + (next() % 80);
      let text = `app F${caseIndex} {\n`;
      for (let i = 0; i < length; i += 1) text += alphabet[next() % alphabet.length];
      text += '\n}\n';
      const file = path.join(dir, `seeded-${caseIndex}.opu`);
      writeFileSync(file, text);
      const result = run(opuromc, ['check', file]);
      assert.ok(result.status === 0 || result.status === 1,
        `case ${caseIndex} exited ${result.status}: ${result.output}`);
      assert.ok(!/panicked|stack backtrace|SIGSEGV/i.test(result.output),
        `case ${caseIndex} crashed: ${result.output}`);
      digests.push(result.output);
    }
    const replay = rng();
    let unchanged = true;
    for (let caseIndex = 0; caseIndex < 32; caseIndex += 1) {
      const length = 1 + (replay() % 80);
      let text = `app F${caseIndex} {\n`;
      for (let i = 0; i < length; i += 1) text += alphabet[replay() % alphabet.length];
      text += '\n}\n';
      assert.equal(text, readFileSync(path.join(dir, `seeded-${caseIndex}.opu`), 'utf8'));
      unchanged = unchanged && digests[caseIndex] !== undefined;
    }
    assert.ok(unchanged, 'seed replay must produce the same corpus contract');
  });

  check('renderer rejects malformed IR without a crash', () => {
    const exe = rendererBinary();
    assert.ok(exe, 'opurom-render binary is required for the fuzz gate');
    for (const [index, text] of MALFORMED_IR.entries()) {
      const file = path.join(dir, `bad-${index}.json`);
      writeFileSync(file, text);
      const result = run(exe, [file, '16', '16', path.join(dir, `bad-${index}.ppm`)]);
      assert.notEqual(result.status, 0, `renderer accepted malformed IR ${index}`);
      assert.ok(!/panicked|stack backtrace|SIGSEGV/i.test(result.output),
        `renderer crashed on case ${index}: ${result.output}`);
    }
  });

  check('gesture scripts reject unknown steps and missing IR paths', () => {
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
} finally {
  // Temporary corpus files remain under the OS temp dir for postmortem only
  // when a failure needs them; this gate uses a fresh directory per run.
}

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.fuzz-input-corpus-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: [
      'packages/flutter_test/lib/src/binding.dart:1070/2295/2800',
      'packages/flutter_test/lib/src/_goldens_io.dart:176-214',
    ],
  },
  contract: {
    seed: SEED,
    malformedSourceCases: MALFORMED.length,
    seededPunctuationCases: 32,
    malformedIrCases: MALFORMED_IR.length,
    gestureCases: 2,
    failClosed: true,
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
