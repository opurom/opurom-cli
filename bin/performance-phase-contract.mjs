#!/usr/bin/env node
// Machine-readable gate for the DevTools performance phase-breakdown contract.
//
// Quality-gate layer only: it imports tool-dev's public module but does not
// change it. Flutter authority (3.50.0, flutter-golden
// ab2912035e160d9cad6306df307576da6128ebdb, engine
// 371f77202a73e8dff57a8b3bff75bca55c090aee):
// - engine/src/flutter/flow/frame_timings.h:35-42 orders frame states
//   kVsync -> kBuildStart -> kBuildEnd -> kRasterStart -> kRasterEnd.
//
// Exit 0 only when all checks pass; every run prints one JSON document to
// stdout. Failures are fail-closed and include the observed value.
import assert from 'node:assert/strict';
import {
  FRAME_PHASES, flameRowsToAscii, formatFlame, performanceProfile, phaseBreakdown,
} from '../lib/performance_profile.mjs';

const EXPECTED_PHASES = Object.freeze([
  'vsyncToBuildStart', 'build', 'buildEndToRaster', 'raster', 'total',
]);

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

check('phase order matches FrameTimingsRecorder states', () => {
  assert.deepEqual(FRAME_PHASES, EXPECTED_PHASES);
  const profile = performanceProfile([]);
  assert.equal(profile.schema, 'opurom.performance-profile/v1');
  assert.equal(profile.frames, 0);
  assert.deepEqual(profile.phases, EXPECTED_PHASES);
  for (const name of ['total', 'build', 'raster']) {
    assert.deepEqual(profile[name], { name, samples: 0, p50: null, p95: null, max: null });
  }
});

check('phase attribution leaves gaps explicit and never negative', () => {
  const row = phaseBreakdown({
    seq: 7,
    frameMs: 16.67,
    phaseMs: { vsyncToBuildStart: 1, build: 4, buildEndToRaster: 2, raster: 3 },
  });
  assert.equal(row.total, 16.67);
  assert.equal(row.attributed, 10);
  assert.ok(Math.abs(row.unattributed - 6.67) < 1e-9);
  assert.deepEqual(Object.keys(row.phases), EXPECTED_PHASES.slice(0, 4));
  const over = phaseBreakdown({ frameMs: 5, phaseMs: { build: 4, raster: 4 } });
  assert.equal(over.unattributed, 0);
});

check('aggregate p50/p95 use nearest-rank over real samples', () => {
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

check('flame output is deterministic and marks absent measurements n/a', () => {
  const profile = performanceProfile([
    { seq: 1, frameMs: 8, phaseMs: { build: 2 } },
    { seq: 2, frameMs: 12 },
  ]);
  const text = formatFlame(profile);
  assert.match(text, /schema: opurom\.performance-profile\/v1/);
  assert.match(text, /frames: 2/);
  assert.match(text, /raster: samples=0 p50=n\/ams p95=n\/ams max=n\/ams/);
  assert.equal(text, formatFlame(profile));
  const rows = flameRowsToAscii(profile, 10);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.length === 10));
  assert.notDeepEqual(rows[0], rows[1]);
});

check('invalid bucket sizes are rejected', () => {
  const profile = performanceProfile([{ frameMs: 1 }]);
  for (const buckets of [0, -1, 101, 1.5]) {
    assert.throws(() => flameRowsToAscii(profile, buckets), /buckets must be 1\.\.100/);
  }
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.performance-phase-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    channel: 'flutter-3.50-candidate.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    engineCommit: '371f77202a73e8dff57a8b3bff75bca55c090aee',
    authority: 'engine/src/flutter/flow/frame_timings.h:35-42',
  },
  contract: {
    phases: EXPECTED_PHASES,
    profileSchema: 'opurom.performance-profile/v1',
    implementation: 'opurom-cli/lib/performance_profile.mjs (read-only from this gate)',
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
