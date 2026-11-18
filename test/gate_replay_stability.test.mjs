// Tests for the machine-readable gate replay-stability contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'gate-replay-stability.mjs');

function runGate() {
  const run = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

test('every module-eight gate is byte-stable across two replays', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.gate-replay-stability/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.contract.runsPerGate, 2);
  assert.equal(run.json.summary.total, 13);
  assert.equal(run.json.summary.fail, 0);
  for (const gate of run.json.gates) {
    assert.equal(gate.status, 'PASS');
    assert.deepEqual(gate.exitCodes, [0, 0]);
    assert.equal(gate.sha256[0], gate.sha256[1]);
    assert.equal(gate.bytes[0], gate.bytes[1]);
  }
});
