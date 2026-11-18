// Tests for the machine-readable golden failure-output contract gate.
// Flutter authority: 3.50.0 / ab2912035e,
// packages/flutter_test/lib/src/goldens.dart:118-119/258-273,
// packages/flutter_test/lib/src/_goldens_io.dart:141-164/176-214/255-260,
// packages/flutter_test/lib/src/matchers.dart:589.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'golden-failure-contract.mjs');

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

test('the golden failure gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.golden-failure-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.contract.defaultComparison, 'exact');
  assert.deepEqual(run.json.contract.opuromFailureFields, ['golden', 'error', 'diffArtifacts']);
  assert.equal(run.json.summary.total, 4);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the golden failure gate fails closed when diff artifact reporting drifts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-golden-gate-'));
  try {
    const lib = path.join(dir, 'lib');
    const bin = path.join(dir, 'bin');
    mkdirSync(lib, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const original = readFileSync(path.join(ROOT, 'lib', 'pixel_gate.mjs'), 'utf8');
    writeFileSync(path.join(lib, 'pixel_gate.mjs'),
      original.replace('diffArtifacts: diffArtifacts ?? [],\n  };\n  return result;', 'diffArtifacts: [],\n  };\n  return result;'));
    writeFileSync(path.join(lib, 'test_authority.mjs'),
      readFileSync(path.join(ROOT, 'lib', 'test_authority.mjs'), 'utf8'));
    writeFileSync(path.join(bin, 'golden-failure-contract.mjs'), readFileSync(GATE, 'utf8'));
    const run = spawnSync(process.execPath, [path.join(bin, 'golden-failure-contract.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL' && /diff artifact/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
