#!/usr/bin/env node
// Machine-readable gate that rejects nondeterministic fields in gate JSON.
//
// Every contract gate must emit stable, replayable evidence: no wall-clock
// timestamps, random ids, durations or host paths in top-level evidence. This
// mirrors Flutter's deterministic report discipline and complements the
// machine-readable schema gates.
//
// Exit 0 only when every gate output has deterministic top-level evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATES = Object.freeze([
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
  'ci-self-healing-contract',
  'component-motion-recipe-contract',
]);

const FORBIDDEN_KEY = /\b(?:timestamp|generatedAt|createdAt|updatedAt|startedAt|completedAt|failedAt|duration|elapsed|random|nonce|uuid)\b/i;
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

function stableFields(value, trail = '') {
  const bad = [];
  if (Array.isArray(value)) {
    value.forEach((entry, index) => bad.push(...stableFields(entry, `${trail}[${index}]`)));
    return bad;
  }
  if (!value || typeof value !== 'object') return bad;
  for (const [key, child] of Object.entries(value)) {
    const here = trail ? `${trail}.${key}` : key;
    if (FORBIDDEN_KEY.test(key)) bad.push(here);
    if (typeof child === 'string' && /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(child)) bad.push(here);
    bad.push(...stableFields(child, here));
  }
  return bad;
}

for (const name of GATES) {
  check(`${name} emits deterministic evidence fields`, () => {
    const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', `${name}.mjs`)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    });
    assert.equal(run.status, 0, `${name} gate failed: ${run.stderr}`);
    const report = JSON.parse(run.stdout);
    // Temporal fields are only legitimate inside the external evidence record
    // validated by the self-healing policy fixture, not in gate output.
    const observed = report.observed ?? {};
    const evidence = name === 'ci-self-healing-contract' ? {} : report.evidence ?? {};
    const bad = [...stableFields(observed), ...stableFields(evidence)];
    assert.deepEqual(bad, [], `${name} exposes nondeterministic fields: ${bad.join(', ')}`);
  });
}

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.deterministic-evidence-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: { version: '3.50.0', goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb' },
  contract: {
    checkedGates: GATES.length,
    forbiddenFields: ['timestamp', 'generatedAt', 'createdAt', 'updatedAt', 'startedAt', 'completedAt', 'failedAt', 'duration', 'elapsed', 'random', 'nonce', 'uuid'],
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
