// Performance flame graph / phase breakdown for Opurom CLI. Flutter authority
// (3.50.0, flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb,
// engine @ 371f77202a73e8dff57a8b3bff75bca55c090aee):
// - engine/src/flutter/flow/frame_timings.h:35-42 (FrameTimingsRecorder states:
//   kVsync -> kBuildStart -> kBuildEnd -> kRasterStart -> kRasterEnd)
// - packages/flutter_tools/lib/src/compile.dart:210-235 (mode options used by
//   profile vs release builds)
// - packages/flutter_tools/lib/src/build_system/targets/common.dart:190-198
//   (kernel_snapshot reads BuildMode from the build environment)
// Opurom adaptation: use only the measured frame phase samples already exposed
// by the dev data plane. Absent phases stay null; no fabricated timings.

export const FRAME_PHASES = Object.freeze(['vsyncToBuildStart', 'build', 'buildEndToRaster', 'raster', 'total']);

export function parsePhaseMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid phase duration: ${String(value)}`);
  return n;
}

// A frame record uses the relay shape: startMs, frameMs, phaseMs. phaseMs may
// contain buildMs/rasterMs or the four edge names from frame_timings.h.
export function phaseBreakdown(frame) {
  if (!frame || typeof frame !== 'object') throw new Error('frame record is required');
  const total = parsePhaseMs(frame.frameMs ?? frame.totalMs);
  const phase = frame.phaseMs && typeof frame.phaseMs === 'object' ? frame.phaseMs : {};
  const build = parsePhaseMs(phase.buildMs ?? phase.build);
  const raster = parsePhaseMs(phase.rasterMs ?? phase.raster);
  const vsyncToBuildStart = parsePhaseMs(phase.vsyncToBuildStartMs ?? phase.vsyncToBuildStart);
  const buildEndToRaster = parsePhaseMs(phase.buildEndToRasterMs ?? phase.buildEndToRaster);
  const known = [build, raster, vsyncToBuildStart, buildEndToRaster].filter((v) => v !== null);
  const attributed = known.reduce((a, b) => a + b, 0);
  return {
    seq: Number.isInteger(frame.seq) ? frame.seq : null,
    total,
    phases: { vsyncToBuildStart, build, buildEndToRaster, raster },
    attributed,
    unattributed: total === null || known.length === 0 ? null : Math.max(0, total - attributed),
    tier: typeof frame.tier === 'string' ? frame.tier : null,
  };
}

export function percentile(values, p) {
  const list = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!list.length) return null;
  // Nearest-rank: ceil(p/100 * N), matching the frame-tier gate in
  // lib/frame_tier.mjs (WINDOW_FRAMES=20 integer nearest-rank p95).
  const rank = Math.max(1, Math.ceil((p / 100) * list.length));
  return list[Math.min(rank, list.length) - 1];
}

export function performanceProfile(frames = []) {
  const rows = frames.map(phaseBreakdown);
  const totals = rows.map((row) => row.total).filter((v) => v !== null);
  const build = rows.map((row) => row.phases.build).filter((v) => v !== null);
  const raster = rows.map((row) => row.phases.raster).filter((v) => v !== null);
  const stats = (name, list) => ({
    name,
    samples: list.length,
    p50: percentile(list, 50),
    p95: percentile(list, 95),
    max: list.length ? Math.max(...list) : null,
  });
  return {
    schema: 'opurom.performance-profile/v1',
    frames: rows.length,
    total: stats('total', totals),
    build: stats('build', build),
    raster: stats('raster', raster),
    phases: FRAME_PHASES,
    rows,
  };
}

export function formatFlame(profile) {
  const lines = ['Opurom performance flame (measured frame phases)', `schema: ${profile.schema}`, `frames: ${profile.frames}`];
  for (const name of ['total', 'build', 'raster']) {
    const s = profile[name];
    lines.push(`${name}: samples=${s.samples} p50=${s.p50 ?? 'n/a'}ms p95=${s.p95 ?? 'n/a'}ms max=${s.max ?? 'n/a'}ms`);
  }
  for (const row of profile.rows) {
    const mm = (v) => v === null ? 'n/a' : `${v.toFixed(2)}ms`;
    lines.push(`  #${row.seq ?? '?'} total=${mm(row.total)} build=${mm(row.phases.build)} raster=${mm(row.phases.raster)} unattributed=${mm(row.unattributed)} tier=${row.tier ?? 'n/a'}`);
  }
  return `${lines.join('\n')}\n`;
}

export function flameRowsToAscii(profile, buckets = 20) {
  if (!Number.isInteger(buckets) || buckets < 1 || buckets > 100) throw new Error('buckets must be 1..100');
  const max = Math.max(0, ...profile.rows.map((row) => row.total ?? 0));
  if (!max) return Array.from({ length: profile.rows.length }, () => '_'.repeat(buckets));
  const scale = ' .:-=+*#%@';
  return profile.rows.map((row) => {
    const width = Math.max(1, Math.min(buckets, Math.round(((row.total ?? 0) / max) * buckets)));
    const fill = scale[Math.min(scale.length - 1, Math.floor((width / buckets) * scale.length))];
    return fill.repeat(width).padEnd(buckets, '_');
  });
}
