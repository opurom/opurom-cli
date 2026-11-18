// Performance report aggregation and baseline/current comparison.
// Flutter authority (3.50.0, flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - dev/devicelab/lib/framework/task_result.dart:9-35,52-68 (TaskResult carries
//   benchmarkScoreKeys + a numeric data map; absent/invalid metrics are errors,
//   never a silent PASS)
// - dev/devicelab/lib/framework/metrics_center.dart:68-91 (each score key becomes
//   a MetricPoint with sub-result tags, so scores are compared key by key)
// - dev/devicelab/lib/framework/metrics_center.dart:152-163 (report file names
//   are derived from task/tag, i.e. reports are stable JSON artifacts)
// - packages/flutter_tools/lib/src/build_info.dart:436 (a performance
//   measurement file is an explicit artifact, not an inferred claim)
// Opurom adaptation: the module-eight gate pins maxRegressionPct = 10 and an
// explicit N/A marker (lib/test_authority.mjs:53-59). This library compares
// only numeric keys that exist in both reports; missing values are N/A.

import fs from 'node:fs';
import path from 'node:path';
import { PERF_GATE } from './test_authority.mjs';

export const PERF_COMPARE_SCHEMA = 'opurom.perf-compare/v1';

export function readPerfReport(file) {
  const resolved = path.resolve(String(file));
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(`cannot read performance report ${resolved}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid performance report JSON in ${resolved}: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`performance report must be a JSON object: ${resolved}`);
  }
  return { file: resolved, data: parsed };
}

// task_result.dart:20-35: benchmarkScoreKeys must name numeric values in data.
export function numericScores(report) {
  if (!report || typeof report !== 'object') return {};
  // readPerfReport wraps the JSON document in { file, data }; inline callers
  // pass the document directly.
  const document = report.data && typeof report.data === 'object' && !Array.isArray(report.data)
    && ('data' in report.data || 'benchmarkScoreKeys' in report.data)
    ? report.data : report;
  const data = document.data && typeof document.data === 'object' ? document.data : document;
  const keys = Array.isArray(document.benchmarkScoreKeys) && document.benchmarkScoreKeys.length
    ? document.benchmarkScoreKeys
    : Object.keys(data);
  const scores = {};
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'number' && Number.isFinite(value)) scores[String(key)] = value;
  }
  return scores;
}

function measure(baseline, current, maxRegressionPct) {
  if (baseline === undefined || current === undefined) {
    return { status: 'N/A', reason: 'missing score in baseline or current report' };
  }
  if (baseline === 0) {
    return current === 0
      ? { status: 'PASS', deltaPct: 0 }
      : { status: 'N/A', reason: 'baseline is zero; percentage regression is undefined' };
  }
  const deltaPct = ((current - baseline) / Math.abs(baseline)) * 100;
  const status = deltaPct > maxRegressionPct ? 'FAIL' : 'PASS';
  return {
    status,
    deltaPct,
    reason: status === 'FAIL'
      ? `${deltaPct.toFixed(2)}% regression exceeds ${maxRegressionPct}%`
      : null,
  };
}

export function comparePerf({
  baseline, current, maxRegressionPct = PERF_GATE.maxRegressionPct, keys = null,
} = {}) {
  if (!Number.isFinite(maxRegressionPct) || maxRegressionPct < 0) {
    throw new Error(`invalid maxRegressionPct: ${String(maxRegressionPct)}`);
  }
  const a = numericScores(baseline);
  const b = numericScores(current);
  const selected = Array.isArray(keys) && keys.length
    ? keys
    : [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const rows = selected.map((key) => {
    const result = measure(a[key], b[key], maxRegressionPct);
    return {
      key,
      baseline: a[key] ?? null,
      current: b[key] ?? null,
      ...result,
    };
  });
  const fail = rows.filter((row) => row.status === 'FAIL');
  const na = rows.filter((row) => row.status === 'N/A');
  const pass = rows.filter((row) => row.status === 'PASS');
  const status = fail.length ? 'FAIL' : pass.length ? 'PASS' : 'N/A';
  return {
    schema: PERF_COMPARE_SCHEMA,
    status,
    thresholdPct: maxRegressionPct,
    naMarker: PERF_GATE.naMarker,
    summary: {
      pass: pass.length,
      fail: fail.length,
      na: na.length,
      keys: rows.length,
    },
    rows,
    baselineFile: baseline?.file ?? null,
    currentFile: current?.file ?? null,
  };
}

export function formatPerfCompare(result) {
  const lines = [
    'Opurom performance comparison (measured scores only)',
    `schema: ${result.schema}`,
    `threshold: ${result.thresholdPct}% max regression`,
    `baseline: ${result.baselineFile ?? '(in-memory)'}`,
    `current: ${result.currentFile ?? '(in-memory)'}`,
  ];
  for (const row of result.rows) {
    const delta = row.deltaPct === undefined ? 'n/a'
      : `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct.toFixed(2)}%`;
    lines.push(`  ${row.status.padEnd(4)} ${row.key}: ${row.baseline ?? 'n/a'} -> ${row.current ?? 'n/a'} (${delta})${row.reason ? ` — ${row.reason}` : ''}`);
  }
  lines.push(`result: ${result.status} (${result.summary.pass} pass, ${result.summary.fail} fail, ${result.summary.na} N/A)`);
  if (!result.rows.length) lines.push(result.naMarker);
  if (result.status === 'N/A') lines.push(result.naMarker);
  return `${lines.join('\n')}\n`;
}

export function perfCompareJson(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

export function perfCompare({ baselineFile, currentFile, out = null, maxRegressionPct = PERF_GATE.maxRegressionPct, keys = null, log = console.log } = {}) {
  const baseline = readPerfReport(baselineFile);
  const current = readPerfReport(currentFile);
  const result = comparePerf({ baseline, current, maxRegressionPct, keys });
  if (out) fs.writeFileSync(path.resolve(out), perfCompareJson(result));
  log(perfCompareJson(result));
  return { result, exitCode: result.status === 'FAIL' ? 1 : 0 };
}
