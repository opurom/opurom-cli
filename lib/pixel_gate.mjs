// Golden pixel gate: manifest verification and threshold classification.
//
// Flutter authority (flutter-golden HEAD ab2912035e160d9cad6306df307576da6128ebdb,
// version 3.50.0 / flutter-3.50-candidate.0):
// - packages/flutter_test/lib/src/_goldens_io.dart:185,225-251 compares every
//   pixel strictly; a nonzero diff fails unless a custom comparator is set.
// - packages/flutter_test/lib/src/goldens.dart:133-189 defines the comparator
//   convention `result.passed || result.diffPercent <= tolerance`
//   (goldens.dart:178); _goldens_io.dart:255-259 prints diffPercent * 100.
//   The Opurom classifier accepts human-readable percentages (0..100) and
//   converts them to Flutter's 0..1 fraction before comparing.
// - Opurom ruling b86e87d / 946c41d (opurom-spec/PIXEL_GATE_CI_PROPOSAL.md:9-12):
//   Latin same-font <= 2%, CJK mixed same-font <= 12%, max_err reported only,
//   cross-font is N/A and must never be forced to pass.
//
// The gate here verifies that the golden set itself is intact and classifies
// a measured diff under those rules. It does not claim that a diff was run if
// no comparator supplied one; missing measurements are N/A, never PASS.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PIXEL_GATE } from './test_authority.mjs';

export const GOLDEN_RELATIVE_DIR = path.join('opurom-dist', 'flutter-golden-apk', 'screens');
export const GOLDEN_MANIFEST = path.join(GOLDEN_RELATIVE_DIR, 'manifest.json');

export function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

// Verify every manifest row against the bytes on disk. A golden that changed
// without a new signature is a FAIL and must block the gate.
export function verifyGoldenManifest({ root, dir = GOLDEN_RELATIVE_DIR } = {}) {
  const manifestFile = path.join(root, GOLDEN_MANIFEST);
  if (!existsSync(manifestFile)) {
    return { status: 'FAIL', reason: `golden manifest missing: ${manifestFile}`, rows: [] };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return { status: 'FAIL', reason: `invalid golden manifest: ${error.message}`, rows: [] };
  }
  const screens = manifest.screens;
  if (!Array.isArray(screens) || screens.length === 0) {
    return { status: 'FAIL', reason: 'golden manifest has no screens', rows: [] };
  }
  const rows = screens.map((screen) => {
    const file = path.join(root, dir, screen.file);
    if (!existsSync(file)) {
      return { file: screen.file, status: 'FAIL', reason: 'golden file missing' };
    }
    const bytes = readFileSync(file).length;
    const digest = sha256File(file);
    const byteOk = bytes === screen.bytes;
    const hashOk = digest === screen.sha256;
    return {
      file: screen.file,
      status: byteOk && hashOk ? 'PASS' : 'FAIL',
      bytes,
      expectedBytes: screen.bytes,
      sha256: digest,
      expectedSha256: screen.sha256,
      theme: screen.theme ?? null,
      reason: byteOk && hashOk ? null : 'golden bytes or sha256 drifted',
    };
  });
  const failed = rows.filter((row) => row.status === 'FAIL');
  return {
    status: failed.length ? 'FAIL' : 'PASS',
    reason: failed.length ? `${failed.length} golden files drifted` : null,
    rows,
  };
}

// Flutter's ComparisonResult (goldens.dart:258-273) carries passed/error/
// diffPercent/diffs. LocalComparisonOutput.generateFailureOutput
// (_goldens_io.dart:141-164) renders a mismatch as
//   `Golden "<uri>": <error>\nFailure feedback can be found at <basedir>/failures`
// and writes one PNG per diff key. Opurom keeps the same contract in JSON:
// every comparator row names its golden, its error and its diff artifact keys.
// A comparator result is only accepted when the font file is pinned to the
// same bytes in both the oracle and the candidate. Cross-font rows are N/A.
export function classifyPixelDiff({
  diffPercent, scriptClass = 'latin', sameFont = false, maxError = null,
  golden = null, diffArtifacts = null,
} = {}) {
  if (!sameFont) {
    return {
      status: 'N/A',
      threshold: null,
      reason: 'cross-font or unpinned font: comparison is not forced',
      diffPercent: Number.isFinite(diffPercent) ? diffPercent : null,
      maxError: Number.isFinite(maxError) ? maxError : null,
      maxErrorGated: false,
      golden, error: null, diffArtifacts: diffArtifacts ?? [],
    };
  }
  if (!Number.isFinite(diffPercent) || diffPercent < 0 || diffPercent > 100) {
    return {
      status: 'FAIL',
      threshold: null,
      reason: 'comparator supplied no valid diffPercent',
      diffPercent: Number.isFinite(diffPercent) ? diffPercent : null,
      maxError: Number.isFinite(maxError) ? maxError : null,
      maxErrorGated: false,
      golden, error: 'comparator supplied no valid diffPercent', diffArtifacts: diffArtifacts ?? [],
    };
  }
  const normalized = String(scriptClass).toLowerCase();
  const cjk = normalized === 'cjk' || normalized === 'cjk-mixed' || normalized === 'mixed';
  if (!cjk && normalized !== 'latin') {
    return {
      status: 'N/A',
      threshold: null,
      reason: `unsupported script class ${JSON.stringify(scriptClass)}`,
      diffPercent,
      maxError: Number.isFinite(maxError) ? maxError : null,
      maxErrorGated: false,
      golden, error: null, diffArtifacts: diffArtifacts ?? [],
    };
  }
  const threshold = cjk ? PIXEL_GATE.cjkDiffPct : PIXEL_GATE.latinDiffPct;
  // Flutter stores the fraction in ComparisonResult.diffPercent
  // (_goldens_io.dart:256) and its example comparator compares directly with a
  // 0..1 tolerance (goldens.dart:178). Accept the human-readable percent here
  // and convert to that fraction so the boundary matches Flutter exactly.
  const fraction = diffPercent / 100;
  const passed = fraction <= threshold / 100;
  const reason = passed ? null : `diff ${diffPercent}% exceeds ${threshold}%`;
  const result = {
    status: passed ? 'PASS' : 'FAIL',
    threshold,
    reason,
    diffPercent,
    maxError: Number.isFinite(maxError) ? maxError : null,
    // max_err is reported, never gated (PIXEL_GATE_CI_PROPOSAL.md:10-11).
    maxErrorGated: false,
    golden,
    error: passed ? null : `Golden "${golden ?? '<comparator>'}": ${reason ?? ''}`,
    diffArtifacts: diffArtifacts ?? [],
  };
  return result;
}

// A comparison row without a comparator measurement stays N/A. This is the
// anti-fake-door rule: a golden file's existence is not a pixel test result.
export function goldenComparisonRow(comparator = null) {
  if (!comparator) {
    return {
      status: 'N/A',
      reason: 'no comparator result supplied; golden files alone are not a pixel test',
    };
  }
  return classifyPixelDiff(comparator);
}
