#!/usr/bin/env node
// Machine-readable replay-stability gate for all module-eight contract gates.
//
// Runs every contract gate twice on the same checkout and compares the exact
// JSON bytes. The Flutter provenance gate exposes the current git head, which
// is legitimate to change between runs; that single field is normalized
// before hashing. Any other byte drift fails closed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  'contract-schema-consistency',
  'deterministic-evidence-contract',
  'component-motion-recipe-contract',
]);

function runGate(name) {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', `${name}.mjs`)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

function normalize(name, text) {
  if (name !== 'flutter-provenance-contract') return text;
  return text.replace(/"head": "[0-9a-f]{40}"/, '"head": "<commit>"');
}

const gates = GATES.map((name) => {
  const first = runGate(name);
  const second = runGate(name);
  const a = normalize(name, first.stdout);
  const b = normalize(name, second.stdout);
  const stable = first.status === 0 && second.status === 0 && a === b;
  return {
    name,
    status: stable ? 'PASS' : 'FAIL',
    exitCodes: [first.status, second.status],
    bytes: [Buffer.byteLength(a), Buffer.byteLength(b)],
    sha256: [createHash('sha256').update(a).digest('hex'), createHash('sha256').update(b).digest('hex')],
    error: stable ? null : 'gate output changed between replays',
  };
});

const failed = gates.filter((gate) => gate.status === 'FAIL').length;
const report = {
  schema: 'opurom.gate-replay-stability/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: { version: '3.50.0', goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb' },
  contract: {
    runsPerGate: 2,
    normalizedFields: ['flutter-provenance-contract.head'],
    byteIdentical: true,
  },
  summary: { total: gates.length, pass: gates.length - failed, fail: failed },
  gates,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
