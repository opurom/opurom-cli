// Test-report archive for the module-eight gate. The schema follows the
// minimal Flutter devicelab chain: score keys -> tags -> JSON archive.
// Flutter authority: flutter-golden HEAD ab2912035e160... (3.50.0),
// dev/devicelab/lib/framework/task_result.dart:106/132 and
// dev/devicelab/lib/framework/metrics_center.dart:75-89/103-113.
// No Flutter object model is copied; Opurom reports carry IR golden digests,
// gesture fingerprints and performance samples as plain deterministic JSON.
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { perfScenarioRow, readBaseline } from './perf_baseline.mjs';
import { FLUTTER_VERSION, GESTURE_CONSTANTS, PERF_GATE, PIXEL_GATE } from './test_authority.mjs';

const SCHEMA = 'opurom.test-report/v1';
const ARCHIVE_DIR = path.join('artifacts', 'test-reports');

const GESTURE_CONSTANTS_SUMMARY = Object.freeze({
  touchSlopPx: GESTURE_CONSTANTS.touchSlopPx,
  panSlopPx: GESTURE_CONSTANTS.panSlopPx,
  scaleSlopPx: GESTURE_CONSTANTS.scaleSlopPx,
  doubleTapSlopPx: GESTURE_CONSTANTS.doubleTapSlopPx,
  longPressTimeoutMs: GESTURE_CONSTANTS.longPressTimeoutMs,
  longPressTimeoutMs: GESTURE_CONSTANTS.longPressTimeoutMs,
  doubleTapTimeoutMs: GESTURE_CONSTANTS.doubleTapTimeoutMs,
  doubleTapMinTimeMs: GESTURE_CONSTANTS.doubleTapMinTimeMs,
  doubleTapSlopPx: GESTURE_CONSTANTS.doubleTapSlopPx,
  minFlingVelocity: GESTURE_CONSTANTS.minFlingVelocity,
  maxFlingVelocity: GESTURE_CONSTANTS.maxFlingVelocity,
});

function gitMeta(root) {
  const git = (args) => {
    if (!existsSync(path.join(root, '.git'))) return 'unknown';
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return 'unknown';
    }
  };
  return { commit: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']) };
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function fixture(file) {
  if (!existsSync(file)) return { data: null, error: null };
  try {
    return { data: readJson(file), error: null };
  } catch (error) {
    return { data: null, error: error.message };
  }
}

function result(name, status, detail, reason = null) {
  return reason === null ? { name, status, detail } : { name, status, detail, reason };
}

function summarizeResults(rows) {
  const counts = { PASS: 0, FAIL: 0, SKIP: 0, N_A: 0, UPDATED: 0 };
  for (const row of rows) {
    const raw = String(row.status ?? '').toUpperCase();
    const status = raw === 'N/A' ? 'N_A' : raw.replaceAll(/[^A-Z]/g, '_');
    if (status in counts) counts[status] += 1;
    else counts.FAIL += 1;
  }
  return counts;
}

// The gesture authority is the Rust engine under opurom-render, but this
// report only records provenance; numeric drift is a FAIL for the cargo test
// that reads the signed constants, never a PASS inferred from a source comment.
function gestureProvenance(root) {
  const file = path.join(root, 'opurom-render', 'src', 'gestures.rs');
  if (!existsSync(file)) return { status: 'N/A', reason: 'opurom-render not present in this checkout' };
  const source = readFileSync(file, 'utf8');
  const has = (needle) => source.includes(needle);
  return {
    status: has('constants.dart:65') && has('arena.dart:157') ? 'N/A' : 'FAIL',
    checks: {
      longPressTimeoutMs: has('constants.dart:29'),
      doubleTapTimeoutMs: has('constants.dart:35'),
      touchSlopPx: has('constants.dart:65'),
      scaleSlopPx: has('constants.dart:80'),
      arenaSweep: has('arena.dart:157'),
    },
  };
}

function pixelProvenance(root) {
  const proposals = [
    'opurom-spec/PIXEL_GATE_CI_PROPOSAL.md',
    'opurom-ui/test/state-digests.test.mjs',
    'opurom-examples/apps/gallery/pixel-parity.test.mjs',
  ].map((rel) => ({ file: rel, present: existsSync(path.join(root, rel)) }));
  const status = proposals.every((row) => row.present) ? 'N/A' : 'FAIL';
  return {
    status,
    threshold: PIXEL_GATE,
    crossFont: PIXEL_GATE.crossFont,
    sources: proposals,
  };
}

function perfProvenance(root) {
  const file = path.join(root, 'opurom-cli', 'test', 'bench_gate.test.mjs');
  // The guard stores the marker as a RegExp literal; check for that marker's
  // distinctive tail and the escaped N/A form in the source.
  const markerTail = 'performance benchmark, run locally';
  const source = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const status = source.includes(markerTail) && /N\\\/A/.test(source) ? 'N/A' : 'FAIL';
  // N/A is a declared deferral, not a failure; archived reports must still exit 0.
  return { status, naMarker: PERF_GATE.naMarker, maxRegressionPct: PERF_GATE.maxRegressionPct };
}

function suiteProvenance(root) {
  const suites = [
    ['unit', ['opurom-render/tests/incremental_pipeline.rs', 'opurom-render/src/gestures.rs']],
    ['component', ['opurom-ui/test/state-digests.test.mjs']],
    ['integration', ['opurom-examples/test/cross-layer.mjs', 'opurom-cli/lib/e2e.mjs']],
    ['gesture', ['opurom-render/tests/scale_gesture.rs', 'opurom-render/src/gestures.rs']],
    ['pixel', ['opurom-examples/apps/gallery/pixel-parity.test.mjs']],
    ['performance', ['opurom-cli/test/bench_suite.test.mjs', 'opurom-cli/lib/bench_suite.mjs']],
  ];
  return suites.map(([name, candidates]) => {
    const present = candidates.filter((rel) => existsSync(path.join(root, rel)));
    const status = present.length ? 'N/A' : 'FAIL';
    return { name, file: present.join(', ') || candidates.join(', '), status };
  });
}

function eightStateRow(fixtureResult) {
  if (fixtureResult.error) return result('component:eight-state', 'FAIL', 'state-digests.json', `invalid fixture: ${fixtureResult.error}`);
  if (!fixtureResult.data) {
    return result('component:eight-state', 'N/A', 'state-digests.json',
      'opurom-ui sibling fixture is not checked out in this repository');
  }
  const data = fixtureResult.data;
  if (!Array.isArray(data.pins) || data.pins.length === 0
      || data.meta?.states?.length !== 8) {
    return result('component:eight-state', 'FAIL', 'state-digests.json', 'missing pins or eight states');
  }
  const components = new Set(data.pins.map((pin) => String(pin.name ?? '').slice(0, String(pin.name ?? '').lastIndexOf('-'))));
  return result('component:eight-state', 'PASS', `${data.pins.length} pins, ${components.size} components`);
}

function exampleRegistryRow(fixtureResult) {
  if (fixtureResult.error) return result('integration:example-registry', 'FAIL', 'examples.json', `invalid registry: ${fixtureResult.error}`);
  if (!fixtureResult.data) {
    return result('integration:example-registry', 'N/A', 'examples.json',
      'opurom-examples sibling registry is not checked out in this repository');
  }
  const apps = fixtureResult.data.apps;
  if (!Array.isArray(apps) || apps.length === 0) {
    return result('integration:example-registry', 'FAIL', 'examples.json', 'no registered apps');
  }
  const tests = apps.reduce((count, app) => count + (Array.isArray(app.tests) ? app.tests.length : 0), 0);
  return result('integration:example-registry', 'PASS', `${apps.length} apps, ${tests} tests`);
}

function interactionScriptRow(fixtureResult) {
  if (fixtureResult.error) return result('gesture:interaction-script', 'FAIL', 'counter.wtest.json', `invalid script: ${fixtureResult.error}`);
  if (!fixtureResult.data) {
    return result('gesture:interaction-script', 'N/A', 'counter.wtest.json',
      'opurom-examples sibling script is not checked out in this repository');
  }
  return result('gesture:interaction-script', 'PASS', 'tap/input/tick declarative script');
}

function performanceBaselineRow(root) {
  const file = process.env.OPUROM_PERF_BASELINE;
  if (!file) {
    return result('performance:baseline', 'N/A', 'not configured',
      'set OPUROM_PERF_BASELINE to a signed baseline JSON path');
  }
  try {
    const baseline = readBaseline(file);
    const abspath = path.isAbsolute(file) ? file : path.join(root, file);
    const samplesEnv = process.env.OPUROM_PERF_SAMPLES;
    const samples = samplesEnv
      ? String(samplesEnv).split(',').map((value) => Number(value.trim())).filter((value) => Number.isFinite(value) && value >= 0)
      : null;
    const comparison = perfScenarioRow({ baseline, samples });
    return result('performance:baseline', comparison.status,
      comparison.status === 'N/A' ? abspath : `${comparison.regressionPct}% p95 drift`,
      comparison.reason);
  } catch (error) {
    return result('performance:baseline', 'FAIL', file, `invalid baseline: ${error.message}`);
  }
}

// One row per capability family. Status is computed, never hard-coded PASS.
export function buildReport({ root, executed = [], phase = 'module-8-gate' } = {}) {
  const uiState = fixture(path.join(root, 'opurom-ui', 'test', 'state-digests.json'));
  const manifest = fixture(path.join(root, 'opurom-examples', 'examples.json'));
  const swipe = fixture(path.join(root, 'opurom-examples', 'test', 'interaction', 'counter.wtest.json'));
  const suites = suiteProvenance(root);
  const gesture = gestureProvenance(root);
  const pixel = pixelProvenance(root);
  const perf = perfProvenance(root);
  const rows = [
    ...suites.map((suite) => result(`provenance:${suite.name}`, suite.status, suite.file,
      suite.status === 'N/A'
        ? 'source files only; no test was executed by --report'
        : 'required test source missing from this checkout')),
    result('provenance:gesture-thresholds', gesture.status, GESTURE_CONSTANTS_SUMMARY,
      gesture.status === 'N/A'
        ? 'comment-only provenance; actual constants are verified by cargo test'
        : 'Flutter authority markers missing from opurom-render'),
    result('provenance:pixel-threshold', pixel.status, `${PIXEL_GATE.latinDiffPct}% Latin / ${PIXEL_GATE.cjkDiffPct}% CJK / cross-font N/A`,
      pixel.status === 'N/A'
        ? 'threshold contract; --report does not execute a Flutter oracle'
        : 'pixel gate source missing'),
    result('provenance:performance-archival', perf.status, perf.naMarker,
      perf.status === 'N/A' ? 'performance samples are opt-in locally' : 'N/A guard source missing'),
    performanceBaselineRow(root),
    eightStateRow(uiState),
    exampleRegistryRow(manifest),
    interactionScriptRow(swipe),
    ...executed,
  ];
  const meta = gitMeta(root);
  return {
    schema: SCHEMA,
    phase,
    generatedBy: 'opurom-cli test --report',
    toolchain: { flutter: FLUTTER_VERSION, opurom: meta },
    thresholds: { gesture: GESTURE_CONSTANTS_SUMMARY, pixel: PIXEL_GATE, performance: PERF_GATE },
    rows,
    summary: summarizeResults(rows),
  };
}

export function reportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function archiveReport(report, { root, dir = ARCHIVE_DIR, stamp } = {}) {
  const when = stamp ?? new Date().toISOString().replaceAll(':', '-');
  const base = path.isAbsolute(dir) ? '' : root;
  const target = path.join(base, dir, `${when}.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, reportJson(report));
  return target;
}

export function readArchivedReport(file) {
  const report = JSON.parse(readFileSync(file, 'utf8'));
  if (report?.schema !== SCHEMA || !report.summary
      || !Number.isSafeInteger(report.summary.FAIL)) {
    throw new Error(`invalid test report: ${file}`);
  }
  return report;
}

export function latestReport(root, dir = ARCHIVE_DIR) {
  const base = path.isAbsolute(dir) ? '' : root;
  const folder = path.join(base, dir);
  if (!existsSync(folder)) return null;
  const files = readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(folder, name))
    .filter((file) => statSync(file).isFile())
    .sort();
  return files.length ? files.at(-1) : null;
}
