#!/usr/bin/env node
// Machine-readable gate for the golden failure-output contract.
//
// Quality-gate layer only: it imports Opurom's existing pixel gate but does
// not modify that implementation. Flutter authority (3.50.0, flutter-golden
// ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_test/lib/src/goldens.dart:118-119 — default comparison is
//   exact; :258-273 defines passed/error/diffPercent/diffs.
// - packages/flutter_test/lib/src/_goldens_io.dart:141-164 — mismatch output
//   names the golden and writes one PNG per diff key; :185/225-251 strict
//   pixel comparator; :255-259 prints `diffPercent * 100`.
// - packages/flutter_test/lib/src/matchers.dart:589 — golden matcher entry.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { classifyPixelDiff, goldenComparisonRow } from '../lib/pixel_gate.mjs';

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

check('default exact-match semantics are preserved by the comparator contract', () => {
  const exact = classifyPixelDiff({
    diffPercent: 0, sameFont: true, scriptClass: 'latin',
    golden: 'counter.png', diffArtifacts: [],
  });
  assert.equal(exact.status, 'PASS');
  assert.equal(exact.threshold, 2); // Opurom's declared tolerance, not Flutter default.
  assert.equal(exact.maxErrorGated, false);
  const fake = goldenComparisonRow(null);
  assert.equal(fake.status, 'N/A');
  assert.match(fake.reason, /not a pixel test/);
});

check('comparator rows carry golden, error text and diff artifact keys', () => {
  const row = classifyPixelDiff({
    diffPercent: 4, sameFont: true, scriptClass: 'latin', maxError: 255,
    golden: 'counter.png', diffArtifacts: ['counter-mask.png', 'counter-io.png'],
  });
  assert.equal(row.status, 'FAIL');
  assert.equal(row.golden, 'counter.png');
  assert.match(row.error, /^Golden "counter\.png": diff 4% exceeds 2%$/);
  assert.deepEqual(row.diffArtifacts, ['counter-mask.png', 'counter-io.png']);
  assert.equal(row.maxError, 255);
  assert.equal(row.maxErrorGated, false, 'max_err must be reported, never gated');
});

check('Flutter 0..1 diffPercent maps to Opurom 0..100 percent without boundary drift', () => {
  const boundary = classifyPixelDiff({ diffPercent: 2, sameFont: true, scriptClass: 'latin' });
  const over = classifyPixelDiff({ diffPercent: 2.01, sameFont: true, scriptClass: 'latin' });
  assert.equal(boundary.status, 'PASS');
  assert.equal(over.status, 'FAIL');
  // Flutter's printed `diffPercent * 100` must land on the Opurom input scale.
  const flutterFraction = 0.0201;
  const humanPercent = flutterFraction * 100;
  const converted = classifyPixelDiff({ diffPercent: humanPercent, sameFont: true, scriptClass: 'latin' });
  assert.equal(converted.status, 'FAIL');
  assert.ok(Math.abs(converted.diffPercent - humanPercent) < 1e-9);
});

check('invalid comparator measurements fail closed and cross-font stays N/A', () => {
  const invalid = classifyPixelDiff({ diffPercent: NaN, sameFont: true, scriptClass: 'latin', golden: 'x.png' });
  assert.equal(invalid.status, 'FAIL');
  assert.equal(invalid.golden, 'x.png');
  assert.match(invalid.error, /no valid diffPercent/);
  assert.deepEqual(invalid.diffArtifacts, []);
  const crossFont = classifyPixelDiff({ diffPercent: 4, sameFont: false, golden: 'x.png' });
  assert.equal(crossFont.status, 'N/A');
  assert.equal(crossFont.error, null);
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.golden-failure-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    channel: 'flutter-3.50-candidate.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: [
      'packages/flutter_test/lib/src/goldens.dart:118-119/258-273',
      'packages/flutter_test/lib/src/_goldens_io.dart:141-164/185/225-251/255-259',
      'packages/flutter_test/lib/src/matchers.dart:589',
    ],
  },
  contract: {
    defaultComparison: 'exact',
    comparatorFields: ['passed', 'error', 'diffPercent', 'diffs'],
    opuromFailureFields: ['golden', 'error', 'diffArtifacts'],
    maxErrorGated: false,
    implementation: 'opurom-cli/lib/pixel_gate.mjs (read-only from this gate)',
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
