// Tests for the machine-readable test-scheduling contract gate.
// Flutter authority: 3.50.0 / ab2912035e,
// packages/flutter_test/lib/src/binding.dart:1326-1329/2345-2347/1070/2295.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'test-scheduling-contract.mjs');

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

test('the scheduling contract gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.test-scheduling-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.deepEqual(run.json.flutter.authority, [
    'packages/flutter_test/lib/src/binding.dart:1326-1329',
    'packages/flutter_test/lib/src/binding.dart:2345-2347',
    'packages/flutter_test/lib/src/binding.dart:1070/2295',
  ]);
  assert.equal(run.json.contract.automatedTimeoutMs, 600000);
  assert.equal(run.json.summary.total, 3);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the scheduling gate fails closed when the harness timeout bound is removed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schedule-gate-'));
  try {
    const lib = path.join(dir, 'lib');
    const bin = path.join(dir, 'bin');
    const testDir = path.join(dir, 'test');
    mkdirSync(lib, { recursive: true });
    mkdirSync(bin, { recursive: true });
    mkdirSync(testDir, { recursive: true });
    const source = readFileSync(path.join(ROOT, 'test', 'test_scheduling_gate.test.mjs'), 'utf8');
    writeFileSync(path.join(testDir, 'test_scheduling_gate.test.mjs'),
      source.replace('timeout: 10 * 60 * 1000', 'timeout: 1000'));
    writeFileSync(path.join(bin, 'test-scheduling-contract.mjs'),
      readFileSync(GATE, 'utf8'));
    const run = spawnSync(process.execPath, [path.join(bin, 'test-scheduling-contract.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL'
      && /10-minute bound/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
