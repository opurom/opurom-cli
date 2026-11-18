// Tests for the machine-readable CI self-healing contract gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'ci-self-healing-contract.mjs');

function runGate({ cwd = ROOT, file = null } = {}) {
  const env = { ...process.env, NODE_V8_COVERAGE: '' };
  if (file) env.OPUROM_CI_HEALING_EVENTS = file;
  else delete env.OPUROM_CI_HEALING_EVENTS;
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.error, undefined);
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

test('the self-healing gate emits a passing machine-readable policy report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.ci-self-healing-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.contract.maxRetries, 1);
  assert.equal(run.json.contract.requiresFullMatrixRevalidation, true);
  assert.ok(run.json.contract.ciChecks.length >= 5);
  assert.equal(run.json.evidence.evidenceKind, 'synthetic-policy-fixture');
  assert.equal(run.json.summary.total, 6);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('an external record with two retries fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-healing-gate-'));
  try {
    const file = path.join(dir, 'events.json');
    // Start from the gate's own fixture schema, then duplicate the retry.
    const source = readFileSync(GATE, 'utf8');
    assert.ok(source.includes('opurom.ci-healing-events/v1'));
    const manifest = JSON.parse(readFileSync(path.join(ROOT, '.github', 'opurom.json'), 'utf8'));
    const checks = [...(manifest.checks ?? [])];
    const events = {
      schema: 'opurom.ci-healing-events/v1',
      commit: 'abc1234',
      failure: {
        runId: 'r1', job: 'node-test', step: 'Run node-test', attempt: 1,
        exitCode: 1, failedAt: '2026-11-18T00:00:00.000Z',
        failureClass: 'flake', command: 'node .github/scripts/ci-check.mjs node-test',
      },
      retries: [{
        runId: 'r2', job: 'node-test', attempt: 2, exitCode: 0, status: 'PASS',
        startedAt: '2026-11-18T00:01:00.000Z', completedAt: '2026-11-18T00:02:00.000Z',
        command: 'node .github/scripts/ci-check.mjs node-test', evidenceRef: 'r2',
      }, {
        runId: 'r3', job: 'node-test', attempt: 3, exitCode: 0, status: 'PASS',
        startedAt: '2026-11-18T00:03:00.000Z', completedAt: '2026-11-18T00:04:00.000Z',
        command: 'node .github/scripts/ci-check.mjs node-test', evidenceRef: 'r3',
      }],
      revalidation: {
        runId: 'r4', commit: 'abc1234', status: 'SUCCESS', conclusion: 'SUCCESS',
        startedAt: '2026-11-18T00:05:00.000Z', completedAt: '2026-11-18T00:07:00.000Z',
        checks, failedJobs: [], evidenceRef: 'r4',
      },
    };
    writeFileSync(file, `${JSON.stringify(events, null, 2)}\n`);
    const run = runGate({ file });
    assert.equal(run.status, 1);
    assert.equal(run.json.status, 'FAIL');
    assert.ok(run.json.summary.fail >= 1);
    assert.equal(run.json.evidence.evidenceKind, 'external-record');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
