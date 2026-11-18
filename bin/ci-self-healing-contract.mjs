#!/usr/bin/env node
// Machine-readable contract for one-shot CI failure self-healing.
//
// Quality-gate layer only: it validates an evidence record for "record failed
// job -> retry exactly once -> require a full second-acceptance run". It does
// not trigger GitHub Actions or edit workflow files. With no external file it
// validates a deterministic policy fixture and labels it as such; a real run
// can supply OPUROM_CI_HEALING_EVENTS with the same schema.
//
// Flutter 3.50.0 / ab2912035e provenance is inherited from the full gate
// matrix that every revalidation must contain.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = JSON.parse(readFileSync(path.join(ROOT, '.github', 'opurom.json'), 'utf8'));
const CHECKS = [...(MANIFEST.checks ?? [])];
const COMMIT = process.env.GITHUB_SHA ?? 'contract-fixture-commit';
const COMMAND = 'node .github/scripts/ci-check.mjs node-test';

function fixture() {
  return {
    schema: 'opurom.ci-healing-events/v1',
    commit: COMMIT,
    failure: {
      runId: 'fixture-run-1',
      job: 'node-test',
      step: 'Run node-test',
      attempt: 1,
      exitCode: 1,
      failedAt: '2026-11-18T00:00:00.000Z',
      failureClass: 'flake',
      command: COMMAND,
    },
    retries: [{
      runId: 'fixture-run-2',
      job: 'node-test',
      step: 'Run node-test',
      attempt: 2,
      exitCode: 0,
      status: 'PASS',
      startedAt: '2026-11-18T00:01:00.000Z',
      completedAt: '2026-11-18T00:02:00.000Z',
      command: COMMAND,
      evidenceRef: 'fixture-run-2/job/retry',
    }],
    revalidation: {
      runId: 'fixture-run-3',
      commit: COMMIT,
      status: 'SUCCESS',
      conclusion: 'SUCCESS',
      startedAt: '2026-11-18T00:03:00.000Z',
      completedAt: '2026-11-18T00:05:00.000Z',
      checks: [...CHECKS],
      failedJobs: [],
      evidenceRef: 'fixture-run-3/actions',
    },
  };
}

function loadEvents() {
  const file = process.env.OPUROM_CI_HEALING_EVENTS;
  if (!file) return { events: fixture(), source: 'synthetic-policy-fixture' };
  const events = JSON.parse(readFileSync(file, 'utf8'));
  return { events, source: path.resolve(file) };
}

function assertFailure(record) {
  assert.ok(record && typeof record === 'object', 'failure record is required');
  for (const key of ['runId', 'job', 'step', 'attempt', 'exitCode', 'failedAt', 'failureClass', 'command']) {
    assert.ok(record[key] !== undefined && record[key] !== null && record[key] !== '',
      `failure.${key} is required`);
  }
  assert.equal(record.attempt, 1, 'the first failure must be attempt 1');
  assert.notEqual(record.exitCode, 0, 'a failure record needs a nonzero exit code');
  assert.ok(Number.isFinite(Date.parse(record.failedAt)), 'failure.failedAt must be a timestamp');
  assert.match(record.failureClass, /^[a-z][a-z0-9-]+$/, 'failureClass must be a stable slug');
}

function assertRetries({ failure, retries }) {
  assert.ok(Array.isArray(retries), 'retries must be an array');
  assert.equal(retries.length, 1, 'self-healing allows exactly one retry, not zero or several');
  const [retry] = retries;
  for (const key of ['runId', 'job', 'attempt', 'exitCode', 'status', 'startedAt', 'completedAt', 'command', 'evidenceRef']) {
    assert.ok(retry[key] !== undefined && retry[key] !== null && retry[key] !== '',
      `retries[0].${key} is required`);
  }
  assert.equal(retry.job, failure.job, 'the retry must target the failed job');
  assert.equal(retry.attempt, failure.attempt + 1, 'the retry must be attempt 2');
  assert.equal(retry.exitCode, 0, 'the retry must succeed');
  assert.equal(retry.status, 'PASS', 'the retry must report PASS');
  assert.equal(retry.command, failure.command, 'the retry must run the same command');
  assert.notEqual(retry.runId, failure.runId, 'the retry needs its own run id');
  assert.ok(Date.parse(retry.startedAt) >= Date.parse(failure.failedAt),
    'the retry must start after the recorded failure');
  assert.ok(Date.parse(retry.completedAt) >= Date.parse(retry.startedAt),
    'the retry completion must follow its start');
}

function assertRevalidation(events) {
  const record = events.revalidation;
  assert.ok(record && typeof record === 'object', 'second-acceptance revalidation is required');
  for (const key of ['runId', 'commit', 'status', 'conclusion', 'startedAt', 'completedAt', 'evidenceRef']) {
    assert.ok(record[key] !== undefined && record[key] !== null && record[key] !== '',
      `revalidation.${key} is required`);
  }
  assert.equal(record.commit, events.commit, 'revalidation must cover the same commit');
  assert.equal(record.status, 'SUCCESS', 'revalidation status must be SUCCESS');
  assert.equal(record.conclusion, 'SUCCESS', 'revalidation conclusion must be SUCCESS');
  assert.ok(Date.parse(record.startedAt) >= Date.parse(events.retries[0].completedAt),
    'revalidation must follow the successful retry');
  assert.ok(Date.parse(record.completedAt) >= Date.parse(record.startedAt));
  assert.ok(Array.isArray(record.checks) && record.checks.length === CHECKS.length,
    'revalidation must cover the complete CI check set');
  for (const check of CHECKS) {
    assert.ok(record.checks.includes(check), `revalidation is missing check ${check}`);
  }
  assert.ok(Array.isArray(record.failedJobs) && record.failedJobs.length === 0,
    'revalidation must have no failed jobs');
}

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

const { events, source } = loadEvents();

check('event envelope pins the same commit across failure, retry and revalidation', () => {
  assert.equal(events.schema, 'opurom.ci-healing-events/v1');
  assert.ok(events.commit, 'commit is required');
  assert.equal(events.revalidation?.commit, events.commit);
});

check('the failed job is recorded with an actionable reason and nonzero exit', () => {
  assertFailure(events.failure);
});

check('the same job is retried exactly once with matching command and run ids', () => {
  assertRetries({ failure: events.failure, retries: events.retries });
});

check('a full second-acceptance run passes on the same commit', () => {
  assertRevalidation(events);
});

check('a third retry or a retry without a failure is rejected', () => {
  assert.throws(() => assertRetries({
    failure: events.failure,
    retries: [...events.retries, { ...events.retries[0], runId: 'third-run', attempt: 3 }],
  }), /exactly one retry/);
  assert.throws(() => assertRetries({ failure: null, retries: events.retries }), /job/);
});

check('revalidation with a different commit or missing check is rejected', () => {
  assert.throws(() => assertRevalidation({
    ...events,
    revalidation: { ...events.revalidation, commit: 'different-commit' },
  }), /same commit/);
  assert.throws(() => assertRevalidation({
    ...events,
    revalidation: { ...events.revalidation, checks: CHECKS.slice(1) },
  }), /complete CI check set/);
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.ci-self-healing-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    provenance: 'inherited from the complete CI check set in revalidation',
  },
  contract: {
    eventSchema: 'opurom.ci-healing-events/v1',
    maxRetries: 1,
    requiresFullMatrixRevalidation: true,
    ciChecks: CHECKS,
  },
  evidence: {
    source,
    evidenceKind: source === 'synthetic-policy-fixture' ? 'synthetic-policy-fixture' : 'external-record',
    commit: events.commit,
    failedRunId: events.failure?.runId ?? null,
    failedJob: events.failure?.job ?? null,
    failureClass: events.failure?.failureClass ?? null,
    retryRunId: events.retries?.[0]?.runId ?? null,
    retryCount: Array.isArray(events.retries) ? events.retries.length : null,
    revalidationRunId: events.revalidation?.runId ?? null,
    revalidationChecks: Array.isArray(events.revalidation?.checks) ? events.revalidation.checks.length : null,
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
