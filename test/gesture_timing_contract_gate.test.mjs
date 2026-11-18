// Tests for the machine-readable gesture timing contract gate.
// Flutter authority: 3.50.0 / ab2912035e,
// packages/flutter/lib/src/gestures/constants.dart:29/35/39/49/65/76/80/90/95.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'gesture-timing-contract.mjs');

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

test('the gesture timing gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.gesture-timing-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.deepEqual(run.json.contract.thresholds, {
    longPressTimeoutMs: 500,
    doubleTapTimeoutMs: 300,
    doubleTapMinTimeMs: 40,
    touchSlopPx: 18,
    panSlopPx: 36,
    scaleSlopPx: 18,
  });
  assert.equal(run.json.summary.total, 3);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the gesture timing gate fails closed when a published threshold drifts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-gesture-gate-'));
  try {
    const lib = path.join(dir, 'lib');
    const bin = path.join(dir, 'bin');
    mkdirSync(lib, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const original = readFileSync(path.join(ROOT, 'lib', 'test_authority.mjs'), 'utf8');
    writeFileSync(path.join(lib, 'test_authority.mjs'),
      original.replace('longPressTimeoutMs: 500,', 'longPressTimeoutMs: 499,'));
    writeFileSync(path.join(bin, 'gesture-timing-contract.mjs'), readFileSync(GATE, 'utf8'));
    const run = spawnSync(process.execPath, [path.join(bin, 'gesture-timing-contract.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL'
      && /threshold/i.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
