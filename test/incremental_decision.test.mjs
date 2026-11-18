// Observable incremental build decision tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923-1016
//   (PerformanceMeasurement carries skipped=true for skipped targets)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (dirty files invalidate dependent targets)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import {
  decideIncremental, formatIncrementalDecision, INCREMENTAL_DECISION_SCHEMA,
} from '../lib/incremental_decision.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('dirty inputs force every step to run; clean inputs only propose skipping compile', () => {
  const steps = ['compile', 'lower'];
  const dirty = decideIncremental({ dirty: ['src/main.opu'], steps });
  assert.equal(dirty.schema, INCREMENTAL_DECISION_SCHEMA);
  assert.equal(dirty.status, 'OBSERVED');
  assert.equal(dirty.enforcement, 'none');
  assert.deepEqual(dirty.dirty, ['src/main.opu']);
  assert.deepEqual(dirty.steps.map((row) => row.action), ['run', 'run']);
  assert.deepEqual(dirty.steps.map((row) => row.executed), [true, true]);

  const clean = decideIncremental({ dirty: [], steps });
  assert.deepEqual(clean.steps.map((row) => row.action), ['would-skip', 'run']);
  assert.equal(clean.summary.wouldSkip, 1);
  assert.match(formatIncrementalDecision(clean), /compile: would-skip \(executed=true\)/);
  assert.match(formatIncrementalDecision(clean), /enforcement: none/);
});

test('decision input is normalized and validated', () => {
  const result = decideIncremental({ dirty: ['b', 'a', 'a'], steps: ['compile'] });
  assert.deepEqual(result.dirty, ['a', 'b']);
  assert.throws(() => decideIncremental({ dirty: 'x', steps: [] }), /must be arrays/);
});

test('real incremental builds emit a stable decision report without skipping work', () => {
  const base = tmpDir('incremental-decision-');
  try {
    const out = path.join(base, 'out');
    const src = path.resolve('../opurom-examples/golden/counter.opu');
    const args = [CLI, 'build', '--src', src, '--target', 'web-dom', '--out', out, '--incremental'];
    const first = run(process.execPath, args, { timeout: 120000 });
    assert.equal(first.status, 0, first.stderr);
    const reportFile = path.join(out, '.opurom-incremental', 'latest.json');
    const firstReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(firstReport.schema, INCREMENTAL_DECISION_SCHEMA);
    assert.equal(firstReport.dirty.length, 1);
    assert.deepEqual(firstReport.executedSteps, firstReport.steps.map((row) => row.step));

    const second = run(process.execPath, args, { timeout: 120000 });
    assert.equal(second.status, 0, second.stderr);
    const secondReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(secondReport.dirty.length, 0);
    assert.equal(secondReport.steps.find((row) => row.step === 'compile').action, 'would-skip');
    assert.equal(secondReport.executedSteps.length, secondReport.steps.length);
    assert.ok(secondReport.executedSteps.every((step, index) => step === secondReport.steps[index].step));
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
