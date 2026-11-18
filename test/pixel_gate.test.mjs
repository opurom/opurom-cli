import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  GOLDEN_MANIFEST, classifyPixelDiff, goldenComparisonRow, sha256File, verifyGoldenManifest,
} from '../lib/pixel_gate.mjs';
import { PIXEL_GATE } from '../lib/test_authority.mjs';

function goldenWorkspace({ corrupt = false, omit = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'opurom-golden-gate-'));
  const dir = path.join(root, 'opurom-dist/flutter-golden-apk/screens');
  const file = path.join(dir, 'gallery-home.png');
  mkdirSync(dir, { recursive: true });
  const bytes = corrupt ? Buffer.from('changed golden bytes') : Buffer.from('golden bytes');
  if (!omit) writeFileSync(file, bytes);
  const manifest = {
    screens: [{
      file: 'gallery-home.png',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      theme: 'light',
    }],
  };
  writeFileSync(path.join(root, GOLDEN_MANIFEST), JSON.stringify(manifest));
  return root;
}

test('a golden set whose bytes and sha256 match passes', () => {
  const result = verifyGoldenManifest({ root: goldenWorkspace() });
  assert.equal(result.status, 'PASS');
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].theme, 'light');
});

test('a golden whose bytes drift is a FAIL with both values reported', () => {
  const root = goldenWorkspace();
  const file = path.join(root, 'opurom-dist/flutter-golden-apk/screens/gallery-home.png');
  writeFileSync(file, Buffer.from('changed golden bytes'));
  const result = verifyGoldenManifest({ root });
  assert.equal(result.status, 'FAIL');
  assert.match(result.reason, /1 golden files drifted/);
  assert.equal(result.rows[0].status, 'FAIL');
  assert.notEqual(result.rows[0].sha256, result.rows[0].expectedSha256);
});

test('a missing golden is a FAIL, never a silent skip', () => {
  const result = verifyGoldenManifest({ root: goldenWorkspace({ omit: true }) });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.rows[0].reason, 'golden file missing');
});

test('the threshold values match the ruling and Flutter comparator contract', () => {
  assert.equal(PIXEL_GATE.latinDiffPct, 2);
  assert.equal(PIXEL_GATE.cjkDiffPct, 12);
  assert.equal(PIXEL_GATE.crossFont, 'N/A');
});

test('Latin and CJK thresholds are applied only with the same font file', () => {
  const latin = classifyPixelDiff({ diffPercent: 2, scriptClass: 'latin', sameFont: true });
  assert.equal(latin.status, 'PASS');
  assert.equal(latin.threshold, 2);
  const latinFail = classifyPixelDiff({ diffPercent: 2.01, scriptClass: 'latin', sameFont: true });
  assert.equal(latinFail.status, 'FAIL');
  assert.equal(latinFail.maxErrorGated, false);
  const cjk = classifyPixelDiff({ diffPercent: 12, scriptClass: 'cjk-mixed', sameFont: true });
  assert.equal(cjk.status, 'PASS');
  assert.equal(cjk.threshold, 12);
  const cjkFail = classifyPixelDiff({ diffPercent: 12.01, scriptClass: 'cjk', sameFont: true });
  assert.equal(cjkFail.status, 'FAIL');
});

test('a cross-font comparison is N/A even when a diff percent is supplied', () => {
  const result = classifyPixelDiff({ diffPercent: 0, scriptClass: 'latin', sameFont: false });
  assert.equal(result.status, 'N/A');
  assert.equal(result.threshold, null);
  assert.match(result.reason, /cross-font/);
});

test('an invalid comparator result fails rather than passing', () => {
  const missing = classifyPixelDiff({ sameFont: true });
  assert.equal(missing.status, 'FAIL');
  assert.match(missing.reason, /no valid diffPercent/);
  const outOfRange = classifyPixelDiff({ diffPercent: 101, sameFont: true });
  assert.equal(outOfRange.status, 'FAIL');
});

test('golden files alone never count as a pixel test result', () => {
  const row = goldenComparisonRow(null);
  assert.equal(row.status, 'N/A');
  assert.match(row.reason, /golden files alone are not a pixel test/);
});

test('the local repository golden set is intact', () => {
  // CI checks out only opurom-cli; the golden images are deliberately kept in
  // the local aggregate workspace. Preserve the exact manifest contract here
  // and skip with the concrete reason when that workspace is absent.
  const root = path.resolve(new URL('../../', import.meta.url).pathname);
  if (!existsSync(path.join(root, GOLDEN_MANIFEST))) {
    return t.skip('aggregate workspace with Flutter Gallery goldens is not checked out');
  }
  const result = verifyGoldenManifest({ root });
  assert.equal(result.status, 'PASS', result.reason ?? '');
  assert.equal(result.rows.length, 22, '22 Flutter Gallery goldens must be pinned');
});
