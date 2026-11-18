import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { archiveReport, buildReport, latestReport, readArchivedReport, reportJson } from '../lib/test_report.mjs';
import { FLUTTER_VERSION, GESTURE_CONSTANTS, PERF_GATE, PIXEL_GATE } from '../lib/test_authority.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE = path.resolve(CLI_ROOT, '..');
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: CLI_ROOT, encoding: 'utf8' });
}

test('authority constants match the pinned Flutter source', () => {
  assert.equal(FLUTTER_VERSION.commit, 'ab2912035e160d9cad6306df307576da6128ebdb');
  assert.equal(FLUTTER_VERSION.version, '3.50.0');
  assert.equal(GESTURE_CONSTANTS.touchSlopPx, 18);
  assert.equal(GESTURE_CONSTANTS.panSlopPx, 36);
  assert.equal(GESTURE_CONSTANTS.scaleSlopPx, 18);
  assert.equal(GESTURE_CONSTANTS.doubleTapSlopPx, 100);
  assert.equal(GESTURE_CONSTANTS.longPressTimeoutMs, 500);
  assert.equal(GESTURE_CONSTANTS.doubleTapTimeoutMs, 300);
  assert.equal(GESTURE_CONSTANTS.doubleTapMinTimeMs, 40);
  assert.equal(GESTURE_CONSTANTS.doubleTapSlopPx, 100);
  assert.equal(GESTURE_CONSTANTS.minFlingVelocity, 50);
  assert.equal(GESTURE_CONSTANTS.maxFlingVelocity, 8000);
  assert.deepEqual(PIXEL_GATE, { latinDiffPct: 2, cjkDiffPct: 12, metricsPx: 1, crossFont: 'N/A' });
  assert.match(PERF_GATE.naMarker, /N\/A - performance benchmark/);
});

test('report rows are computed from real files, not a hard-coded PASS', () => {
  const report = buildReport({ root: WORKSPACE });
  assert.equal(report.schema, 'opurom.test-report/v1');
  assert.equal(report.toolchain.flutter.commit, FLUTTER_VERSION.commit);
  assert.ok(report.rows.length >= 12, 'all four test layers plus pixel/perf/provenance rows');
  assert.ok(report.rows.every((row) => ['PASS', 'FAIL', 'SKIP', 'N/A'].includes(row.status)),    `unexpected status: ${JSON.stringify(report.rows)}`);
  const eightState = report.rows.find((row) => row.name === 'component:eight-state');
  assert.match(eightState.detail, /pins, \d+ components/);
  assert.equal(eightState.status, 'PASS');
  const registry = report.rows.find((row) => row.name === 'integration:example-registry');
  assert.match(registry.detail, /\d+ apps, \d+ tests/);
  assert.equal(registry.status, 'PASS');
  assert.equal(report.summary.PASS + report.summary.FAIL + report.summary.N_A, report.rows.length);
});

test('archive writes deterministic JSON and --latest reads it back', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-report-'));
  const report = buildReport({ root: WORKSPACE, executed: [{ name: 'probe', status: 'N/A', detail: 'check' }] });
  const file = archiveReport(report, { root: dir, dir: path.join(dir, 'nested/reports'), stamp: '2026-11-18T00-00-00Z' });
  assert.equal(file, path.join(dir, 'nested', 'reports', '2026-11-18T00-00-00Z.json'));
  assert.equal(readFileSync(file, 'utf8'), reportJson(report));
  assert.equal(latestReport(dir, path.join(dir, 'nested/reports')), file);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(parsed.rows.at(-1), { name: 'probe', status: 'N/A', detail: 'check' });
  assert.equal(parsed.summary.N_A, report.summary.N_A);
  assert.equal(parsed.summary.N_A - buildReport({ root: WORKSPACE }).summary.N_A, 1);
});

test('CLI --report archives and prints the report without running fake tests', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-report-cli-'));
  const result = run(['test', '--report', '--out', dir]);
  assert.equal(result.status, 0, `stderr=${result.stderr}`);
  assert.match(result.stderr, /archived /);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, 'opurom.test-report/v1');
  const files = readdirSync(dir).filter((name) => name.endsWith('.json'));
  assert.equal(files.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(path.join(dir, files[0]), 'utf8')), report);
});

test('CLI rejects --report combined with a test mode', () => {
  for (const args of [
    ['test', '--report', '--examples'],
    ['test', '--report', '--fail-fast'],
    ['test', '--report', '--update-goldens'],
  ]) {
    const result = run(args);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, /--report is standalone/);
  }
});

test('provenance rows never pretend a test ran', () => {
  const report = buildReport({ root: WORKSPACE });
  const provenance = report.rows.filter((row) => row.name.startsWith('provenance:'));
  assert.ok(provenance.length >= 9, 'six suites plus threshold/performance provenance rows');
  assert.ok(provenance.every((row) => row.status === 'N/A' || row.status === 'FAIL'),
    `provenance must not be PASS: ${JSON.stringify(provenance)}`);
  assert.ok(provenance.every((row) => row.reason), 'every provenance row states why no test ran');
  assert.equal(report.summary.PASS, report.rows.filter((row) => row.status === 'PASS').length);
  assert.equal(report.summary.FAIL, report.rows.filter((row) => row.status === 'FAIL').length);
});

test('a broken fixture is archived as FAIL and exits nonzero', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-broken-fixture-'));
  const stateFile = path.join(dir, 'opurom-ui/test/state-digests.json');
  mkdirSync(path.dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, '{not json');
  const report = buildReport({ root: dir });
  const state = report.rows.find((row) => row.name === 'component:eight-state');
  assert.equal(state.status, 'FAIL');
  assert.match(state.reason, /invalid fixture/);
  assert.equal(state.status !== buildReport({ root: WORKSPACE }).rows.find((r) => r.name === state.name).status, true);
});

test('--latest replays the archived FAIL status', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-latest-fail-'));
  const failed = buildReport({ root: WORKSPACE, executed: [{ name: 'real-suite', status: 'FAIL', detail: 'probe' }] });
  archiveReport(failed, { root: dir, dir: path.join(dir, 'reports'), stamp: '2026-11-18T00-00-00Z' });
  const result = run(['test', '--report', '--latest', '--out', path.join(dir, 'reports')]);
  assert.equal(result.status, 1, `stderr=${result.stderr}`);
  const archived = readArchivedReport(path.join(dir, 'reports/2026-11-18T00-00-00Z.json'));
  // CI checkouts have fewer sibling repos than the local workspace, so the
  // provenance rows can legitimately add FAILs. The contract under test is
  // that an archived FAIL is replayed as a nonzero exit, not a fixed count.
  assert.ok(archived.summary.FAIL >= 1, `expected an archived FAIL: ${JSON.stringify(archived.summary)}`);
});

test('mutated authority constants fail the source-proof test', () => {
  // Mutation self-check: buildReport must disagree with a signed constant when
  // the Rust source no longer carries the Flutter authority markers.
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-mutation-'));
  const source = path.join(dir, 'opurom-render/src');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'gestures.rs'), '// no Flutter authority markers\n');
  const report = buildReport({ root: dir });
  const row = report.rows.find((row) => row.name === 'provenance:gesture-thresholds');
  assert.equal(row.status, 'FAIL');
  const baseline = buildReport({ root: WORKSPACE });
  assert.equal(row.status !== baseline.rows.find((r) => r.name === row.name).status, true);
});
