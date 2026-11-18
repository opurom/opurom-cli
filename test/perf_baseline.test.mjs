import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PERF_BASELINE_SCHEMA, baselineRecord, compareBaseline, perfScenarioRow,
  percentile, readBaseline, summarizeSamples,
} from '../lib/perf_baseline.mjs';
import { PERF_GATE } from '../lib/test_authority.mjs';

test('nearest-rank percentiles match the bench suite contract', () => {
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([7], 95), 7);
  assert.deepEqual(summarizeSamples([4, 1, 3, 2]), {
    count: 4, p50: 2, p95: 4, min: 1, max: 4,
  });
});

test('invalid samples fail loudly instead of producing a fake number', () => {
  assert.throws(() => percentile([], 50), /nonnegative finite samples/);
  assert.throws(() => summarizeSamples([1, -1]), /nonnegative finite samples/);
  assert.throws(() => percentile([1], 0), /invalid percentile/);
});

test('a signed baseline carries commit, branch, device and threshold tags', () => {
  const record = baselineRecord({
    scenario: 'long-list-scroll', samples: [10, 12, 11, 13, 12],
    commit: 'abc', branch: 'main', device: 'ci-linux',
  });
  assert.equal(record.schema, PERF_BASELINE_SCHEMA);
  assert.deepEqual(record.tags, { commit: 'abc', branch: 'main', device: 'ci-linux' });
  assert.equal(record.thresholds.maxRegressionPct, PERF_GATE.maxRegressionPct);
  assert.equal(record.summary.p95, 13);
});

test('a baseline below the threshold passes and a larger regression fails', () => {
  const baseline = baselineRecord({
    scenario: 'shadow-render', samples: [100, 100, 100, 100],
    commit: 'abc', maxRegressionPct: 10,
  });
  const within = compareBaseline({ baseline, samples: [105, 105, 105, 105] });
  assert.equal(within.status, 'PASS');
  assert.equal(within.regressionPct, 5);
  const above = compareBaseline({ baseline, samples: [120, 120, 120, 120] });
  assert.equal(above.status, 'FAIL');
  assert.match(above.reason, /exceeds 10%/);
  assert.equal(above.measured.p95, 120);
});

test('a zero baseline p95 does not divide by zero', () => {
  const baseline = baselineRecord({
    scenario: 'empty-frame', samples: [0, 0], commit: 'abc',
  });
  const same = compareBaseline({ baseline, samples: [0, 0] });
  assert.equal(same.status, 'PASS');
  assert.equal(same.regressionPct, 0);
  const slower = compareBaseline({ baseline, samples: [1, 1] });
  assert.equal(slower.status, 'FAIL');
  assert.equal(slower.regressionPct, 100);
});

test('a missing or invalid baseline is rejected', () => {
  assert.throws(() => readBaseline('/tmp/opurom-no-such-baseline.json'), /baseline missing/);
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-perf-baseline-'));
  const file = path.join(dir, 'bad.json');
  writeFileSync(file, '{not json');
  assert.throws(() => readBaseline(file), /invalid perf baseline/);
  writeFileSync(file, JSON.stringify({ schema: 'wrong' }));
  assert.throws(() => readBaseline(file), /invalid perf baseline schema/);
});

test('a valid baseline round-trips through JSON and still gates', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-perf-roundtrip-'));
  const file = path.join(dir, 'baseline.json');
  const baseline = baselineRecord({
    scenario: 'page-switch', samples: [30, 32, 31, 29], commit: 'abc',
  });
  writeFileSync(file, JSON.stringify(baseline));
  const read = readBaseline(file);
  assert.equal(read.summary.p95, 32);
  assert.equal(compareBaseline({ baseline: read, samples: [33, 33] }).status, 'PASS');
});

test('a scenario without measured samples is N/A, never PASS', () => {
  const row = perfScenarioRow({});
  assert.equal(row.status, 'N/A');
  assert.match(row.reason, /no baseline or measured samples/);
});
