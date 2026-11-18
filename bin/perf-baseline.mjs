#!/usr/bin/env node
// Capture a real performance baseline through the CLI's published profiler
// and write a signed JSON record. All durations come from actual
// `opurom-render` subprocesses; no synthetic or competitor numbers are used.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baselineRecord } from '../lib/perf_baseline.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = fileURLToPath(new URL('./opurom.mjs', import.meta.url));

function fail(message) {
  console.error(message);
  process.exit(2);
}

const scenario = process.argv[2];
const source = process.argv[3];
const out = process.argv[4];
const commit = process.argv[5];
const branch = process.argv[6] ?? 'main';
const device = process.argv[7] ?? 'ci-linux';
const repeat = process.argv[8] ?? '5';
const maxRegressionPct = process.argv[9] ?? '10';

if (!scenario || !source || !out || !commit) {
  fail('usage: node bin/perf-baseline.mjs <scenario> <src.opu> <out.json> <commit> [branch] [device] [repeat] [maxRegressionPct]');
}

const runs = Number(repeat);
const threshold = Number(maxRegressionPct);
if (!Number.isSafeInteger(runs) || runs < 1 || runs > 600) fail(`invalid repeat: ${repeat}`);
if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) fail(`invalid threshold: ${maxRegressionPct}`);

const profiler = spawnSync(process.execPath, [
  CLI, 'profile', '--src', source, '--repeat', String(runs), '--json',
], { cwd: CLI_ROOT, encoding: 'utf8' });
if (profiler.status !== 0) {
  fail(`profile failed: ${profiler.stderr || profiler.stdout}`);
}
let report;
try {
  report = JSON.parse(profiler.stdout);
} catch (error) {
  fail(`profile wrote no JSON: ${error.message}`);
}
// The published machine report carries p50/p95/min/max from real renderer
// subprocesses but not the raw sample array; sign those measured statistics
// as a one-element sample so nearest-rank p50/p95 round-trip exactly.
if (report?.mode !== 'repeat' || !Number.isFinite(report.p50) || !Number.isFinite(report.p95)) {
  fail(`profile reported no measured statistics: ${profiler.stdout}`);
}
const samples = [report.p50, report.p95];
const record = baselineRecord({
  scenario, samples, commit, branch, device, maxRegressionPct: threshold,
});
writeFileSync(out, `${JSON.stringify(record, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
