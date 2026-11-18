#!/usr/bin/env node
// Single machine-readable verdict over every module-eight contract gate.
//
// Each child gate is independent and emits its own JSON document. This
// aggregator only runs them and normalizes their results; it does not modify
// any gate or implementation. Flutter provenance is inherited from every
// child gate (3.50.0 / ab2912035e160...).
//
// Exit 0 only when every child gate reports PASS with exit code 0.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATES = Object.freeze([
  ['performance-phase-contract', 'opurom.performance-phase-contract/v1'],
  ['test-scheduling-contract', 'opurom.test-scheduling-contract/v1'],
  ['golden-failure-contract', 'opurom.golden-failure-contract/v1'],
  ['gesture-timing-contract', 'opurom.gesture-timing-contract/v1'],
  ['cross-target-artifact-contract', 'opurom.cross-target-artifact-contract/v1'],
  ['fuzz-input-corpus-contract', 'opurom.fuzz-input-corpus-contract/v1'],
  ['stability-resource-contract', 'opurom.stability-resource-contract/v1'],
  ['report-archive-integrity-contract', 'opurom.report-archive-integrity-contract/v1'],
  ['flutter-provenance-contract', 'opurom.flutter-provenance-contract/v1'],
  ['provenance-citation-consistency', 'opurom.provenance-citation-consistency/v1'],
  ['contract-schema-consistency', 'opurom.contract-schema-consistency/v1'],
  ['deterministic-evidence-contract', 'opurom.deterministic-evidence-contract/v1'],
  ['component-motion-recipe-contract', 'opurom.component-motion-recipe-contract/v1'],
]);

const gates = GATES.map(([name, schema]) => {
  const entry = path.join(ROOT, 'bin', `${name}.mjs`);
  const run = spawnSync(process.execPath, [entry], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  let report = null;
  let parseError = null;
  try {
    report = JSON.parse(run.stdout);
  } catch (error) {
    parseError = error.message;
  }
  const healthy = run.status === 0 && !run.error && !parseError
    && report?.schema === schema && report?.status === 'PASS';
  return {
    name,
    schema,
    exitCode: run.status,
    status: healthy ? 'PASS' : 'FAIL',
    summary: report?.summary ?? null,
    error: parseError ?? run.error?.message ?? (healthy ? null : (report?.status ?? 'gate did not report PASS')),
  };
});

const failed = gates.filter((gate) => gate.status === 'FAIL').length;
const verdict = {
  schema: 'opurom.contract-gate-verdict/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    provenance: 'inherited from each child contract gate',
  },
  summary: { total: gates.length, pass: gates.length - failed, fail: failed },
  gates,
};
process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
