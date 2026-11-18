#!/usr/bin/env node
// Machine-readable gate for test-report archive integrity.
//
// Quality-gate layer only: it builds and reads published report archives; it
// does not change test_report.mjs or the CLI. Flutter authority (3.50.0,
// flutter-golden ab2912035e160d9cad6306df307576da6128ebdb):
// - dev/devicelab/lib/framework/task_result.dart:106/132 builds tags and
//   score keys for a machine-readable task result.
// - dev/devicelab/lib/framework/metrics_center.dart:75-89/103-113 archives
//   those values deterministically.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReport, readArchivedReport } from '../lib/test_report.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

function runLatest(dir) {
  return spawnSync(process.execPath, [CLI, 'test', '--report', '--latest', '--out', dir], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
}

const dir = mkdtempSync(path.join(tmpdir(), 'opurom-report-integrity-'));
let summary = null;
let provenanceRows = 0;
try {
  check('a freshly built report has a valid schema and counted summary', () => {
    const report = buildReport({ root: ROOT });
    assert.equal(report.schema, 'opurom.test-report/v1');
    assert.equal(report.toolchain.flutter.version, '3.50.0');
    assert.ok(Number.isSafeInteger(report.summary.PASS));
    assert.ok(Number.isSafeInteger(report.summary.FAIL));
    for (const key of ['PASS', 'FAIL', 'SKIP', 'N_A', 'UPDATED']) {
      assert.ok(Number.isSafeInteger(report.summary[key]), `missing summary key ${key}`);
    }
    summary = report.summary;
    provenanceRows = report.rows.filter((row) => row.name.startsWith('provenance:')).length;
    assert.ok(provenanceRows > 0, 'provenance rows are required');
  });

  check('provenance rows never masquerade as test PASS', () => {
    const report = buildReport({ root: ROOT });
    const rows = report.rows.filter((row) => row.name.startsWith('provenance:'));
    for (const row of rows) {
      assert.ok(['N/A', 'FAIL'].includes(row.status),
        `${row.name} reported ${row.status}; provenance must be N/A or FAIL`);
      assert.ok(row.reason, `${row.name} has no reason`);
    }
  });

  check('archive round-trip validates schema and replays clean status', () => {
    const report = buildReport({ root: ROOT });
    const file = path.join(dir, 'baseline.json');
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    const archived = readArchivedReport(file);
    assert.equal(archived.schema, report.schema);
    assert.deepEqual(archived.summary, report.summary);
    const run = runLatest(dir);
    assert.equal(run.status, report.summary.FAIL ? 1 : 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).schema, report.schema);
  });

  check('a FAIL archive is replayed as a nonzero CLI exit', () => {
    const report = buildReport({ root: ROOT });
    report.rows.push({ name: 'contract:forced-fail', status: 'FAIL', detail: 'synthetic', reason: 'contract check' });
    report.summary.FAIL += 1;
    writeFileSync(path.join(dir, 'baseline.json'), `${JSON.stringify(report, null, 2)}\n`);
    const run = runLatest(dir);
    assert.equal(run.status, 1, run.stderr);
    assert.ok(JSON.parse(run.stdout).summary.FAIL >= 1);
  });

  check('a corrupt archive fails closed', () => {
    writeFileSync(path.join(dir, 'baseline.json'), '{"schema":"wrong","summary":{"FAIL":0}}\n');
    assert.throws(() => readArchivedReport(path.join(dir, 'baseline.json')), /invalid test report/);
  });
} finally {
  // OS temp dir keeps failed archives available for postmortem.
}

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.report-archive-integrity-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: [
      'dev/devicelab/lib/framework/task_result.dart:106/132',
      'dev/devicelab/lib/framework/metrics_center.dart:75-89/103-113',
    ],
  },
  contract: {
    reportSchema: 'opurom.test-report/v1',
    provenanceStatuses: ['N/A', 'FAIL'],
    latestReplaysFailure: true,
  },
  evidence: { builtSummary: summary, provenanceRows },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
