// Performance measurement: repeated identical work with the warmup
// excluded and reported, plus a software-raster versus GPU-backend comparison
// where every speed statement is paired with the byte-equality result.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { formatExactMillis, unavailable } from './bench.mjs';
import { run, runOrThrow } from './proc.mjs';
import { tmpDir, workspaceRoot } from './paths.mjs';
import {
  VIEWPORT, errorReason, lastLine, machineBackend, machineReport,
  measureRenderRuns, offlineTool, profileStats,
} from './async_runtime.mjs';

export const DEFAULT_REPEAT = 10;
export const MAX_REPEAT = 600;
export const DEFAULT_WARMUP = 2;

export function parseRepeatCount(value = DEFAULT_REPEAT) {
  const count = Number(value);
  if (typeof value === 'boolean' || !Number.isSafeInteger(count) || count < 1 || count > MAX_REPEAT) {
    throw new Error(`invalid --repeat: ${String(value)} (expected 1..${MAX_REPEAT})`);
  }
  return count;
}

// The warmup runs are discarded, so at least one measured run must survive.
export function warmupFor(repeat, warmup = DEFAULT_WARMUP) {
  return Math.min(warmup, Math.max(0, repeat - 1));
}

export function measuredRuns(repeat, warmup = DEFAULT_WARMUP) {
  return repeat - warmupFor(repeat, warmup);
}

export function repeatStats(samples) {
  const stats = profileStats(samples);
  if (!stats) return null;
  return { ...stats, median: stats.p50 };
}

export function environmentDescription({
  cpus = os.cpus(),
  release = os.release(),
  nodeVersion = process.version,
  raster = 'software raster on this host (opurom-render CPU path)',
} = {}) {
  const cpu = Array.isArray(cpus) && cpus.length ? cpus[0] : null;
  const model = typeof cpu?.model === 'string' && cpu.model.trim() ? cpu.model.trim() : null;
  const count = Array.isArray(cpus) ? cpus.length : 0;
  return {
    cpuModel: model ?? unavailable('no CPU model reported by os.cpus()'),
    cpuCount: count > 0 ? String(count) : unavailable('no CPU list reported by os.cpus()'),
    osRelease: typeof release === 'string' && release.trim()
      ? release.trim()
      : unavailable('no OS release reported by os.release()'),
    nodeVersion: typeof nodeVersion === 'string' && nodeVersion.trim()
      ? nodeVersion.trim()
      : unavailable('no Node version reported'),
    raster,
  };
}

export function formatEnvironment(env = environmentDescription()) {
  return [
    `environment: cpu=${env.cpuModel} (${env.cpuCount} logical cpus)`,
    `environment: os release=${env.osRelease}`,
    `environment: node=${env.nodeVersion}`,
    `environment: raster=${env.raster}`,
  ].join('\n');
}

export function formatRepeatReport({
  src, repeat, warmup, measured, stats, reason, env = environmentDescription(),
}) {
  const missing = unavailable(reason ?? 'no measurements');
  const ms = (value) => (Number.isFinite(value) ? formatExactMillis(value) : missing);
  const fps = stats && Number.isFinite(stats.fps)
    ? `${stats.fps} (${stats.count} measured runs / ${formatExactMillis(stats.totalMs)} of measured time)`
    : unavailable(reason ?? 'zero measured elapsed time');
  return [
    'OPUROM profile --repeat (MEASURED repeated identical work on this host)',
    `src: ${src}`,
    `repeat: ${repeat} requested / warmup excluded: ${warmup} / ${measured} measured runs`,
    `median: ${ms(stats?.median)}`,
    `p95: ${ms(stats?.p95)}`,
    `min: ${ms(stats?.min)}`,
    `max: ${ms(stats?.max)}`,
    `achieved fps: ${fps}`,
    formatEnvironment(env),
    'Note: software-raster timings on this host, NOT a device/competitor benchmark.',
    'No competitor binary was executed and no competitor number was estimated.',
  ].join('\n');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function bytesEqual(a, b) {
  const left = fs.readFileSync(a);
  const right = fs.readFileSync(b);
  return left.length === right.length && left.equals(right);
}

// A speed ratio is only printed when the two outputs are byte-equal: a faster
// run over a different image is not a speed result.
export function formatCompareReport({
  src, software, gpu, equality, reason, env = environmentDescription(),
}) {
  const equal = typeof equality === 'string' && equality.startsWith('byte-equal');
  const different = typeof equality === 'string' && equality.startsWith('NOT byte-equal');
  const softwareText = software && Number.isFinite(software.ms)
    ? formatExactMillis(software.ms)
    : unavailable(reason ?? software?.reason ?? 'not run');
  const gpuText = gpu && Number.isFinite(gpu.ms)
    ? formatExactMillis(gpu.ms)
    : unavailable(gpu?.reason ?? reason ?? 'not run');
  const lines = [
    'OPUROM bench --compare (MEASURED software vs GPU backend, this host)',
    `src: ${src}`,
    `software renderer (opurom-render): ${softwareText}`,
    `gpu backend (opurom-gpu): ${gpuText}`,
    `byte equality of the two outputs: ${equality ?? unavailable(reason ?? 'not run')}`,
  ];
  if (equal && software && gpu && Number.isFinite(software.ms) && Number.isFinite(gpu.ms) && gpu.ms > 0) {
    lines.push(`speed: gpu is ${(software.ms / gpu.ms).toFixed(2)}x the software renderer time (measured; byte-equal outputs)`);
  } else if (different) {
    lines.push('speed: n/a (outputs are not byte-equal; no speed claim over a different image)');
  } else {
    lines.push('speed: n/a (one backend could not be measured)');
  }
  lines.push(
    formatEnvironment(env),
    'Note: both timings are on this host, NOT a device/competitor benchmark.',
    'No competitor binary was executed and no competitor number was estimated.',
  );
  return lines.join('\n');
}

function checkSource(srcAbs) {
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  if (path.extname(srcAbs) !== '.opu') throw new Error(`source must be a .opu file: ${srcAbs}`);
}

// Runs the same work `repeat` times, discards the warmup runs and reports the
// statistics of the measured runs only.
export function profileRepeat({
  src, repeat = DEFAULT_REPEAT, warmup = DEFAULT_WARMUP, root = workspaceRoot(), log = console.log,
  compiler = null, renderer = null, keep = false, json = false,
} = {}) {
  const total = parseRepeatCount(repeat);
  const srcAbs = path.resolve(src);
  checkSource(srcAbs);

  const tmp = tmpDir('profile-repeat-');
  const toolLog = json ? () => {} : log;
  let stats = null;
  let reason = null;
  let measuredSamples = [];
  try {
    const opuromc = compiler ?? offlineTool('opurom-lang', ['opuromc'], { root, log: toolLog });
    const renderBin = renderer ?? offlineTool('opurom-render', ['opurom-render', 'opurom_render'], { root, log: toolLog });
    const irFile = path.join(tmp, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
    const frame = path.join(tmp, 'frame.ppm');
    const samples = measureRenderRuns({ renderBin, irFile, frame, count: total });
    const discarded = warmupFor(total, warmup);
    measuredSamples = samples.slice(discarded);
    stats = repeatStats(measuredSamples);
    if (!stats || !Number.isFinite(stats.fps)) {
      stats = null;
      reason = 'renderer produced no measurable elapsed time';
    }
  } catch (error) {
    stats = null;
    reason = errorReason(error);
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
  const warmupCount = warmupFor(total, warmup);
  log(json
    ? machineReport({ command: 'profile', mode: 'repeat', samples: stats ? measuredSamples : [], reason })
    : formatRepeatReport({
      src: srcAbs,
      repeat: total,
      warmup: warmupCount,
      measured: total - warmupCount,
      stats,
      reason,
    }));
  return stats ? 0 : 1;
}

// Renders the SAME scene through the software renderer and the GPU backend,
// measures both and reports the byte-equality result of the two outputs.
export function compareBackends({
  src, root = workspaceRoot(), log = console.log, compiler = null, renderer = null, gpu = null,
  keep = false, json = false,
} = {}) {
  const srcAbs = path.resolve(src);
  checkSource(srcAbs);

  const tmp = tmpDir('bench-compare-');
  const toolLog = json ? () => {} : log;
  let software = null;
  let gpuResult = null;
  let equality = null;
  let reason = null;
  let softwareSamples = [];
  let gpuSamples = [];
  try {
    const opuromc = compiler ?? offlineTool('opurom-lang', ['opuromc'], { root, log: toolLog });
    const renderBin = renderer ?? offlineTool('opurom-render', ['opurom-render', 'opurom_render'], { root, log: toolLog });
    const irFile = path.join(tmp, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);

    const cpuFrame = path.join(tmp, 'software.ppm');
    const commands = path.join(tmp, 'commands.json');
    const gpuFrame = path.join(tmp, 'gpu.ppm');

    // Software renderer: the same scene, plus the display list the GPU needs.
    const softwareStart = performance.now();
    const softwareRun = run(renderBin, [
      irFile, String(VIEWPORT.width), String(VIEWPORT.height), cpuFrame, '--commands', commands,
    ], { timeout: 30000 });
    software = { ms: performance.now() - softwareStart };
    const softwareOutput = `${softwareRun.stdout}${softwareRun.stderr}`;
    if (softwareRun.status !== 0) {
      throw new Error(`software render failed (exit ${softwareRun.status}): ${lastLine(softwareOutput)}`);
    }
    if (!fs.existsSync(cpuFrame) || fs.statSync(cpuFrame).size === 0) {
      throw new Error('software render produced no PPM output');
    }
    if (!fs.existsSync(commands)) {
      throw new Error('software render produced no display list for the GPU backend');
    }

    try {
      const gpuBin = gpu ?? offlineTool('opurom-gpu', ['opurom-gpu', 'opurom_gpu'], { root, log: toolLog });
      const gpuStart = performance.now();
      const gpuRun = run(gpuBin, ['raster', commands, gpuFrame], { timeout: 30000 });
      const gpuMs = performance.now() - gpuStart;
      const gpuOutput = `${gpuRun.stdout}${gpuRun.stderr}`;
      if (gpuRun.status !== 0) {
        gpuResult = { reason: `opurom-gpu raster failed (exit ${gpuRun.status}): ${lastLine(gpuOutput)}` };
      } else if (!fs.existsSync(gpuFrame) || fs.statSync(gpuFrame).size === 0) {
        gpuResult = { reason: 'opurom-gpu raster produced no PPM output' };
      } else {
        gpuResult = { ms: gpuMs };
      }
    } catch (error) {
      gpuResult = { reason: errorReason(error) };
    }

    if (gpuResult?.ms !== undefined) {
      equality = bytesEqual(cpuFrame, gpuFrame)
        ? `byte-equal (${sha256(cpuFrame)} sha256, ${fs.statSync(cpuFrame).size} B each)`
        : `NOT byte-equal (software sha256 ${sha256(cpuFrame)} vs gpu sha256 ${sha256(gpuFrame)})`;
    } else {
      equality = unavailable(gpuResult?.reason ?? 'GPU backend did not run');
    }
  } catch (error) {
    reason = errorReason(error);
    software = null;
    gpuResult = null;
    equality = unavailable(reason);
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (Number.isFinite(software?.ms)) softwareSamples = [software.ms];
  if (Number.isFinite(gpuResult?.ms)) gpuSamples = [gpuResult.ms];
  const samples = [...softwareSamples, ...gpuSamples];
  const byteEqual = typeof equality === 'string' && equality.startsWith('byte-equal')
    ? true
    : typeof equality === 'string' && equality.startsWith('NOT byte-equal') ? false : null;
  if (json) {
    log(machineReport({
      command: 'bench',
      mode: 'compare',
      samples,
      backends: [
        machineBackend('software', softwareSamples, reason ?? 'not measured'),
        machineBackend('gpu', gpuSamples, gpuResult?.reason ?? reason ?? 'not measured'),
      ],
      byteEqual,
      reason: reason ?? (samples.length ? null : 'no measurements'),
    }));
  } else {
    log(formatCompareReport({
      src: srcAbs,
      software,
      gpu: gpuResult,
      equality,
      reason,
      env: environmentDescription({
        raster: 'software raster (opurom-render) and GPU compute backend (opurom-gpu) on this host',
      }),
    }));
  }
  return software ? 0 : 1;
}
