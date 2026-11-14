// A reproducible Opurom-only benchmark. Timed work always runs real compiler
// and renderer subprocesses; the report layer is pure and injectable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryStats } from './fullstack.mjs';
import { isExecutable, tmpDir, workspaceRoot } from './paths.mjs';
import { run, runOrThrow } from './proc.mjs';
import { TARGETS, WEB_DOM_TARGET } from './targets.mjs';

export const DEFAULT_RUNS = 10;
export const MAX_RUNS = 1000;
export const SPARKLINE_BUCKETS = 24;
export const FIXTURE = 'test/fixtures/bench-suite.opu';
export const COMPETITOR_REASON = 'competitor binaries are not available on this host; no competitor binary was executed and no competitor number was estimated.';
export const BENCH_SUITE_TARGETS = Object.freeze([...TARGETS, 'wasm', WEB_DOM_TARGET]);
export const BENCH_SUITE_FIELDS = Object.freeze([
  'command', 'mode', 'status', 'runs', 'fixture', 'unit', 'sizeUnit',
  'compile', 'render', 'artifacts', 'competitors', 'reason',
]);
export const MEASUREMENT_FIELDS = Object.freeze([
  'status', 'measuredRuns', 'samples', 'p50', 'p95', 'min', 'max',
  'totalMs', 'fpsX10', 'sparkline', 'reason',
]);
export const ARTIFACT_FIELDS = Object.freeze(['target', 'status', 'files', 'bytes', 'reason']);

const FIXTURE_FILE = fileURLToPath(new URL(`../${FIXTURE}`, import.meta.url));
const SPARKLINE_LEVELS = '_.:-=+*#%@';
const SPARKLINE_LAST = BigInt(SPARKLINE_LEVELS.length - 1);
const SPARKLINE_MIDDLE = (SPARKLINE_LAST + 1n) / 2n;
const VIEWPORT = Object.freeze({ width: 800, height: 600 });
const realNow = () => process.hrtime.bigint();

class ToolUnavailableError extends Error {}

function lastLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? 'unknown error';
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? 'unknown error';
}

function ordered(fields, record, label) {
  if (!record || typeof record !== 'object' || fields.some((key) => !(key in record))) {
    throw new Error(`${label} needs a complete record`);
  }
  return Object.fromEntries(fields.map((key) => [key, record[key]]));
}

export function parseSuiteRuns(value = DEFAULT_RUNS) {
  const runs = Number(value);
  if (typeof value === 'boolean' || !Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS) {
    throw new Error(`invalid --runs: ${String(value)} (expected 1..${MAX_RUNS})`);
  }
  return runs;
}

function checkedSamples(samples, runs) {
  if (!Array.isArray(samples)) throw new Error('benchmark suite needs an array of measured ms samples');
  const count = parseSuiteRuns(runs);
  if (samples.length !== count) {
    throw new Error(`benchmark suite needs ${count} measured samples, got ${samples.length}`);
  }
  samples.forEach((ms, index) => {
    if (typeof ms !== 'number' || !Number.isSafeInteger(ms) || ms < 0) {
      throw new Error(`invalid sample at run ${index + 1}: ${String(ms)} (expected finite integer ms >= 0)`);
    }
  });
  return [...samples];
}

function sparkline(samples) {
  const width = Math.min(SPARKLINE_BUCKETS, samples.length);
  const means = [];
  for (let bucket = 0; bucket < width; bucket += 1) {
    const start = Number(BigInt(bucket) * BigInt(samples.length) / BigInt(width));
    const end = Number(BigInt(bucket + 1) * BigInt(samples.length) / BigInt(width));
    let sum = 0n;
    for (let i = start; i < end; i += 1) sum += BigInt(samples[i]);
    means.push(sum / BigInt(end - start));
  }
  let min = means[0];
  let max = means[0];
  for (const mean of means) {
    if (mean < min) min = mean;
    if (mean > max) max = mean;
  }
  const span = max - min;
  return means.map((mean) => {
    const index = span === 0n
      ? SPARKLINE_MIDDLE
      : ((mean - min) * SPARKLINE_LAST * 2n + span) / (span * 2n);
    return SPARKLINE_LEVELS[Number(index > SPARKLINE_LAST ? SPARKLINE_LAST : index)];
  }).join('');
}

// shortcut: whole-millisecond samples keep every derived statistic integral; upgrade to fixed-point microseconds when sub-ms precision is needed.
export function summarize(samples) {
  const values = checkedSamples(samples, samples.length);
  const sorted = [...values].sort((a, b) => a - b);
  const nearestRank = (p) => {
    const rank = Number((BigInt(p) * BigInt(sorted.length) + 99n) / 100n);
    return sorted[rank - 1];
  };
  const total = sorted.reduce((sum, ms) => sum + BigInt(ms), 0n);
  if (total <= 0n) throw new Error('benchmark suite needs measurable elapsed ms');
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('benchmark suite total ms is out of range');
  const totalMs = Number(total);
  const fpsX10 = Number((BigInt(values.length) * 10000n * 2n + total) / (total * 2n));
  if (!Number.isSafeInteger(fpsX10) || fpsX10 < 0) throw new Error('benchmark suite fps x10 is out of range');
  return {
    p50: nearestRank(50),
    p95: nearestRank(95),
    min: sorted[0],
    max: sorted.at(-1),
    totalMs,
    fpsX10,
    sparkline: sparkline(values),
  };
}

export function measureRuns({ runs, now = realNow, run: work }) {
  const count = parseSuiteRuns(runs);
  if (typeof now !== 'function' || typeof work !== 'function') {
    throw new Error('benchmark suite needs an injected clock and work function');
  }
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const start = now();
    if (typeof start !== 'bigint' || start < 0n) throw new Error('benchmark clock needs nonnegative bigint nanoseconds');
    work(index);
    const end = now();
    if (typeof end !== 'bigint' || end < start) throw new Error('benchmark clock moved backwards');
    const ms = Number((end - start + 999999n) / 1000000n);
    if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('benchmark elapsed ms is out of range');
    samples.push(ms);
  }
  return checkedSamples(samples, count);
}

export function measurementRecord({ runs, samples = [], status = 'PASS', reason = null } = {}) {
  const count = parseSuiteRuns(runs);
  if (status === 'SKIP') {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('SKIP needs a concrete reason');
    return ordered(MEASUREMENT_FIELDS, {
      status,
      measuredRuns: 0,
      samples: [],
      p50: null,
      p95: null,
      min: null,
      max: null,
      totalMs: null,
      fpsX10: null,
      sparkline: null,
      reason,
    }, 'benchmark measurement');
  }
  if (status !== 'PASS') throw new Error(`unsupported benchmark measurement status: ${String(status)}`);
  const values = checkedSamples(samples, count);
  return ordered(MEASUREMENT_FIELDS, {
    status,
    measuredRuns: values.length,
    samples: values,
    ...summarize(values),
    reason: null,
  }, 'benchmark measurement');
}

export function artifactRecord({ target, status, files, bytes, reason }) {
  if (!BENCH_SUITE_TARGETS.includes(target)) throw new Error(`unknown benchmark target: ${String(target)}`);
  if (status === 'SKIP') {
    if (typeof reason !== 'string' || !reason.trim()) throw new Error('SKIP needs a concrete reason');
    return ordered(ARTIFACT_FIELDS, { target, status, files: null, bytes: null, reason }, 'benchmark artifact');
  }
  if (status !== 'PASS') throw new Error(`unsupported benchmark artifact status: ${String(status)}`);
  if (!Number.isSafeInteger(files) || files <= 0 || !Number.isSafeInteger(bytes) || bytes <= 0 || reason !== null) {
    throw new Error('benchmark artifact needs positive measured file and byte counts');
  }
  return ordered(ARTIFACT_FIELDS, { target, status, files, bytes, reason: null }, 'benchmark artifact');
}

export function benchSuiteRecord({ runs, status, compile, render, artifacts, reason = null } = {}) {
  const count = parseSuiteRuns(runs);
  if (!['PASS', 'PARTIAL', 'SKIP'].includes(status)) throw new Error(`unsupported benchmark status: ${String(status)}`);
  if ((status === 'SKIP' || status === 'PARTIAL') && (typeof reason !== 'string' || !reason.trim())) {
    throw new Error(`${status} needs a concrete reason`);
  }
  if (!Array.isArray(artifacts) || artifacts.length !== BENCH_SUITE_TARGETS.length
    || artifacts.some((entry, index) => entry?.target !== BENCH_SUITE_TARGETS[index])) {
    throw new Error('benchmark suite needs 10 target rows in fixed order');
  }
  return ordered(BENCH_SUITE_FIELDS, {
    command: 'bench',
    mode: 'suite',
    status,
    runs: count,
    fixture: FIXTURE,
    unit: 'ms',
    sizeUnit: 'bytes',
    compile: ordered(MEASUREMENT_FIELDS, compile, 'benchmark measurement'),
    render: ordered(MEASUREMENT_FIELDS, render, 'benchmark measurement'),
    artifacts: artifacts.map((entry) => ordered(ARTIFACT_FIELDS, entry, 'benchmark artifact')),
    competitors: 'not measured',
    reason: reason ? `${reason} ${COMPETITOR_REASON}` : COMPETITOR_REASON,
  }, 'benchmark suite');
}

export function benchSuiteJson(record) {
  const top = ordered(BENCH_SUITE_FIELDS, record, 'benchmark suite');
  top.compile = ordered(MEASUREMENT_FIELDS, top.compile, 'benchmark measurement');
  top.render = ordered(MEASUREMENT_FIELDS, top.render, 'benchmark measurement');
  top.artifacts = top.artifacts.map((entry) => ordered(ARTIFACT_FIELDS, entry, 'benchmark artifact'));
  return JSON.stringify(top);
}

function cell(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return (value.map(String).join(', ') || '[]').replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
  return String(value).replace(/\r?\n/g, ' ').replaceAll('|', '\\|');
}

export function benchSuiteMarkdown(record) {
  const normalized = JSON.parse(benchSuiteJson(record));
  const simple = BENCH_SUITE_FIELDS.filter((key) => !['compile', 'render', 'artifacts'].includes(key));
  const rows = [
    ...simple.map((key) => [key, normalized[key]]),
    ...MEASUREMENT_FIELDS.map((key) => [`compile.${key}`, normalized.compile[key]]),
    ...MEASUREMENT_FIELDS.map((key) => [`render.${key}`, normalized.render[key]]),
  ];
  return [
    '# Opurom benchmark suite',
    '',
    '| field | value |',
    '| --- | --- |',
    ...rows.map(([field, value]) => `| ${field} | ${cell(value)} |`),
    '',
    `| ${ARTIFACT_FIELDS.join(' | ')} |`,
    `| ${ARTIFACT_FIELDS.map(() => '---').join(' | ')} |`,
    ...normalized.artifacts.map((entry) => `| ${ARTIFACT_FIELDS.map((key) => cell(entry[key])).join(' | ')} |`),
    '',
    'Elapsed samples are integer milliseconds from real subprocess runs; p50/p95 are nearest ranks and fpsX10 uses integer arithmetic.',
    'Artifact bytes come from fs.statSync on generated files. Reports contain elapsed durations only, not calendar timestamps.',
    `Competitors: not measured. ${COMPETITOR_REASON}`,
  ].join('\n');
}

// Read-only sibling target directories and explicit PATH; no cargo build can enter a timed run.
function findTool({ name, names, repo, injected, root, envPath }) {
  if (injected) {
    const resolved = path.resolve(String(injected));
    if (!isExecutable(resolved)) throw new Error(`injected ${name} is not executable: ${resolved}`);
    return resolved;
  }
  const dirs = [
    path.join(root, repo, 'target', 'debug'),
    path.join(root, repo, 'target', 'release'),
    ...String(envPath ?? '').split(path.delimiter),
  ];
  for (const dir of dirs) {
    if (!dir) continue;
    for (const binary of names) {
      const candidate = path.join(dir, binary);
      if (isExecutable(candidate)) return path.resolve(candidate);
    }
  }
  throw new ToolUnavailableError(
    `${name} unavailable: no executable in PATH or ${path.join(root, repo, 'target', '{debug,release}')}; PATH=${String(envPath || '<empty>')}`,
  );
}

function compileOnce({ opuromc, src, tmp, index }) {
  const irFile = path.join(tmp, `compile-${index + 1}.opuir.json`);
  fs.rmSync(irFile, { force: true });
  runOrThrow(opuromc, ['compile', src, '-o', irFile]);
  const stats = fs.statSync(irFile);
  const parsed = JSON.parse(fs.readFileSync(irFile, 'utf8'));
  if (!stats.isFile() || stats.size <= 0 || parsed?.ir !== '0.1.0') {
    throw new Error(`compile run ${index + 1} produced no valid IR`);
  }
  return irFile;
}

function wroteFrame(frame) {
  try {
    return fs.statSync(frame).size > 0;
  } catch {
    return false;
  }
}

function renderOnce({ renderBin, irFile, frame }) {
  fs.rmSync(frame, { force: true });
  const result = run(renderBin, [irFile, String(VIEWPORT.width), String(VIEWPORT.height), frame], { timeout: 30000 });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0) throw new Error(`renderer failed (exit ${result.status}): ${lastLine(output)}`);
  if (!/^digest=/m.test(output) || !/^dirty=/m.test(output) || !wroteFrame(frame)) {
    throw new Error('renderer produced no complete frame');
  }
}

function emitArtifacts({ opuromc, irFile, tmp }) {
  const root = path.join(tmp, 'targets');
  fs.mkdirSync(root, { recursive: true });
  return BENCH_SUITE_TARGETS.map((target) => {
    const out = path.join(root, target);
    fs.mkdirSync(out, { recursive: true });
    let result;
    try {
      result = run(opuromc, ['target', irFile, '--target', target, '-o', out]);
    } catch (error) {
      return artifactRecord({ target, status: 'SKIP', reason: lastLine(error.message) });
    }
    if (result.status !== 0) {
      return artifactRecord({
        target,
        status: 'SKIP',
        reason: `opuromc target --target ${target} failed (exit ${result.status}): ${firstLine(`${result.stdout}${result.stderr}`)}`,
      });
    }
    const stats = directoryStats(out);
    if (stats.files <= 0 || stats.bytes <= 0) {
      return artifactRecord({ target, status: 'SKIP', reason: `emitter --target ${target} produced no nonempty files` });
    }
    return artifactRecord({ target, status: 'PASS', files: stats.files, bytes: stats.bytes, reason: null });
  });
}

function skippedRecord(runs, reason) {
  const measurement = measurementRecord({ runs, status: 'SKIP', reason });
  return benchSuiteRecord({
    runs,
    status: 'SKIP',
    compile: measurement,
    render: measurement,
    artifacts: BENCH_SUITE_TARGETS.map((target) => artifactRecord({ target, status: 'SKIP', reason })),
    reason,
  });
}

export function benchSuite({
  runs = DEFAULT_RUNS, root = workspaceRoot(), envPath = process.env.PATH ?? '',
  compiler = null, renderer = null, log = console.log, json = false, markdown = false,
  keep = false, now = realNow, sampleSource = null,
} = {}) {
  const count = parseSuiteRuns(runs);
  const src = FIXTURE_FILE;
  if (!fs.existsSync(src)) throw new Error(`benchmark fixture not found: ${src}`);
  let tmp = null;
  let record;
  try {
    const opuromc = findTool({
      name: 'opuromc', names: ['opuromc'], repo: 'opurom-lang', injected: compiler, root, envPath,
    });
    const renderBin = findTool({
      name: 'opurom-render', names: ['opurom-render', 'opurom_render'],
      repo: 'opurom-render', injected: renderer, root, envPath,
    });
    tmp = tmpDir('bench-suite-');
    const compileSample = (index) => compileOnce({ opuromc, src, tmp, index });
    const source = typeof sampleSource === 'function' ? sampleSource : null;
    let irFile;
    let compileSamples;
    if (source) {
      irFile = compileSample(0);
      compileSamples = checkedSamples(source({ stage: 'compile', runs: count, src, now }), count);
    } else {
      const irFiles = [];
      compileSamples = measureRuns({
        runs: count,
        now,
        run: (index) => irFiles.push(compileSample(index)),
      });
      irFile = irFiles.at(-1);
    }
    const renderSamples = source
      ? checkedSamples(source({ stage: 'render', runs: count, src: irFile, now }), count)
      : measureRuns({
        runs: count,
        now,
        run: (index) => renderOnce({
          renderBin, irFile, frame: path.join(tmp, `frame-${index + 1}.ppm`),
        }),
      });
    const artifacts = emitArtifacts({ opuromc, irFile, tmp });
    const skippedTargets = artifacts.filter((entry) => entry.status === 'SKIP').map((entry) => entry.target);
    record = benchSuiteRecord({
      runs: count,
      status: skippedTargets.length ? 'PARTIAL' : 'PASS',
      compile: measurementRecord({ runs: count, samples: compileSamples }),
      render: measurementRecord({ runs: count, samples: renderSamples }),
      artifacts,
      reason: skippedTargets.length ? `unmeasured emitter targets: ${skippedTargets.join(', ')}.` : null,
    });
  } catch (error) {
    if (!(error instanceof ToolUnavailableError)) throw error;
    record = skippedRecord(count, error.message);
  } finally {
    if (tmp && !keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
  log(markdown || !json ? benchSuiteMarkdown(record) : benchSuiteJson(record));
  return { record, exitCode: 0 };
}
