// Tests for the single machine-readable contract gate verdict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERDICT = path.join(ROOT, 'bin', 'contract-gate-verdict.mjs');

function runVerdict(cwd = ROOT) {
  const run = spawnSync(process.execPath, [VERDICT], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  assert.equal(run.error, undefined);
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch (error) {
    assert.fail(`verdict stdout is not JSON: ${run.stdout}\n${run.stderr}\n${error.message}`);
  }
  return { status: run.status, json };
}

test('the verdict aggregates every contract gate into one PASS document', () => {
  const run = runVerdict();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.contract-gate-verdict/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.summary.total, 12);
  assert.equal(run.json.summary.fail, 0);
  assert.deepEqual(run.json.gates.map((gate) => gate.name), [
    'performance-phase-contract',
    'test-scheduling-contract',
    'golden-failure-contract',
    'gesture-timing-contract',
    'cross-target-artifact-contract',
    'fuzz-input-corpus-contract',
    'stability-resource-contract',
    'report-archive-integrity-contract',
    'flutter-provenance-contract',
    'provenance-citation-consistency',
    'contract-schema-consistency',
    'deterministic-evidence-contract',
  ]);
  assert.ok(run.json.gates.every((gate) => gate.status === 'PASS' && gate.exitCode === 0));
});

test('the verdict fails closed when a child gate schema drifts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-verdict-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    const gates = path.join(bin, 'gates');
    const original = readFileSync(VERDICT, 'utf8')
      .replace('const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), \'..\');',
        `const ROOT = ${JSON.stringify(ROOT)};`)
      .replace("['performance-phase-contract', 'opurom.performance-phase-contract/v1']",
        "['performance-phase-contract', 'opurom.drifted-schema/v1']");
    writeFileSync(path.join(dir, 'contract-gate-verdict.mjs'), original);
    const run = spawnSync(process.execPath, [path.join(dir, 'contract-gate-verdict.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.equal(json.gates[0].status, 'FAIL');
    assert.equal(json.gates[0].schema, 'opurom.drifted-schema/v1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
