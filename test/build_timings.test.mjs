// Build timing tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923,1016,1045-1057
// - packages/flutter_tools/lib/src/build_info.dart:186,436,459-460
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import {
  BUILD_TIMINGS_SCHEMA, buildTimingsJson, createTimer, formatBuildTimings,
} from '../lib/build_timings.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('timer records target, elapsed ms and success with an injected clock', () => {
  let ticks = 0n;
  const timer = createTimer(() => (ticks += 1_000_000n));
  assert.equal(timer.measure('compile', () => 42), 42);
  assert.deepEqual(timer.last, {
    target: 'compile', elapsedMilliseconds: 1, skipped: false, succeeded: true,
  });
  assert.throws(() => timer.measure('lower', () => { throw new Error('boom'); }), /boom/);
  assert.equal(timer.rows[1].succeeded, false);
  assert.match(formatBuildTimings(timer.rows), /compile: 1ms \(succeeded\)/);
  assert.match(formatBuildTimings(timer.rows), /total: 2ms across 2 steps/);
});

test('timer rejects a clock that moves backwards', () => {
  let value = 10n;
  const timer = createTimer(() => { const current = value; value -= 1n; return current; });
  assert.throws(() => timer.measure('x', () => {}), /clock moved backwards/);
});

test('timing JSON is a stable artifact', () => {
  const rows = [{ target: 'compile', elapsedMilliseconds: 1.5, skipped: false, succeeded: true }];
  const parsed = JSON.parse(buildTimingsJson(rows, { target: 'web' }));
  assert.equal(parsed.schema, BUILD_TIMINGS_SCHEMA);
  assert.equal(parsed.totalMs, 1.5);
  assert.equal(parsed.target, 'web');
  assert.deepEqual(parsed.steps, rows);
});

test('real build emits timings and writes the JSON artifact', () => {
  const base = tmpDir('build-timings-');
  try {
    const out = path.join(base, 'out');
    const file = path.join(base, 'timings.json');
    const result = run(process.execPath, [
      CLI, 'build', '--src',
      path.resolve('../opurom-examples/golden/counter.opu'),
      '--target', 'web-dom', '--out', out, '--timings', '--timings-file', file,
    ], { timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Opurom build timings/);
    assert.match(result.stdout, /compile:/);
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.schema, BUILD_TIMINGS_SCHEMA);
    assert.equal(parsed.target, 'web-dom');
    assert.ok(parsed.steps.some((step) => step.target === 'compile'));
    assert.ok(parsed.totalMs > 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
