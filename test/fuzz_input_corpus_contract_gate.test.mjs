// Tests for the machine-readable fuzz input-corpus contract gate.
// Flutter authority: 3.50.0 / ab2912035e,
// packages/flutter_test/lib/src/binding.dart:1070/2295/2800 and
// packages/flutter_test/lib/src/_goldens_io.dart:176-214.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'fuzz-input-corpus-contract.mjs');

function runGate(cwd = ROOT) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  assert.equal(run.error, undefined);
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch (error) {
    assert.fail(`gate stdout is not JSON: ${run.stdout}\n${run.stderr}\n${error.message}`);
  }
  return { status: run.status, json };
}

test('the fuzz input-corpus gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.fuzz-input-corpus-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.contract.seed, 0x4f505552);
  assert.equal(run.json.contract.failClosed, true);
  assert.equal(run.json.summary.total, 4);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the fuzz gate fails closed when the replay seed drifts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-fuzz-gate-'));
  try {
    const gate = path.join(dir, 'fuzz-input-corpus-contract.mjs');
    const original = readFileSync(GATE, 'utf8')
      .replace("from '../lib/build.mjs'", `from ${JSON.stringify(path.join(ROOT, 'lib', 'build.mjs'))}`)
      .replace("from '../lib/paths.mjs'", `from ${JSON.stringify(path.join(ROOT, 'lib', 'paths.mjs'))}`);
    writeFileSync(gate, original.replace('const replay = rng();', 'const replay = rng(SEED + 1);'));
    const run = spawnSync(process.execPath, [gate], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL' && /seeded/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
