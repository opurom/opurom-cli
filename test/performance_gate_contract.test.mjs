// Gate contract for the DevTools performance-profile payload.
//
// This module does not own lib/performance_profile.mjs (tool-dev does). It
// pins the public JSON contract that quality gates and CI archives rely on:
// - Flutter 3.50.0 / ab2912035e, engine 371f77202a73e8:
//   engine/src/flutter/flow/frame_timings.h:35-42 orders the five frame states
//   kVsync -> kBuildStart -> kBuildEnd -> kRasterStart -> kRasterEnd.
// - Opurom adaptation: opurom-cli/lib/performance_profile.mjs:4-9 records the
//   five derived phases; absent phases stay null and are never fabricated.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRAME_PHASES, flameRowsToAscii, formatFlame, performanceProfile, phaseBreakdown,
} from '../lib/performance_profile.mjs';

test('the profile schema and phase list pin the Flutter frame-state order', () => {
  assert.deepEqual(FRAME_PHASES, [
    'vsyncToBuildStart', 'build', 'buildEndToRaster', 'raster', 'total',
  ]);
  const profile = performanceProfile([]);
  assert.equal(profile.schema, 'opurom.performance-profile/v1');
  assert.equal(profile.frames, 0);
  assert.deepEqual(profile.phases, FRAME_PHASES);
  for (const name of ['total', 'build', 'raster']) {
    assert.deepEqual(profile[name], { name, samples: 0, p50: null, p95: null, max: null });
  }
});

test('phase attribution never exceeds total and leaves gaps explicit', () => {
  const row = phaseBreakdown({
    seq: 7, frameMs: 16.67,
    phaseMs: { vsyncToBuildStart: 1, build: 4, buildEndToRaster: 2, raster: 3 },
  });
  assert.equal(row.total, 16.67);
  assert.equal(row.attributed, 10);
  assert.ok(Math.abs(row.unattributed - 6.67) < 1e-9);
  assert.deepEqual(Object.keys(row.phases), FRAME_PHASES.slice(0, 4));

  const over = phaseBreakdown({ frameMs: 5, phaseMs: { build: 4, raster: 4 } });
  assert.equal(over.unattributed, 0, 'overlap must not become negative idle time');
});

test('profile aggregates real samples with nearest-rank p50/p95', () => {
  const profile = performanceProfile([
    { seq: 1, frameMs: 10, phaseMs: { build: 2, raster: 3 } },
    { seq: 2, frameMs: 20, phaseMs: { build: 4, raster: 6 } },
    { seq: 3, frameMs: 30, phaseMs: { build: 6, raster: 9 } },
  ]);
  assert.equal(profile.total.samples, 3);
  assert.equal(profile.total.p50, 20);
  assert.equal(profile.total.p95, 30);
  assert.equal(profile.total.max, 30);
  assert.equal(profile.build.p50, 4);
  assert.equal(profile.raster.p95, 9);
  assert.equal(profile.rows.length, 3);
});

test('flame output is deterministic and labels absent measurements as n/a', () => {
  const profile = performanceProfile([
    { seq: 1, frameMs: 8, phaseMs: { build: 2 } },
    { seq: 2, frameMs: 12 },
  ]);
  const text = formatFlame(profile);
  assert.match(text, /schema: opurom\.performance-profile\/v1/);
  assert.match(text, /frames: 2/);
  assert.match(text, /raster: samples=0 p50=n\/ams p95=n\/ams max=n\/ams/);
  assert.match(text, /raster=n\/a/);
  assert.equal(text, formatFlame(profile), 'text output must be deterministic');
  const rows = flameRowsToAscii(profile, 10);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.length === 10));
  assert.notDeepEqual(rows[0], rows[1], 'different frame times must draw different bars');
});

test('invalid bucket sizes are rejected', () => {
  const profile = performanceProfile([{ frameMs: 1 }]);
  for (const buckets of [0, -1, 101, 1.5]) {
    assert.throws(() => flameRowsToAscii(profile, buckets), /buckets must be 1\.\.100/);
  }
});
