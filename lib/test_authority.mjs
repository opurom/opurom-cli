// Source-derived test constants for the module-eight gate.
//
// Flutter authority (single source of truth): flutter-golden HEAD
// ab2912035e160d9cad6306df307576da6128ebdb, version 3.50.0 /
// flutter-3.50-candidate.0 (2026-11-09), files relative to the SDK root:
// - packages/flutter/lib/src/gestures/constants.dart:65 kTouchSlop = 18,
//   :76 kPanSlop = 36, :80 kScaleSlop = 18, :49 kDoubleTapSlop = 100,
//   :29 kLongPressTimeout = 500ms, :35 kDoubleTapTimeout = 300ms,
//   :39 kDoubleTapMinTime = 40ms, :90 kMinFlingVelocity = 50,
//   :95 kMaxFlingVelocity = 8000.
// - packages/flutter/lib/src/gestures/arena.dart:59-69 arena state,
//   :157/:173 sweep (first member wins).
// - packages/flutter_test/lib/src/_goldens_io.dart:225-251 default pixel
//   comparison is strict: any diffPixel != 0 fails (:237).
// - packages/flutter_test/lib/src/goldens.dart:133-189 tolerance is only a
//   custom comparator convention (diffPercent <= tolerance), never a built-in.
// - dev/devicelab/lib/framework/task_result.dart:106/132 score keys and JSON
//   schema; dev/devicelab/lib/framework/metrics_center.dart:75-89/103-113
//   tags measurements by commit/branch/device then archives JSON.
//
// Opurom adaptation: no Flutter widget/element object model is imported; the
// constants feed a pure report classifier, so the gate remains deterministic
// and does not depend on a host clock or renderer backend.

export const FLUTTER_VERSION = Object.freeze({
  version: '3.50.0',
  channel: 'flutter-3.50-candidate.0',
  commit: 'ab2912035e160d9cad6306df307576da6128ebdb',
  date: '2026-11-09',
});

export const GESTURE_CONSTANTS = Object.freeze({
  touchSlopPx: 18,
  panSlopPx: 36,
  scaleSlopPx: 18,
  doubleTapSlopPx: 100,
  longPressTimeoutMs: 500,
  doubleTapTimeoutMs: 300,
  doubleTapMinTimeMs: 40,
  minFlingVelocity: 50,
  maxFlingVelocity: 8000,
});

// Chief ruling b86e87d / 946c41d, mirrored in opurom-spec/PIXEL_GATE_CI_PROPOSAL.md:9-12.
// Flutter's own comparator is zero-tolerance; the Opurom thresholds are a
// custom-comparator contract and only apply when the same font file is pinned.
export const PIXEL_GATE = Object.freeze({
  latinDiffPct: 2,
  cjkDiffPct: 12,
  metricsPx: 1,
  crossFont: 'N/A',
});

export const PERF_GATE = Object.freeze({
  // Benchmark samples are opt-in locally; CI must report N/A rather than fake
  // a pass. Mirrors opurom-cli/test/bench_gate.test.mjs:12.
  naMarker: 'N/A - performance benchmark, run locally (OPUROM_BENCH_LOCAL=1)',
  maxRegressionPct: 10,
});
