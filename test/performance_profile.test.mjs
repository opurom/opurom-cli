// Performance profiler CLI test: measured phase records only, no invented GPU
// or raster timings. Flutter authority: engine/src/flutter/flow/frame_timings.h:35-42.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FRAME_PHASES, flameRowsToAscii, formatFlame, parsePhaseMs,
  performanceProfile, percentile, phaseBreakdown,
} from '../lib/performance_profile.mjs';

test('phase parsing keeps absent values null and rejects invalid durations', () => {
  assert.equal(parsePhaseMs(null), null);
  assert.equal(parsePhaseMs(0), 0);
  assert.equal(parsePhaseMs('12.5'), 12.5);
  assert.throws(() => parsePhaseMs(-1), /invalid phase duration/);
  assert.throws(() => parsePhaseMs('x'), /invalid phase duration/);
});

test('phase breakdown maps Flutter frame states and keeps unattributed time', () => {
  const row = phaseBreakdown({
    seq: 3, frameMs: 20, tier: 'full',
    phaseMs: { vsyncToBuildStartMs: 1, buildMs: 6, buildEndToRasterMs: 2, rasterMs: 9 },
  });
  assert.deepEqual(FRAME_PHASES, ['vsyncToBuildStart', 'build', 'buildEndToRaster', 'raster', 'total']);
  assert.equal(row.total, 20);
  assert.equal(row.attributed, 18);
  assert.equal(row.unattributed, 2);
  assert.equal(row.phases.build, 6);
  assert.equal(row.phases.raster, 9);

  const unknown = phaseBreakdown({ seq: 4, frameMs: 18 });
  assert.deepEqual(unknown.phases, {
    vsyncToBuildStart: null, build: null, buildEndToRaster: null, raster: null,
  });
  assert.equal(unknown.unattributed, null, 'no phase data must not be turned into 18ms of idle');
});

test('percentile is nearest-rank over measured samples', () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  assert.equal(percentile([10, 20], 25), 10);
});

test('performance profile reports only supplied phases and deterministic text', () => {
  const profile = performanceProfile([
    { seq: 1, frameMs: 10, phaseMs: { buildMs: 4, rasterMs: 5 }, tier: 'low' },
    { seq: 2, frameMs: 20, phaseMs: { buildMs: 8, rasterMs: 11 }, tier: 'full' },
  ]);
  assert.equal(profile.schema, 'opurom.performance-profile/v1');
  assert.equal(profile.frames, 2);
  assert.equal(profile.total.p95, 20);
  assert.equal(profile.build.p50, 4);
  assert.equal(profile.raster.max, 11);
  assert.equal(profile.rows[0].unattributed, 1);
  const text = formatFlame(profile);
  assert.match(text, /total: samples=2 p50=10ms p95=20ms max=20ms/);
  assert.match(text, /#2 total=20.00ms build=8.00ms raster=11.00ms/);
  const ascii = flameRowsToAscii(profile, 10);
  assert.equal(ascii.length, 2);
  assert.ok(ascii[0].length <= 10);
  assert.ok(ascii[1].length >= ascii[0].length);
});

test('performance profile accepts empty frames and rejects bad bucket sizes', () => {
  const empty = performanceProfile([]);
  assert.equal(empty.total.samples, 0);
  assert.equal(empty.total.p95, null);
  assert.throws(() => flameRowsToAscii(empty, 0), /buckets must be 1\.\.100/);
});
