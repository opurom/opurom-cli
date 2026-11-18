// Tests for the machine-readable cross-target artifact contract gate.
// Flutter 3.50.0 / ab2912035e parity authority:
// opurom-spec/FLUTTER_PARITY_MASTER.md:28-33 and lib/targets.mjs:5-16.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'cross-target-artifact-contract.mjs');

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

test('the cross-target artifact gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.cross-target-artifact-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.contract.singleSourceOfTruth, true);
  assert.deepEqual(run.json.contract.targets, [
    'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
    'wasm', 'harmony',
  ]);
  assert.equal(run.json.summary.total, 5);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the cross-target gate fails closed when a declared target is removed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-cross-gate-'));
  try {
    const lib = path.join(dir, 'lib');
    const bin = path.join(dir, 'bin');
    const golden = path.join(path.dirname(dir), 'opurom-examples', 'golden');
    mkdirSync(golden, { recursive: true });
    writeFileSync(path.join(golden, 'counter.opu'),
      readFileSync(path.join(ROOT, '..', 'opurom-examples', 'golden', 'counter.opu'), 'utf8'));
    mkdirSync(lib, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const original = readFileSync(path.join(ROOT, 'lib', 'targets.mjs'), 'utf8');
    writeFileSync(path.join(lib, 'targets.mjs'), original.replace("'harmony',", "'harmony-x',"));
    // paths.mjs is imported by the gate; use its real dependency closure.
    for (const file of ['paths.mjs', 'proc.mjs']) {
      writeFileSync(path.join(lib, file), readFileSync(path.join(ROOT, 'lib', file), 'utf8'));
    }
    writeFileSync(path.join(bin, 'cross-target-artifact-contract.mjs'),
      readFileSync(GATE, 'utf8'));
    const run = spawnSync(process.execPath, [path.join(bin, 'cross-target-artifact-contract.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL'
      && /target set/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
