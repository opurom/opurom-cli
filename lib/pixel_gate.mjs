// Golden pixel gate: manifest verification and threshold classification.
//
// Flutter authority (flutter-golden HEAD ab2912035e160d9cad6306df307576da6128ebdb,
// version 3.50.0 / flutter-3.50-candidate.0):
// - packages/flutter_test/lib/src/_goldens_io.dart:185,225-251 compares every
//   pixel strictly; a nonzero diff fails unless a custom comparator is set.
// - packages/flutter_test/lib/src/goldens.dart:133-189 defines the comparator
//   convention `diffPercent <= tolerance`.
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

// A comparator result is only accepted when the font file is pinned to the
// same bytes in both the oracle and the candidate. Cross-font rows are N/A.
export function classifyPixelDiff({
  diffPercent, scriptClass = 'latin', sameFont = false, maxError = null,
} = {}) {
  if (!sameFont) {
    return {
      status: 'N/A',
      threshold: null,
      reason: 'cross-font or unpinned font: comparison is not forced',
      diffPercent: Number.isFinite(diffPercent) ? diffPercent : null,
      maxError: Number.isFinite(maxError) ? maxError : null,
      maxErrorGated: false,
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
    };
  }
  const threshold = cjk ? PIXEL_GATE.cjkDiffPct : PIXEL_GATE.latinDiffPct;
  const passed = diffPercent <= threshold;
  const result = {
    status: passed ? 'PASS' : 'FAIL',
    threshold,
    reason: passed ? null : `diff ${diffPercent}% exceeds ${threshold}%`,
    diffPercent,
    maxError: Number.isFinite(maxError) ? maxError : null,
    // max_err is reported, never gated (PIXEL_GATE_CI_PROPOSAL.md:10-11).
    maxErrorGated: false,
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
