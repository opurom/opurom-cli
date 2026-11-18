// Tests for the machine-readable DevTools phase-breakdown gate.
// The gate is quality-gate-only and imports the tool-dev implementation
// without changing it. Flutter authority: 3.50.0 / ab2912035e,
// engine/src/flutter/flow/frame_timings.h:35-42.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'performance-phase-contract.mjs');

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
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, json };
}

test('the phase contract gate emits a passing, machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.json.schema, 'opurom.performance-phase-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.flutter.authority, 'engine/src/flutter/flow/frame_timings.h:35-42');
  assert.deepEqual(run.json.contract.phases, [
    'vsyncToBuildStart', 'build', 'buildEndToRaster', 'raster', 'total',
  ]);
  assert.equal(run.json.summary.total, 5);
  assert.equal(run.json.summary.pass, 5);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the gate fails closed with JSON when the imported implementation drifts', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'opurom-phase-contract-'));
  try {
    const lib = path.join(dir, 'lib');
    const bin = path.join(dir, 'bin');
    const impl = path.join(lib, 'performance_profile.mjs');
    const gate = path.join(bin, 'performance-phase-contract.mjs');
    mkdirSync(lib, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const original = readFileSync(path.join(ROOT, 'lib', 'performance_profile.mjs'), 'utf8');
    writeFileSync(impl, original.replace("'vsyncToBuildStart', 'build'", "'build', 'vsyncToBuildStart'"));
    writeFileSync(gate, readFileSync(GATE, 'utf8'));
    const run = spawnSync(process.execPath, [gate], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.equal(json.summary.fail, 1);
    assert.match(json.checks.find((row) => row.status === 'FAIL').error, /vsyncToBuildStart|build/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
