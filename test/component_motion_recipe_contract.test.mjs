// Tests for the component recipe and MotionSpec default-path gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'component-motion-recipe-contract.mjs');

function runGate() {
  const run = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  assert.equal(run.error, undefined);
  return { status: run.status, json: JSON.parse(run.stdout) };
}

test('default product path lowers all recipes and semantic motion', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.component-motion-recipe-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.contract.defaultProfile, 'product');
  assert.equal(run.json.contract.explicitDowngrade, 'compat');
  assert.equal(run.json.contract.runtimeIrInterpreter, false);
  assert.equal(run.json.contract.recipeKinds.length, 12);
  assert.equal(run.json.contract.motionEvents.length, 8);
  assert.equal(run.json.summary.fail, 0);
  for (const row of run.json.checks) assert.equal(row.status, 'PASS', row.name);
});

test('the gate output is byte-stable across replays', () => {
  const first = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  const second = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
});
