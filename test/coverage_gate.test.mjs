import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_MIN_LINE_PERCENT, coverageDecision, parseCoverageReport, runCoverage,
} from '../lib/coverage_gate.mjs';

const SPEC_REPORT = [
  'file                 | line % | branch % | funcs % | uncovered lines',
  ' opurom.mjs          |  79.24 |    15.49 |  100.00 | 125 174 187-190',
  ' args.mjs            | 100.00 |   100.00 |   100.00 | ',
  ' all files            |  84.42 |    78.27 |   88.84 | ',
].join('\n');

const TAP_REPORT = [
  '# file                 | line % | branch % | funcs % | uncovered lines',
  '# opurom.mjs          |  79.24 |    15.49 |  100.00 | 125 174',
  '# all files            |  84.42 |    78.27 |   88.84 | ',
].join('\n');

test('the spec and TAP reports parse to the same rows', () => {
  const spec = parseCoverageReport(SPEC_REPORT);
  const tap = parseCoverageReport(TAP_REPORT);
  assert.equal(spec.files.length, 2);
  assert.equal(spec.all.line, 84.42);
  assert.equal(spec.all.branch, 78.27);
  assert.equal(spec.all.functions, 88.84);
  assert.equal(spec.files[0].file, 'opurom.mjs');
  assert.equal(spec.files[0].line, 79.24);
  assert.deepEqual(spec.files[0].uncovered, ['125', '174', '187-190']);
  assert.equal(tap.all.line, 84.42);
  assert.equal(tap.files[0].file, 'opurom.mjs');
});

test('a report without repository-owned rows is a FAIL, not a silent pass', () => {
  const report = parseCoverageReport('.. | | | |\n sibling.mjs | 90.00 | 90.00 | 90.00 |');
  const decision = coverageDecision({ report, min: 80 });
  assert.equal(decision.status, 'FAIL');
  assert.match(decision.reason, /no repository-owned files/);
  assert.equal(decision.measured, null);
});

test('the gate passes when the total coverage clears the threshold', () => {
  const report = parseCoverageReport(SPEC_REPORT);
  const decision = coverageDecision({ report, min: DEFAULT_MIN_LINE_PERCENT });
  assert.equal(decision.status, 'PASS');
  assert.equal(decision.measured, 89.62, 'the gate averages repository-owned files');
  assert.equal(decision.reason, null);
});

test('the gate fails when the total coverage drops below the threshold', () => {
  const report = parseCoverageReport(SPEC_REPORT);
  const decision = coverageDecision({ report, min: 90 });
  assert.equal(decision.status, 'FAIL');
  assert.match(decision.reason, /below the 90% gate/);
  assert.deepEqual(decision.below.map((row) => row.file), ['opurom.mjs']);
});

test('a scoped gate averages only the files of that scope', () => {
  const report = parseCoverageReport(SPEC_REPORT);
  const scoped = coverageDecision({ report, min: 95, scope: 'args' });
  assert.equal(scoped.scopeMean, 100);
  assert.equal(scoped.status, 'FAIL', 'the total is still below 95%');
  const wide = coverageDecision({ report, min: 80, scope: 'args' });
  assert.equal(wide.status, 'PASS');
});

test('the coverage run reports a measurable total for the repository', () => {
  // The suite is not re-run here: the repository-wide measurement is the
  // `opurom test --coverage` command, which CI runs as its own gate. This
  // test only proves the runner yields a parseable report for a tiny project.
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-coverage-'));
  writeFileSync(path.join(dir, 'sample.mjs'), 'export const value = 1;\n');
  writeFileSync(path.join(dir, 'sample.test.mjs'),
    "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "import { value } from './sample.mjs';\ntest('value', () => assert.equal(value, 1));\n");
  const { report } = runCoverage({ cwd: dir });
  assert.ok(report.all, 'the coverage report must carry a total row');
  assert.ok(report.all.line >= 0);
  assert.ok(report.files.some((file) => file.file.endsWith('sample.mjs')));
});

test('an invalid threshold fails closed', () => {
  const report = parseCoverageReport(SPEC_REPORT);
  for (const min of [NaN, -1, 101, '80']) {
    const decision = coverageDecision({ report, min });
    assert.equal(decision.status, 'FAIL', `threshold ${String(min)} passed`);
    assert.match(decision.reason, /invalid coverage threshold/);
  }
});

test('the failure reason names the scoped gate when only the scope regressed', () => {
  const report = parseCoverageReport(SPEC_REPORT);
  const decision = coverageDecision({ report, min: 84, scope: 'opurom' });
  assert.equal(decision.status, 'FAIL');
  assert.match(decision.reason, /scoped coverage/);
});
