// Frame profiling uses one real renderer process per frame. The report layer is
// pure so tests can inject samples without relying on wall-clock measurements.
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { measureRenderRuns, percentile, profileStats } from './async_runtime.mjs';
import { discoverBinary, tmpDir, workspaceRoot } from './paths.mjs';
import { runOrThrow } from './proc.mjs';

export const DEFAULT_FRAMES = 30;
export const MAX_FRAMES = 1000;
export const SPARKLINE_BUCKETS = 24;
const SPARKLINE_LEVELS = '_.:-=+*#%@';
const realNow = () => performance.now();
export const FRAME_PROFILE_FIELDS = Object.freeze([
  'command', 'mode', 'status', 'src', 'requestedFrames', 'frames',
  'p50', 'p95', 'min', 'max', 'totalMs', 'fpsX10', 'sparkline', 'unit', 'reason',
]);
// `tiers` is appended only when --degrade is used, so the base record is unchanged.
export const FRAME_PROFILE_TIER_FIELDS = Object.freeze([...FRAME_PROFILE_FIELDS, 'tiers']);

// Mirrors opurom-render/src/perf.rs (FrameBudget) and FrameRate budget_ms.
export const WINDOW_FRAMES = 20;
export const PROMOTION_WINDOWS = 3;
export const PROMOTION_NUM = 3;
export const PROMOTION_DEN = 4;
const TIER_ORDER = Object.freeze(['Full', 'Reduced', 'Minimal']);

class ToolUnavailableError extends Error {}

export function parseFrameCount(value = DEFAULT_FRAMES) {
  const count = Number(value);
  if (typeof value === 'boolean' || !Number.isSafeInteger(count) || count < 1 || count > MAX_FRAMES) {
    throw new Error(`invalid --frames: ${String(value)} (expected 1..${MAX_FRAMES})`);
  }
  return count;
}

export function parseDegradeHz(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean' || (value !== '60' && value !== '120')) {
    throw new Error(`invalid --degrade: ${String(value)} (expected 60 or 120)`);
  }
  return Number(value);
}

function tierTargetMs(hz) {
  return hz === 120 ? 8 : 16;
}

// Replays the renderer's rolling-window policy over the exact measured samples:
// a 20-frame window drops one tier when its p95 exceeds the frame target, and
// promotes after 3 consecutive windows under 0.75 * target. `frames` counts the
// samples rendered at each tier (the tier applied before each sample's window
// decision, so the window that causes a drop is still counted at the old tier).
export function summarizeTiers(samples, hz) {
  validateSamples(samples);
  const clamped = samples.map((ms) => Math.max(0, ms));
  const target = tierTargetMs(hz);
  const promote = target * PROMOTION_NUM / PROMOTION_DEN;
  const counts = [0, 0, 0];
  let tier = 0;
  let goodWindows = 0;
  for (let frame = 1; frame <= clamped.length; frame += 1) {
    if (frame % WINDOW_FRAMES === 0) {
      const window = clamped.slice(frame - WINDOW_FRAMES, frame).sort((a, b) => a - b);
      const p95 = window[Math.ceil(95 * window.length / 100) - 1];
      if (p95 > target) {
        tier = Math.min(tier + 1, TIER_ORDER.length - 1);
        goodWindows = 0;
      } else if (p95 < promote && tier !== 0) {
        goodWindows += 1;
        if (goodWindows >= PROMOTION_WINDOWS) {
          tier = Math.max(tier - 1, 0);
          goodWindows = 0;
        }
      } else {
        goodWindows = 0;
      }
    }
    counts[tier] += 1;
  }
  const sorted = [...clamped].sort((a, b) => a - b);
  return {
    tiers: TIER_ORDER
      .map((name, index) => ({ tier: name, frames: counts[index] }))
      .filter((entry) => entry.frames > 0),
    degraded: tier !== 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
  };
}

function checkedSource(src) {
  if (typeof src !== 'string' || !src.trim()) throw new Error('missing required option --src');
  return path.resolve(src);
}

function validateSamples(samples, expectedFrames) {
  if (!Array.isArray(samples)) throw new Error('frame profile needs an array of measured ms samples');
  if (typeof expectedFrames === 'number' && samples.length !== expectedFrames) {
    throw new Error(`frame profile needs ${expectedFrames} measured samples, got ${samples.length}`);
  }
  if (!samples.length) throw new Error('frame profile needs at least one measured sample');
  samples.forEach((ms, index) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      throw new Error(`invalid sample at frame ${index + 1}: ${String(ms)} (expected finite ms >= 0)`);
    }
  });
}

export function frameSparkline(samples, buckets = SPARKLINE_BUCKETS) {
  validateSamples(samples);
  if (!Number.isSafeInteger(buckets) || buckets < 1) throw new Error('invalid sparkline bucket count');
  const width = Math.min(buckets, SPARKLINE_BUCKETS, samples.length);
  const means = [];
  for (let bucket = 0; bucket < width; bucket += 1) {
    const start = Math.floor(bucket * samples.length / width);
    const end = Math.floor((bucket + 1) * samples.length / width);
    let sum = 0;
    for (let i = start; i < end; i += 1) sum += samples[i];
    means.push(sum / (end - start));
  }
  const min = Math.min(...means);
  const max = Math.max(...means);
  return means.map((mean) => {
    const ratio = max === min ? 0.5 : (mean - min) / (max - min);
    return SPARKLINE_LEVELS[Math.round(ratio * (SPARKLINE_LEVELS.length - 1))];
  }).join('');
}

function frameStats(samples, requestedFrames) {
  validateSamples(samples, requestedFrames);
  const stats = profileStats(samples);
  if (!stats || !Number.isFinite(stats.fps)) throw new Error('renderer produced no measurable elapsed time');
  const fpsX10 = Math.round(stats.fps * 10);
  if (!Number.isSafeInteger(fpsX10) || fpsX10 < 0) throw new Error('fps x10 is out of range');
  return {
    frames: stats.count,
    p50: stats.p50,
    p95: stats.p95,
    min: stats.min,
    max: stats.max,
    totalMs: stats.totalMs,
    fpsX10,
    sparkline: frameSparkline(samples),
  };
}

function makeRecord({ src, count, status, reason, stats = null, tiers = null }) {
  const record = {
    command: 'profile',
    mode: 'frames',
    status,
    src,
    requestedFrames: count,
    frames: stats?.frames ?? 0,
    p50: stats?.p50 ?? null,
    p95: stats?.p95 ?? null,
    min: stats?.min ?? null,
    max: stats?.max ?? null,
    totalMs: stats?.totalMs ?? null,
    fpsX10: stats?.fpsX10 ?? null,
    sparkline: stats?.sparkline ?? null,
    unit: 'ms',
    reason,
  };
  if (tiers !== null) record.tiers = tiers;
  return record;
}

export function frameProfileRecord({
  src, requestedFrames, samples = [], status = 'PASS', reason = null, degradeHz = null,
} = {}) {
  const count = parseFrameCount(requestedFrames);
  const srcAbs = checkedSource(src);
  if (status === 'SKIP') {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('SKIP needs a concrete reason');
    return makeRecord({ src: srcAbs, count, status, reason });
  }
  if (status !== 'PASS') throw new Error(`unsupported frame profile status: ${String(status)}`);
  const tiers = degradeHz === null ? null : summarizeTiers(samples, degradeHz).tiers;
  return makeRecord({ src: srcAbs, count, status, reason: null, stats: frameStats(samples, count), tiers });
}

function orderedRecord(record) {
  const fields = record && 'tiers' in record ? FRAME_PROFILE_TIER_FIELDS : FRAME_PROFILE_FIELDS;
  if (!record || fields.some((key) => !(key in record))) {
    throw new Error('frame profile needs a complete record');
  }
  return Object.fromEntries(fields.map((key) => [key, record[key]]));
}

export function frameProfileJson(record) {
  return JSON.stringify(orderedRecord(record));
}

function cell(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return value.map((entry) => `${entry.tier}:${entry.frames}`).join(', ');
  return String(value).replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
}

export function frameProfileMarkdown(record) {
  const rows = Object.entries(orderedRecord(record))
    .map(([field, value]) => `| ${field} | ${cell(value)} |`);
  return [
    '# OPUROM frame profile',
    '',
    '| field | value |',
    '| --- | --- |',
    ...rows,
    '',
    `Each statistic comes from one \`opurom-render\` process per measured frame; \`fpsX10\` is ten times the derived fps, rounded to an integer; \`sparkline\` contains at most ${SPARKLINE_BUCKETS} ASCII buckets.`,
    '`status: SKIP` reports zero measured frames and keeps every measured field `null`.',
    ...('tiers' in record ? ['`tiers` appears only with `--degrade` and counts frames per quality tier as `tier:frames`.'] : []),
  ].join('\n');
}

function findTool({ name, names, repo, injected, root, envPath }) {
  if (injected) return injected;
  const found = discoverBinary(names, { root, repo, envPath });
  if (found) return found;
  throw new ToolUnavailableError(
    `${name} unavailable: no executable in PATH or ${path.join(root, repo, 'target', '{debug,release}')}; PATH=${String(envPath || '<empty>')}`,
  );
}

function collectRealSamples({
  srcAbs, frames, root, envPath, compiler, renderer, now, keep,
}) {
  const renderBin = findTool({
    name: 'opurom-render', names: ['opurom-render', 'opurom_render'],
    repo: 'opurom-render', injected: renderer, root, envPath,
  });
  const opuromc = findTool({
    name: 'opuromc', names: ['opuromc'], repo: 'opurom-lang',
    injected: compiler, root, envPath,
  });
  const tmp = tmpDir('frame-profile-');
  try {
    const irFile = path.join(tmp, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
    return measureRenderRuns({
      renderBin, irFile, frame: path.join(tmp, 'frame.ppm'), count: frames, now,
    });
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function profileFrames({
  src, frames = DEFAULT_FRAMES, root = workspaceRoot(), envPath = process.env.PATH ?? '',
  log = console.log, compiler = null, renderer = null, samples = null, sampleSource = null,
  now = realNow, keep = false, markdown = false, degrade = null,
} = {}) {
  const count = parseFrameCount(frames);
  const degradeHz = parseDegradeHz(degrade);
  const srcValue = checkedSource(src);
  if (!fs.existsSync(srcValue)) throw new Error(`source not found: ${srcValue}`);
  if (path.extname(srcValue) !== '.opu') throw new Error(`profile source must be a .opu file: ${srcValue}`);

  const source = samples ?? sampleSource;
  let measuredSamples;
  try {
    if (Array.isArray(source)) measuredSamples = source;
    else if (typeof source === 'function') measuredSamples = source({ frames: count, src: srcValue, now });
    else measuredSamples = collectRealSamples({
      srcAbs: srcValue, frames: count, root, envPath, compiler, renderer, now, keep,
    });
  } catch (error) {
    if (!(error instanceof ToolUnavailableError)) throw error;
    const record = frameProfileRecord({
      src: srcValue, requestedFrames: count, status: 'SKIP', reason: error.message,
    });
    log(markdown ? frameProfileMarkdown(record) : frameProfileJson(record));
    return 0;
  }
  const record = frameProfileRecord({
    src: srcValue, requestedFrames: count, samples: measuredSamples, status: 'PASS', degradeHz,
  });
  log(markdown ? frameProfileMarkdown(record) : frameProfileJson(record));
  return 0;
}
