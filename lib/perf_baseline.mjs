// Performance baseline comparison and regression gate.
//
// Flutter authority (flutter-golden HEAD ab2912035e160d9cad6306df307576da6128ebdb,
// version 3.50.0 / flutter-3.50-candidate.0):
// - dev/benchmarks/macrobenchmarks/test_driver/util.dart:38-70 collects real
//   Timeline samples and writes a JSON summary; it does not estimate numbers.
// - dev/devicelab/lib/framework/task_result.dart:106,132 defines score keys;
//   dev/devicelab/lib/framework/metrics_center.dart:75-89 tags each metric by
//   commit/branch/device before archiving it.
// - Opurom bench_suite.mjs:100-119 computes p50/p95 by nearest rank from
//   integer millisecond samples. This module reuses that contract for the
//   gate: a baseline is a signed JSON file, a comparison is measured samples,
//   and a regression above the threshold blocks CI.
import { existsSync, readFileSync } from 'node:fs';
import { PERF_GATE } from './test_authority.mjs';

export const PERF_BASELINE_SCHEMA = 'opurom.perf-baseline/v1';

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// Nearest-rank percentile, matching bench_suite.mjs:102-105 for p50/p95.
export function percentile(samples, percent) {
  if (!Array.isArray(samples) || samples.length === 0 || !samples.every(finite)) {
    throw new Error('perf gate needs an array of nonnegative finite samples');
  }
  if (!finite(percent) || percent <= 0 || percent > 100) {
    throw new Error(`invalid percentile: ${String(percent)}`);
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((percent / 100) * sorted.length);
  return sorted[Math.max(0, Math.min(sorted.length - 1, rank - 1))];
}

export function summarizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0 || !samples.every(finite)) {
    throw new Error('perf gate needs an array of nonnegative finite samples');
  }
  return {
    count: samples.length,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}

export function baselineRecord({
  scenario, samples, commit, branch = 'main', device = 'ci-linux',
  unit = 'ms', maxRegressionPct = PERF_GATE.maxRegressionPct,
}) {
  if (typeof scenario !== 'string' || !scenario.trim()) {
    throw new Error('baseline needs a scenario name');
  }
  if (typeof commit !== 'string' || !commit.trim()) {
    throw new Error('baseline needs a commit tag');
  }
  if (!finite(maxRegressionPct) || maxRegressionPct > 100) {
    throw new Error(`invalid maxRegressionPct: ${String(maxRegressionPct)}`);
  }
  return {
    schema: PERF_BASELINE_SCHEMA,
    scenario,
    unit,
    tags: { commit, branch, device },
    thresholds: { maxRegressionPct },
    summary: summarizeSamples(samples),
    samples: [...samples],
  };
}

export function readBaseline(file) {
  if (!existsSync(file)) throw new Error(`perf baseline missing: ${file}`);
  let record;
  try {
    record = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid perf baseline ${file}: ${error.message}`);
  }
  if (record?.schema !== PERF_BASELINE_SCHEMA || !record.summary
      || !finite(record.summary.p50) || !finite(record.summary.p95)) {
    throw new Error(`invalid perf baseline schema: ${file}`);
  }
  return record;
}

// A regression is measured against p95: it bounds the slow tail that causes
// visible jank. p50 is reported as supporting evidence. A measured p95 equal
// to the baseline passes; higher values are allowed only up to the threshold.
export function compareBaseline({ baseline, samples }) {
  const measured = summarizeSamples(samples);
  const maximumPct = finite(baseline.thresholds?.maxRegressionPct)
    ? baseline.thresholds.maxRegressionPct : PERF_GATE.maxRegressionPct;
  const baseP95 = baseline.summary.p95;
  const regressionPct = baseP95 === 0
    ? (measured.p95 === 0 ? 0 : 100)
    : ((measured.p95 - baseP95) / baseP95) * 100;
  const passed = regressionPct <= maximumPct;
  return {
    status: passed ? 'PASS' : 'FAIL',
    scenario: baseline.scenario ?? null,
    tags: baseline.tags ?? null,
    unit: baseline.unit ?? 'ms',
    baseline: { p50: baseline.summary.p50, p95: baseP95 },
    measured,
    regressionPct: Number(regressionPct.toFixed(4)),
    maxRegressionPct: maximumPct,
    reason: passed ? null
      : `p95 regression ${regressionPct.toFixed(2)}% exceeds ${maximumPct}%`,
  };
}

// A missing comparator measurement stays N/A; it must never be reported as PASS.
export function perfScenarioRow({ baseline, samples } = {}) {
  if (!baseline || !samples) {
    return { status: 'N/A', reason: 'no baseline or measured samples supplied' };
  }
  return compareBaseline({ baseline, samples });
}
