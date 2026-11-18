#!/usr/bin/env node
// Machine-readable gate for Flutter source provenance used by module-eight
// contract gates. It verifies pinned Flutter/engine commits and checks that
// each cited file:line range exists locally with the expected authority text.
//
// Exit 0 only when every citation resolves; every run prints one JSON doc.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKSPACE = path.resolve(CLI_ROOT, '..');
const ROOTS = [
  process.env.OPUROM_FLUTTER_SRC,
  path.join(WORKSPACE, 'flutter-golden'),
  path.join(WORKSPACE, 'toolchains', 'flutter'),
].filter(Boolean);

const FLUTTER_COMMIT = 'ab2912035e160d9cad6306df307576da6128ebdb';
const ENGINE_COMMIT = '371f77202a73e8dff57a8b3bff75bca55c090aee';

const CITATIONS = Object.freeze([
  {
    file: 'engine/src/flutter/flow/frame_timings.h', from: 35, to: 42,
    needle: 'kVsync', label: 'FrameTimingsRecorder state order',
  },
  {
    file: 'packages/flutter/lib/src/material/motion.dart', from: 28, to: 28,
    needle: 'static const Duration short1 = Duration(milliseconds: 50)',
    label: 'Material 3 short1 duration',
  },
  {
    file: 'packages/flutter/lib/src/material/motion.dart', from: 60, to: 60,
    needle: 'static const Duration medium1 = Duration(milliseconds: 250)',
    label: 'Material 3 medium1 duration',
  },
  {
    file: 'packages/flutter/lib/src/material/motion.dart', from: 192, to: 192,
    needle: 'static const Curve standard = Cubic(0.2, 0.0, 0.0, 1.0)',
    label: 'Material 3 standard easing',
  },
  {
    file: 'packages/flutter_test/lib/src/binding.dart', from: 1326, to: 1329,
    needle: '10 minutes for [AutomatedTestWidgetsFlutterBinding]',
    label: 'automated 10-minute timeout',
  },
  {
    file: 'packages/flutter_test/lib/src/binding.dart', from: 2345, to: 2349,
    needle: 'defaultTestTimeout = const test_package.Timeout(Duration(minutes: 10))',
    label: 'live/debug timeout override anchor',
  },
  {
    file: 'packages/flutter_test/lib/src/goldens.dart', from: 118, to: 119,
    needle: 'pixel-for-pixel comparison', label: 'default exact golden comparison',
  },
  {
    file: 'packages/flutter_test/lib/src/goldens.dart', from: 258, to: 273,
    needle: 'diffPercent', label: 'ComparisonResult fields',
  },
  {
    file: 'packages/flutter_test/lib/src/_goldens_io.dart', from: 141, to: 164,
    needle: 'generateFailureOutput', label: 'golden failure output',
  },
  {
    file: 'packages/flutter_test/lib/src/_goldens_io.dart', from: 255, to: 260,
    needle: 'diffPercent * 100', label: 'diffPercent percentage reporting',
  },
  {
    file: 'packages/flutter_test/lib/src/matchers.dart', from: 589, to: 589,
    needle: 'matchesGoldenFile', label: 'golden matcher entry point',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 29, to: 29,
    needle: 'kLongPressTimeout = Duration(milliseconds: 500)', label: 'long-press 500ms',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 35, to: 35,
    needle: 'kDoubleTapTimeout = Duration(milliseconds: 300)', label: 'double-tap 300ms',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 39, to: 39,
    needle: 'kDoubleTapMinTime = Duration(milliseconds: 40)', label: 'double-tap minimum 40ms',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 65, to: 65,
    needle: 'kTouchSlop = 18.0', label: 'touch slop 18px',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 76, to: 76,
    needle: 'kPanSlop = kTouchSlop * 2.0', label: 'pan slop 36px',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 80, to: 80,
    needle: 'kScaleSlop = kTouchSlop', label: 'scale slop 18px',
  },
  {
    file: 'dev/devicelab/lib/framework/task_result.dart', from: 106, to: 109,
    needle: 'benchmarkScoreKeys', label: 'score-key tags',
  },
  {
    file: 'dev/devicelab/lib/framework/metrics_center.dart', from: 75, to: 89,
    needle: 'kGithubRepoKey', label: 'machine-readable metric tags',
  },
  {
    file: 'dev/devicelab/lib/framework/metrics_center.dart', from: 103, to: 113,
    needle: 'metricsDestination.update', label: 'metrics archive write',
  },
  {
    file: 'dev/benchmarks/macrobenchmarks/test_driver/util.dart', from: 38, to: 70,
    needle: 'macroPerfTest', label: 'repeated real-frame benchmark',
  },
  {
    file: 'packages/flutter_test/lib/src/goldens.dart', from: 133, to: 189,
    needle: 'result.passed || result.diffPercent <= _precisionTolerance',
    label: 'custom comparator tolerance',
  },
  {
    file: 'packages/flutter_test/lib/src/_goldens_io.dart', from: 118, to: 129,
    needle: 'getGoldenBytes', label: 'missing golden failure path',
  },
  {
    file: 'packages/flutter_test/lib/src/_goldens_io.dart', from: 176, to: 214,
    needle: 'Future<ComparisonResult> compare', label: 'strict pixel comparator',
  },
  {
    file: 'packages/flutter_test/lib/src/binding.dart', from: 1070, to: 1070,
    needle: 'abstract class TestWidgetsFlutterBinding', label: 'base test binding',
  },
  {
    file: 'packages/flutter_test/lib/src/binding.dart', from: 2295, to: 2295,
    needle: 'class AutomatedTestWidgetsFlutterBinding', label: 'automated binding',
  },
  {
    file: 'packages/flutter_test/lib/src/binding.dart', from: 2800, to: 2800,
    needle: 'class LiveTestWidgetsFlutterBinding', label: 'live/debug binding',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 49, to: 49,
    needle: 'kDoubleTapSlop = 100.0', label: 'double-tap slop 100px',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 90, to: 90,
    needle: 'kMinFlingVelocity = 50.0', label: 'minimum fling velocity',
  },
  {
    file: 'packages/flutter/lib/src/gestures/constants.dart', from: 95, to: 95,
    needle: 'kMaxFlingVelocity = 8000.0', label: 'maximum fling velocity',
  },
  {
    file: 'dev/devicelab/lib/framework/task_result.dart', from: 132, to: 132,
    needle: 'Map<String, dynamic> toJson()', label: 'task result JSON schema',
  },
]);

function gitHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function findRoot() {
  for (const root of ROOTS) {
    if (!existsSync(path.join(root, 'packages', 'flutter_test', 'lib', 'src', 'binding.dart'))) continue;
    return root;
  }
  return null;
}

const root = findRoot();
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

let flutterHead = null;
let engineHead = null;
check('a local pinned Flutter source tree is available', () => {
  assert.ok(root, `Flutter source tree not found; checked: ${ROOTS.join(', ')}`);
  flutterHead = gitHead(root);
  const engineVersionFile = path.join(root, 'bin', 'internal', 'engine.version');
  engineHead = existsSync(engineVersionFile) ? readFileSync(engineVersionFile, 'utf8').trim() : gitHead(path.join(root, 'engine'));
  assert.equal(flutterHead, FLUTTER_COMMIT, `flutter HEAD ${flutterHead} != ${FLUTTER_COMMIT}`);
  assert.equal(engineHead, ENGINE_COMMIT, `engine HEAD ${engineHead} != ${ENGINE_COMMIT}`);
});

for (const citation of CITATIONS) {
  check(`${citation.file}:${citation.from}-${citation.to} — ${citation.label}`, () => {
    assert.ok(root, 'Flutter source tree is required');
    const file = path.join(root, citation.file);
    assert.ok(existsSync(file), `missing source file ${file}`);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    assert.ok(citation.to <= lines.length,
      `line ${citation.to} past EOF (${lines.length} lines)`);
    const excerpt = lines.slice(citation.from - 1, citation.to).join('\n');
    assert.ok(excerpt.includes(citation.needle),
      `expected ${JSON.stringify(citation.needle)} in lines ${citation.from}-${citation.to}`);
  });
}

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.flutter-provenance-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    channel: 'flutter-3.50-candidate.0',
    goldenCommit: FLUTTER_COMMIT,
    engineCommit: ENGINE_COMMIT,
    sourceRoot: root,
    head: flutterHead,
    engineHead,
  },
  contract: {
    citationCount: CITATIONS.length,
    citations: CITATIONS.map(({ file, from, to, label }) => ({ file, from, to, label })),
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
