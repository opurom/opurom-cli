// Tests for the machine-readable report-archive integrity gate.
// Flutter authority: 3.50.0 / ab2912035e,
// dev/devicelab/lib/framework/task_result.dart:106/132 and
// dev/devicelab/lib/framework/metrics_center.dart:75-89/103-113.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'report-archive-integrity-contract.mjs');

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

test('the report archive gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.report-archive-integrity-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.contract.reportSchema, 'opurom.test-report/v1');
  assert.deepEqual(run.json.contract.provenanceStatuses, ['N/A', 'FAIL']);
  assert.equal(run.json.contract.latestReplaysFailure, true);
  assert.ok(run.json.evidence.provenanceRows > 0);
  assert.equal(run.json.summary.total, 5);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the report archive gate fails closed on invalid schema and FAIL replay', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-report-gate-'));
  try {
    const gate = path.join(dir, 'report-archive-integrity-contract.mjs');
    const original = readFileSync(GATE, 'utf8')
      .replace("from '../lib/test_report.mjs'", `from ${JSON.stringify(path.join(ROOT, 'lib', 'test_report.mjs'))}`)
      .replace("from '../lib/paths.mjs'", `from ${JSON.stringify(path.join(ROOT, 'lib', 'paths.mjs'))}`)
      .replace("assert.equal(archived.schema, report.schema);", "assert.equal(archived.schema, 'mutated-schema');");
    writeFileSync(gate, original);
    const run = spawnSync(process.execPath, [gate], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL' && /round-trip/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
