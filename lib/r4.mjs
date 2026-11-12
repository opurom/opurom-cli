import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { formatExactMillis, unavailable } from './bench.mjs';
import { ensureSiblingBinary, tmpDir, workspaceRoot } from './paths.mjs';
import { run, runOrThrow } from './proc.mjs';

export const DEFAULT_FRAMES = 30;
export const MAX_FRAMES = 600;
const VIEWPORT = Object.freeze({ width: 800, height: 600 });

function lastLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? 'unknown error';
}

function errorReason(error) {
  return lastLine(error instanceof Error ? error.message : String(error));
}

// Cached crates only: the profile and inspector must never wait on the network.
function offlineTool(repo, names, { root, log }) {
  const env = { ...process.env, CARGO_NET_OFFLINE: 'true' };
  const found = ensureSiblingBinary(repo, names, { root, log, env });
  if (!found.path) throw new Error(`${names[0]} unavailable: ${found.reason}`);
  return found.path;
}

export function parseFrameCount(value = DEFAULT_FRAMES) {
  const count = Number(value);
  if (typeof value === 'boolean' || !Number.isSafeInteger(count) || count < 1 || count > MAX_FRAMES) {
    throw new Error(`invalid --frames: ${String(value)} (expected 1..${MAX_FRAMES})`);
  }
  return count;
}

// Linear interpolation between the nearest ranks; p is in 0..100.
export function percentile(values, p) {
  if (!Array.isArray(values) || !values.length || values.some((v) => !Number.isFinite(v))) return null;
  if (!Number.isFinite(p) || p < 0 || p > 100) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p / 100;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

export function profileStats(samples) {
  if (!Array.isArray(samples) || !samples.length || samples.some((v) => !Number.isFinite(v) || v < 0)) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const totalMs = samples.reduce((sum, ms) => sum + ms, 0);
  return {
    count: samples.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    min: sorted[0],
    max: sorted.at(-1),
    totalMs,
    fps: totalMs > 0 ? samples.length * 1000 / totalMs : null,
  };
}

export function formatProfileReport({ src, frames, stats, reason }) {
  const missing = unavailable(reason ?? 'no measurements');
  const ms = (value) => (Number.isFinite(value) ? formatExactMillis(value) : missing);
  const fps = stats && Number.isFinite(stats.fps)
    ? `${stats.fps} (${stats.count} frames / ${formatExactMillis(stats.totalMs)} of measured frame time)`
    : unavailable(reason ?? 'zero measured elapsed time');
  return [
    'OPUROM profile (MEASURED software-raster timings on this host)',
    `src: ${src}`,
    `frames: ${stats?.count ?? 0} measured / ${frames} requested (${VIEWPORT.width}x${VIEWPORT.height}, one real opurom-render process per frame)`,
    `p50: ${ms(stats?.p50)}`,
    `p95: ${ms(stats?.p95)}`,
    `min: ${ms(stats?.min)}`,
    `max: ${ms(stats?.max)}`,
    `achieved fps: ${fps}`,
    'Note: software-raster timings on this host, NOT a device/competitor benchmark. No GPU/device matrix is measured.',
  ].join('\n');
}

function wroteFrame(file) {
  try {
    return fs.statSync(file).size > 0;
  } catch {
    return false;
  }
}

export function profile({
  src, frames = DEFAULT_FRAMES, root = workspaceRoot(), log = console.log,
  compiler = null, renderer = null, keep = false,
} = {}) {
  const count = parseFrameCount(frames);
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  if (path.extname(srcAbs) !== '.opu') throw new Error(`profile source must be a .opu file: ${srcAbs}`);

  const tmp = tmpDir('profile-');
  let stats = null;
  let reason = null;
  try {
    const opuromc = compiler ?? offlineTool('opurom-lang', ['opuromc'], { root, log });
    const renderBin = renderer ?? offlineTool('opurom-render', ['opurom-render', 'opurom_render'], { root, log });
    const irFile = path.join(tmp, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
    const frame = path.join(tmp, 'frame.ppm');
    const samples = [];
    for (let i = 0; i < count; i += 1) {
      fs.rmSync(frame, { force: true });
      const start = performance.now();
      const result = run(renderBin, [irFile, String(VIEWPORT.width), String(VIEWPORT.height), frame], { timeout: 30000 });
      const ms = performance.now() - start;
      const output = `${result.stdout}${result.stderr}`;
      if (result.status !== 0) {
        throw new Error(`frame ${i + 1} failed (exit ${result.status}): ${lastLine(output)}`);
      }
      if (!/^digest=/m.test(output) || !/^dirty=/m.test(output) || !wroteFrame(frame)) {
        throw new Error(`frame ${i + 1} produced no complete renderer frame`);
      }
      samples.push(ms);
    }
    stats = profileStats(samples);
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
  log(formatProfileReport({ src: srcAbs, frames: count, stats, reason }));
  return stats ? 0 : 1;
}

export function parseDirtyCount(text) {
  const match = /dirty[^\n]*?(\d+)/i.exec(String(text ?? ''));
  return match ? Number(match[1]) : null;
}

export function dirtyStatus(count) {
  if (Number.isInteger(count) && count >= 0) return `${count} rect${count === 1 ? '' : 's'}`;
  return unavailable('renderer printed no dirty count');
}

function parseA11y(text, file) {
  const nodes = JSON.parse(text);
  if (!Array.isArray(nodes)) throw new Error(`a11y JSON in ${file} is not an array`);
  return nodes;
}

function formatBounds(bounds) {
  if (Array.isArray(bounds) && bounds.length === 4 && bounds.every((v) => Number.isFinite(v))) {
    return `[${bounds.join(',')}]`;
  }
  return unavailable('renderer reported no bounds');
}

function layerRows(node, depth = 0, rows = []) {
  if (!node || typeof node !== 'object' || !Number.isInteger(node.id)
    || typeof node.kind !== 'string' || !Array.isArray(node.children)) {
    throw new Error('invalid IR layer tree node: id, kind and children are required');
  }
  rows.push({ depth, id: node.id, kind: node.kind });
  for (const child of node.children) layerRows(child, depth + 1, rows);
  return rows;
}

function formatA11yRow(node, indent) {
  const role = typeof node.role === 'string' ? node.role : unavailable('renderer reported no a11y role');
  const label = JSON.stringify(String(node.label ?? ''));
  const hidden = typeof node.hidden === 'boolean'
    ? String(node.hidden)
    : unavailable('renderer reported no hidden flag');
  return `${indent}${node.id} ${role} ${label} ${formatBounds(node.bounds)} hidden=${hidden}`;
}

export function formatInspectTable(ir, a11yNodes, dirtyCount) {
  const dirtyText = dirtyStatus(dirtyCount);
  const byId = new Map((Array.isArray(a11yNodes) ? a11yNodes : [])
    .map((node) => [String(node?.id), node]));
  const rows = layerRows(ir?.tree).map(({ depth, id, kind }) => {
    const indent = '  '.repeat(depth);
    const a11y = byId.get(String(id));
    return {
      layer: `${indent}${id} ${kind} ${formatBounds(a11y?.bounds)} dirty=${dirtyText}`,
      a11y: a11y
        ? formatA11yRow(a11y, indent)
        : `${indent}${unavailable(`no a11y node for id ${id}`)}`,
    };
  });
  const leftHeader = 'Layer tree (id kind bounds dirty)';
  const rightHeader = 'A11y tree (id role label bounds hidden)';
  const width = Math.max(leftHeader.length, ...rows.map((row) => row.layer.length));
  return [
    `${leftHeader.padEnd(width)} | ${rightHeader}`,
    `${'-'.repeat(width)} | ${'-'.repeat(rightHeader.length)}`,
    ...rows.map((row) => `${row.layer.padEnd(width)} | ${row.a11y}`),
  ].join('\n');
}

function formatInspectReport({ irFile, table, dirtyCount }) {
  return [
    'OPUROM inspect (read-only; IR bytes unchanged)',
    `ir: ${irFile}`,
    `renderer: opurom-render --a11y (one real ${VIEWPORT.width}x${VIEWPORT.height} software-raster frame)`,
    `dirty-rect status: ${dirtyStatus(dirtyCount)} (frame-wide)`,
    '',
    table,
    '',
    "Note: dirty is the renderer's frame-wide dirty-rect count; no per-layer rect list is reported.",
    'Renderer outputs go to a temporary directory; this command does not modify the IR.',
    'The a11y tree is data-only, not OS screen-reader integration.',
  ].join('\n');
}

export function inspect({ ir, root = workspaceRoot(), log = console.log, renderer = null, keep = false } = {}) {
  const irAbs = path.resolve(ir);
  const before = fs.readFileSync(irAbs);
  let parsed;
  try {
    parsed = JSON.parse(before.toString('utf8'));
  } catch (error) {
    throw new Error(`invalid IR JSON in ${irAbs}: ${error.message}`);
  }
  if (parsed?.ir !== '0.1') throw new Error(`unsupported IR version: ${String(parsed?.ir)}`);
  layerRows(parsed.tree);

  let renderBin;
  try {
    renderBin = renderer ?? offlineTool('opurom-render', ['opurom-render', 'opurom_render'], { root, log });
  } catch (error) {
    console.error(`inspect: ${error.message}`);
    return 1;
  }

  const tmp = tmpDir('inspect-');
  try {
    const frame = path.join(tmp, 'frame.ppm');
    const a11yFile = path.join(tmp, 'a11y.json');
    let result;
    try {
      result = run(renderBin, [
        irAbs, String(VIEWPORT.width), String(VIEWPORT.height), frame, '--a11y', a11yFile,
      ], { timeout: 30000 });
    } catch (error) {
      console.error(`inspect: opurom-render --a11y failed; a11y tree ${unavailable(error.message)}`);
      return 1;
    }
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    if (result.status !== 0 || !fs.existsSync(a11yFile)) {
      const reason = detail || `opurom-render --a11y failed (exit ${result.status})`;
      console.error(`inspect: opurom-render --a11y failed; a11y tree ${unavailable(reason)}`);
      return 1;
    }
    let a11yNodes;
    try {
      a11yNodes = parseA11y(fs.readFileSync(a11yFile, 'utf8'), a11yFile);
    } catch (error) {
      console.error(`inspect: a11y tree ${unavailable(error.message)}`);
      return 1;
    }
    const after = fs.readFileSync(irAbs);
    if (!before.equals(after)) {
      console.error('inspect: IR file changed during inspection (read-only violation)');
      return 1;
    }
    const dirtyCount = parseDirtyCount(`${result.stdout}${result.stderr}`);
    const table = formatInspectTable(parsed, a11yNodes, dirtyCount);
    log(formatInspectReport({ irFile: irAbs, table, dirtyCount }));
    return 0;
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
