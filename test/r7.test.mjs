import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { percentile } from '../lib/r4.mjs';
import {
  DEFAULT_REPEAT, DEFAULT_WARMUP, MAX_REPEAT, compareBackends, environmentDescription,
  formatCompareReport, formatEnvironment, formatRepeatReport, measuredRuns, parseRepeatCount,
  profileRepeat, repeatStats, warmupFor,
} from '../lib/r7.mjs';

const COMPILER_STUB = `#!/bin/sh
printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4"
`;

const RENDERER_STUB = `#!/bin/sh
printf 'P6\\n1 1\\n255\\n' > "$4"
printf '%s' '{"commands":[]}' > "$6"
printf 'digest=0123456789abcdef\\n'
printf 'dirty=1\\n'
`;

// Writes the same bytes as the renderer stub: the compare result must be byte-equal.
const GPU_EQUAL_STUB = `#!/bin/sh
printf 'P6\\n1 1\\n255\\n' > "$3"
`;

const GPU_DIFFERENT_STUB = `#!/bin/sh
printf 'P6\\n1 1\\n255\\nX' > "$3"
`;

const GPU_FAILING_STUB = `#!/bin/sh
printf 'error: MetalUnavailable: no Metal device on this host\\n' >&2
exit 1
`;

function writeStub(base, name, body) {
  const file = path.join(base, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function withCleanPath(dir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = dir;
  try {
    return fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

test('percentile math on known arrays is exact', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 95) - 4.8) < 1e-12);
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.ok(Math.abs(percentile([10, 20, 30, 40], 95) - 38.5) < 1e-12);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, Number.NaN], 50), null);
});

test('repeat statistics report the median, p95, min, max and fps of the measured runs', () => {
  const stats = repeatStats([10, 20, 30, 40]);
  assert.equal(stats.count, 4);
  assert.equal(stats.median, 25);
  assert.equal(stats.p50, 25);
  assert.ok(Math.abs(stats.p95 - 38.5) < 1e-12);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 40);
  assert.equal(stats.totalMs, 100);
  assert.equal(stats.fps, 40);
  assert.equal(repeatStats([]), null);
  assert.equal(repeatStats([1, -2]), null);
});

test('the warmup runs are excluded and the measured count is the remainder', () => {
  assert.equal(DEFAULT_WARMUP, 2);
  assert.equal(warmupFor(10), 2);
  assert.equal(measuredRuns(10), 8);
  // One measured run must survive, so the warmup shrinks for tiny repeat counts.
  assert.equal(warmupFor(1), 0);
  assert.equal(measuredRuns(1), 1);
  assert.equal(warmupFor(2), 1);
  assert.equal(measuredRuns(2), 1);
  assert.equal(warmupFor(3), 2);
  assert.equal(measuredRuns(3), 1);
});

test('repeat count defaults to 10 and rejects values outside 1..600', () => {
  assert.equal(DEFAULT_REPEAT, 10);
  assert.equal(parseRepeatCount(), 10);
  assert.equal(parseRepeatCount('1'), 1);
  assert.equal(parseRepeatCount('600'), 600);
  assert.equal(parseRepeatCount(30), 30);
  for (const value of ['0', '-1', '601', '3.5', 'nope', true, Number.NaN, Infinity]) {
    assert.throws(() => parseRepeatCount(value), /invalid --repeat: .* \(expected 1\.\.600\)/);
  }
  assert.equal(MAX_REPEAT, 600);
});

test('the environment description states CPU, OS release, Node version and the raster kind', () => {
  const env = environmentDescription();
  assert.match(env.cpuModel, /n\/a \(|Apple|CPU|Intel|AMD/i);
  assert.match(env.osRelease, /n\/a \(|\d/);
  assert.match(env.nodeVersion, /^v\d/);
  assert.match(env.raster, /software raster/);
  const text = formatEnvironment(env);
  assert.match(text, /environment: cpu=/);
  assert.match(text, /environment: os release=/);
  assert.match(text, /environment: node=v/);
  assert.match(text, /environment: raster=software raster/);
  const empty = formatEnvironment(environmentDescription({ cpus: [], release: '', nodeVersion: '' }));
  assert.match(empty, /environment: cpu=n\/a \(no CPU model reported by os\.cpus\(\)\)/);
  assert.match(empty, /environment: os release=n\/a \(no OS release reported by os\.release\(\)\)/);
  assert.match(empty, /environment: node=n\/a \(no Node version reported\)/);
});

test('the repeat report names the excluded warmup and prints the measured statistics', () => {
  const report = formatRepeatReport({
    src: '/a/main.opu',
    repeat: 5,
    warmup: 2,
    measured: 3,
    stats: repeatStats([10, 20, 30]),
    reason: null,
  });
  assert.match(report, /OPUROM profile --repeat/);
  assert.match(report, /warmup excluded: 2/);
  assert.match(report, /3 measured runs/);
  assert.match(report, /median: 20 ms/);
  assert.match(report, /p95: 29 ms/);
  assert.match(report, /min: 10 ms/);
  assert.match(report, /max: 30 ms/);
  assert.match(report, /achieved fps: 50 \(3 measured runs \/ 60 ms of measured time\)/);
  assert.match(report, /environment: cpu=/);
  assert.match(report, /NOT a device\/competitor benchmark/);
  assert.match(report, /no competitor number was estimated/);
});

test('the repeat report prints honest n/a reasons when nothing could be measured', () => {
  const report = formatRepeatReport({
    src: '/a/main.opu', repeat: 5, warmup: 2, measured: 3, stats: null, reason: 'opurom-render not found',
  });
  for (const label of ['median', 'p95', 'min', 'max', 'achieved fps']) {
    assert.match(report, new RegExp(`${label}: n\\/a \\(opurom-render not found\\)`));
  }
});

test('profile --repeat runs the work N times and excludes the warmup from the statistics', () => {
  const base = tmpDir('r7-repeat-');
  try {
    const compiler = writeStub(base, 'opuromc', COMPILER_STUB);
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    const lines = [];
    const code = profileRepeat({
      src, repeat: 5, compiler, renderer, root: base, log: (line) => lines.push(String(line)),
    });
    const report = lines.join('\n');
    assert.equal(code, 0);
    assert.match(report, /warmup excluded: 2/);
    assert.match(report, /3 measured runs/);
    assert.match(report, /median: \d/);
    assert.match(report, /environment: cpu=/);
    assert.match(report, /environment: os release=/);
    assert.match(report, /environment: node=v/);
    assert.match(report, /environment: raster=software raster/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('profile --repeat rejects an invalid repeat count before touching any tool', () => {
  const base = tmpDir('r7-repeat-invalid-');
  try {
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    assert.throws(
      () => profileRepeat({ src, repeat: '0', compiler: '/nonexistent', renderer: '/nonexistent', root: base }),
      /invalid --repeat: 0 \(expected 1\.\.600\)/,
    );
    assert.throws(
      () => profileRepeat({ src, repeat: '601', compiler: '/nonexistent', renderer: '/nonexistent', root: base }),
      /invalid --repeat: 601 \(expected 1\.\.600\)/,
    );
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --compare reports the measured times and the byte-equality result', () => {
  const base = tmpDir('r7-compare-');
  try {
    const compiler = writeStub(base, 'opuromc', COMPILER_STUB);
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const gpu = writeStub(base, 'opurom-gpu', GPU_EQUAL_STUB);
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    const lines = [];
    const code = compareBackends({
      src, compiler, renderer, gpu, root: base, log: (line) => lines.push(String(line)),
    });
    const report = lines.join('\n');
    assert.equal(code, 0);
    assert.match(report, /OPUROM bench --compare/);
    assert.match(report, /software renderer \(opurom-render\): \d+(\.\d+)? ms/);
    assert.match(report, /gpu backend \(opurom-gpu\): \d+(\.\d+)? ms/);
    assert.match(report, /byte equality of the two outputs: byte-equal \([0-9a-f]{64} sha256, \d+ B each\)/);
    assert.match(report, /speed: gpu is [\d.]+x the software renderer time \(measured; byte-equal outputs\)/);
    assert.match(report, /environment: cpu=/);
    assert.match(report, /NOT a device\/competitor benchmark/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --compare refuses a speed claim when the two outputs differ', () => {
  const base = tmpDir('r7-compare-different-');
  try {
    const compiler = writeStub(base, 'opuromc', COMPILER_STUB);
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const gpu = writeStub(base, 'opurom-gpu', GPU_DIFFERENT_STUB);
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    const lines = [];
    compareBackends({ src, compiler, renderer, gpu, root: base, log: (line) => lines.push(String(line)) });
    const report = lines.join('\n');
    assert.match(report, /byte equality of the two outputs: NOT byte-equal/);
    assert.match(report, /speed: n\/a \(outputs are not byte-equal; no speed claim over a different image\)/);
    assert.equal(/speed: gpu is/.test(report), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --compare still prints the software measurement when the GPU backend is unavailable', () => {
  const base = tmpDir('r7-compare-no-gpu-');
  try {
    const compiler = writeStub(base, 'opuromc', COMPILER_STUB);
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    const lines = [];
    const code = withCleanPath(base, () => compareBackends({
      src, compiler, renderer, root: base, log: (line) => lines.push(String(line)),
    }));
    const report = lines.join('\n');
    assert.equal(code, 0);
    assert.match(report, /software renderer \(opurom-render\): \d+(\.\d+)? ms/);
    assert.match(report, /gpu backend \(opurom-gpu\): n\/a \(opurom-gpu unavailable: sibling repo opurom-gpu is absent/);
    assert.match(report, /byte equality of the two outputs: n\/a \(opurom-gpu unavailable: sibling repo opurom-gpu is absent/);
    assert.match(report, /speed: n\/a \(one backend could not be measured\)/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --compare reports the GPU failure reason when the backend refuses to raster', () => {
  const base = tmpDir('r7-compare-gpu-fail-');
  try {
    const compiler = writeStub(base, 'opuromc', COMPILER_STUB);
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const gpu = writeStub(base, 'opurom-gpu', GPU_FAILING_STUB);
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    const lines = [];
    const code = compareBackends({
      src, compiler, renderer, gpu, root: base, log: (line) => lines.push(String(line)),
    });
    const report = lines.join('\n');
    assert.equal(code, 0);
    assert.match(report, /gpu backend \(opurom-gpu\): n\/a \(opurom-gpu raster failed \(exit 1\): error: MetalUnavailable/);
    assert.match(report, /software renderer \(opurom-render\): \d+(\.\d+)? ms/);
    assert.match(report, /byte equality of the two outputs: n\/a \(opurom-gpu raster failed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the compare report never prints a speed ratio over outputs that are not byte-equal', () => {
  const report = formatCompareReport({
    src: '/a/main.opu',
    software: { ms: 40 },
    gpu: { ms: 10 },
    equality: 'NOT byte-equal (software sha256 a vs gpu sha256 b)',
    reason: null,
  });
  assert.match(report, /speed: n\/a \(outputs are not byte-equal/);
  assert.equal(/speed: gpu is/.test(report), false);
});
