// perf compare tests. Flutter authority:
// - dev/devicelab/lib/framework/task_result.dart:9-35,52-68
// - dev/devicelab/lib/framework/metrics_center.dart:68-91,152-163
// - lib/test_authority.mjs:53-59 (Opurom maxRegressionPct=10, explicit N/A marker)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import {
  comparePerf, formatPerfCompare, numericScores, perfCompare, perfCompareJson,
  PERF_COMPARE_SCHEMA, readPerfReport,
} from '../lib/perf_compare.mjs';
import { PERF_GATE } from '../lib/test_authority.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

function write(dir, name, data) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

test('numericScores uses benchmarkScoreKeys and ignores non-numeric values', () => {
  const report = {
    data: { frameMs: 12.5, wrong: 'n/a', nullValue: null, other: 3 },
    benchmarkScoreKeys: ['frameMs', 'wrong', 'nullValue'],
  };
  assert.deepEqual(numericScores(report), { frameMs: 12.5 });
  assert.deepEqual(numericScores({ frameMs: 1, wrong: false }), { frameMs: 1 });
});

test('comparePerf passes improvements and fails regressions beyond ten percent', () => {
  const result = comparePerf({
    baseline: { file: 'base.json', data: { scroll: 100, build: 50 } },
    current: { file: 'cur.json', data: { scroll: 120, build: 45 } },
  });
  assert.equal(result.schema, PERF_COMPARE_SCHEMA);
  assert.equal(result.status, 'FAIL');
  assert.equal(result.thresholdPct, 10);
  assert.equal(result.summary.fail, 1);
  assert.equal(result.summary.pass, 1);
  const scroll = result.rows.find((row) => row.key === 'scroll');
  assert.equal(scroll.status, 'FAIL');
  assert.equal(scroll.deltaPct, 20);
  assert.match(formatPerfCompare(result), /FAIL scroll: 100 -> 120 \(\+20\.00%\)/);
  assert.match(formatPerfCompare(result), /result: FAIL \(1 pass, 1 fail, 0 N\/A\)/);
});

test('comparePerf marks missing and zero-baseline metrics N/A with reasons', () => {
  const result = comparePerf({
    baseline: { data: { zero: 0, known: 10 } },
    current: { data: { zero: 5, extra: 7 } },
  });
  assert.equal(result.status, 'N/A');
  const zero = result.rows.find((row) => row.key === 'zero');
  const known = result.rows.find((row) => row.key === 'known');
  const extra = result.rows.find((row) => row.key === 'extra');
  assert.equal(zero.status, 'N/A');
  assert.match(zero.reason, /baseline is zero/);
  assert.equal(known.status, 'N/A');
  assert.equal(extra.status, 'N/A');
  assert.equal(result.summary.na, 3);
  assert.match(formatPerfCompare(result), new RegExp(PERF_GATE.naMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('zero to zero is a real pass and custom thresholds are enforced', () => {
  const zero = comparePerf({ baseline: { data: { x: 0 } }, current: { data: { x: 0 } } });
  assert.equal(zero.status, 'PASS');
  assert.equal(zero.rows[0].deltaPct, 0);
  const strict = comparePerf({
    baseline: { data: { x: 100 } }, current: { data: { x: 103 } }, maxRegressionPct: 2,
  });
  assert.equal(strict.status, 'FAIL');
  assert.throws(() => comparePerf({ maxRegressionPct: -1 }), /invalid maxRegressionPct/);
});

test('perf compare CLI writes JSON and exits 1 on regression', () => {
  const base = tmpDir('perf-compare-');
  try {
    const baselineFile = write(base, 'baseline.json', {
      benchmarkScoreKeys: ['frameMs'], data: { frameMs: 10 },
    });
    const goodFile = write(base, 'good.json', {
      benchmarkScoreKeys: ['frameMs'], data: { frameMs: 11 },
    });
    const badFile = write(base, 'bad.json', {
      benchmarkScoreKeys: ['frameMs'], data: { frameMs: 20 },
    });
    const out = path.join(base, 'report.json');
    const good = run(process.execPath, [CLI, 'perf', 'compare', '--baseline', baselineFile, '--current', goodFile, '--out', out]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).status, 'PASS');
    const bad = run(process.execPath, [CLI, 'perf', 'compare', '--baseline', baselineFile, '--current', badFile]);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).status, 'FAIL');
    const missing = run(process.execPath, [CLI, 'perf', 'compare', '--baseline', baselineFile]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--current/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('readPerfReport and perfCompare surface malformed files with clear errors', () => {
  const base = tmpDir('perf-compare-errors-');
  try {
    const bad = path.join(base, 'bad.json');
    fs.writeFileSync(bad, '{not json');
    assert.throws(() => readPerfReport(bad), /invalid performance report JSON/);
    assert.throws(() => readPerfReport(path.join(base, 'absent.json')), /cannot read performance report/);
    const ok = write(base, 'ok.json', { data: { x: 1 } });
    const lines = [];
    const result = perfCompare({ baselineFile: ok, currentFile: ok, log: (line) => lines.push(String(line)) });
    assert.equal(result.exitCode, 0);
    assert.equal(JSON.parse(lines.join('\n')).schema, PERF_COMPARE_SCHEMA);
    assert.match(perfCompareJson(result.result), /"schema": "opurom\.perf-compare\/v1"/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
