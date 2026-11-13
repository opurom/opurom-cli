import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import {
  formatEnvironment, formatCompareReport, environmentDescription,
} from '../lib/profile.mjs';
import {
  formatProfileReport, machineBackend, machineReport, measureRenderRuns, profileStats,
} from '../lib/async_runtime.mjs';

const SOURCE_CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOP_KEYS = [
  'command', 'mode', 'frames', 'p50', 'p95', 'min', 'max', 'unit', 'backends', 'byteEqual', 'reason',
];
const BACKEND_KEYS = ['name', 'frames', 'p50', 'p95', 'min', 'max', 'reason'];
const STATS_KEYS = ['p50', 'p95', 'min', 'max'];

const COMPILER_STUB = `#!/bin/sh
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4" ;;
  targets) printf 'web\\nnative\\n' ;;
  target) mkdir -p "$6"; printf 'stub\\n' > "$6/stub.txt" ;;
  *) exit 1 ;;
esac
`;

const RENDERER_STUB = `#!/bin/sh
printf 'P6\\n1 1\\n255\\n' > "$4"
if [ "$5" = "--commands" ]; then printf '%s' '{"commands":[]}' > "$6"; fi
printf 'digest=0123456789abcdef\\n'
printf 'dirty=1\\n'
`;

const GPU_EQUAL_STUB = `#!/bin/sh
printf 'P6\\n1 1\\n255\\n' > "$3"
`;

const GPU_FAILING_STUB = `#!/bin/sh
printf 'error: MetalUnavailable: no Metal device on this host\\n' >&2
exit 1
`;

const CARGO_STUB = `#!/bin/sh
exit 0
`;

function writeStub(base, name, body) {
  const file = path.join(base, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function writeTools(base, { gpu = GPU_EQUAL_STUB, cargo = true } = {}) {
  writeStub(base, 'opuromc', COMPILER_STUB);
  writeStub(base, 'opurom-render', RENDERER_STUB);
  if (gpu) writeStub(base, 'opurom-gpu', gpu);
  if (cargo) writeStub(base, 'cargo', CARGO_STUB);
}

function writeSource(base) {
  const src = path.join(base, 'main.opu');
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  return src;
}

function isolatedCli(base) {
  const cliRoot = path.join(base, 'workspace', 'opurom-cli');
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.cpSync(path.join(SOURCE_CLI_ROOT, 'lib'), path.join(cliRoot, 'lib'), { recursive: true });
  fs.cpSync(path.join(SOURCE_CLI_ROOT, 'bin'), path.join(cliRoot, 'bin'), { recursive: true });
  return path.join(cliRoot, 'bin', 'opurom.mjs');
}

function runCli(cli, base, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: base,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [base, '/usr/bin', '/bin'].join(path.delimiter),
      HOME: base,
    },
  });
}

function parseReport(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^\{[^\n]*\}\n$/);
  const text = result.stdout.trimEnd();
  const json = JSON.parse(text);
  assert.equal(result.stdout, `${JSON.stringify(json)}\n`);
  return json;
}

function assertSchema(json, command, mode) {
  assert.deepEqual(Object.keys(json), TOP_KEYS);
  assert.equal(json.command, command);
  assert.equal(json.mode, mode);
  assert.equal(json.unit, 'ms');
  assert.ok(Number.isInteger(json.frames));
  assert.ok(Array.isArray(json.backends));
  assert.ok(json.byteEqual === null || typeof json.byteEqual === 'boolean');
  assert.ok(json.reason === null || typeof json.reason === 'string');
  if (json.frames === 0) {
    for (const key of STATS_KEYS) assert.equal(json[key], null);
  } else {
    for (const key of STATS_KEYS) assert.ok(Number.isFinite(json[key]) && json[key] >= 0);
    assert.ok(json.min <= json.p50 && json.p50 <= json.p95 && json.p95 <= json.max);
  }
}

function assertBackend(backend, name, measured) {
  assert.deepEqual(Object.keys(backend), BACKEND_KEYS);
  assert.equal(backend.name, name);
  assert.equal(backend.frames, measured ? 1 : 0);
  if (measured) {
    for (const key of STATS_KEYS) assert.ok(Number.isFinite(backend[key]) && backend[key] >= 0);
    assert.equal(backend.reason, null);
  } else {
    for (const key of STATS_KEYS) assert.equal(backend[key], null);
    assert.equal(typeof backend.reason, 'string');
  }
}

test('machine reports derive statistics from real renderer samples and reject invalid values', () => {
  const base = tmpDir('json-samples-');
  try {
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const irFile = path.join(base, 'app.opuir.json');
    fs.writeFileSync(irFile, '{}');
    const samples = measureRenderRuns({
      renderBin: renderer, irFile, frame: path.join(base, 'frame.ppm'), count: 4,
    });
    const stats = profileStats(samples);
    assert.ok(stats);
    const json = JSON.parse(machineReport({ command: 'profile', mode: 'single', samples }));
    assert.deepEqual(Object.keys(json), TOP_KEYS);
    assert.equal(json.frames, samples.length);
    for (const key of STATS_KEYS) assert.equal(json[key], stats[key]);

    const backend = machineBackend('software', [samples[0]]);
    assert.deepEqual(Object.keys(backend), BACKEND_KEYS);
    for (const key of STATS_KEYS) assert.equal(backend[key], samples[0]);

    for (const invalid of [[Number.NaN], [-1], [Infinity]]) {
      assert.throws(
        () => machineReport({ command: 'profile', mode: 'single', samples: invalid }),
        /finite measured ms values/,
      );
    }
    assert.throws(
      () => machineReport({ command: 'profile', mode: 'single', samples: '1,2' }),
      /measured ms samples/,
    );
    const badBackend = machineBackend('gpu', []);
    badBackend.p50 = Number.NaN;
    assert.throws(
      () => machineReport({
        command: 'bench', mode: 'compare', samples: [1], backends: [badBackend],
      }),
      /finite measured ms values/,
    );
    assert.throws(
      () => machineReport({ command: '', mode: 'single', samples: [1] }),
      /command and mode/,
    );
    assert.throws(
      () => machineReport({
        command: 'bench', mode: 'compare', samples: [1], byteEqual: 'yes',
      }),
      /byte equality result/,
    );
    const empty = JSON.parse(machineReport({
      command: 'profile', mode: 'single', samples: [], reason: 'tools unavailable',
    }));
    assert.equal(empty.frames, 0);
    for (const key of STATS_KEYS) assert.equal(empty[key], null);
    assert.equal(empty.reason, 'tools unavailable');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('human-readable profile and compare reports stay byte-identical without --json', () => {
  const profile = formatProfileReport({
    src: '/a/main.opu', frames: 4, stats: profileStats([10, 20, 30, 40]), reason: null,
  });
  assert.equal(profile, [
    'OPUROM profile (MEASURED software-raster timings on this host)',
    'src: /a/main.opu',
    'frames: 4 measured / 4 requested (800x600, one real opurom-render process per frame)',
    'p50: 25 ms',
    'p95: 38.5 ms',
    'min: 10 ms',
    'max: 40 ms',
    'achieved fps: 40 (4 frames / 100 ms of measured frame time)',
    'Note: software-raster timings on this host, NOT a device/competitor benchmark. No GPU/device matrix is measured.',
  ].join('\n'));

  const env = environmentDescription({
    cpus: [{ model: 'Test CPU' }],
    release: 'test-release',
    nodeVersion: 'v0.0.0-test',
    raster: 'software raster + GPU compute backend (test)',
  });
  const compare = formatCompareReport({
    src: '/a/main.opu',
    software: { ms: 40 },
    gpu: { ms: 10 },
    equality: 'byte-equal (test sha256, 12 B each)',
    reason: null,
    env,
  });
  assert.equal(compare, [
    'OPUROM bench --compare (MEASURED software vs GPU backend, this host)',
    'src: /a/main.opu',
    'software renderer (opurom-render): 40 ms',
    'gpu backend (opurom-gpu): 10 ms',
    'byte equality of the two outputs: byte-equal (test sha256, 12 B each)',
    'speed: gpu is 4.00x the software renderer time (measured; byte-equal outputs)',
    formatEnvironment(env),
    'Note: both timings are on this host, NOT a device/competitor benchmark.',
    'No competitor binary was executed and no competitor number was estimated.',
  ].join('\n'));
});

test('bench --json emits one stable object from measured step timings', () => {
  const base = tmpDir('json-bench-');
  try {
    const cli = isolatedCli(base);
    writeTools(base);
    const src = writeSource(base);
    const result = runCli(cli, base, ['bench', '--src', src, '--out', path.join(base, 'out'), '--json']);
    const json = parseReport(result);
    assertSchema(json, 'bench', 'single');
    assert.equal(json.frames, 3);
    assert.deepEqual(json.backends, []);
    assert.equal(json.byteEqual, null);
    assert.equal(json.reason, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --full --json emits one stable object from measured full-run timings', () => {
  const base = tmpDir('json-bench-full-');
  try {
    const cli = isolatedCli(base);
    writeTools(base);
    const src = writeSource(base);
    const result = runCli(cli, base, [
      'bench', '--src', src, '--out', path.join(base, 'out'), '--full', '--json',
    ]);
    const json = parseReport(result);
    assertSchema(json, 'bench', 'full');
    assert.ok(json.frames >= 3);
    assert.deepEqual(json.backends, []);
    assert.equal(json.byteEqual, null);
    assert.equal(json.reason, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('profile --json emits one stable object from real frame timings', () => {
  const base = tmpDir('json-profile-');
  try {
    const cli = isolatedCli(base);
    writeTools(base, { cargo: false });
    const src = writeSource(base);
    const result = runCli(cli, base, ['profile', '--src', src, '--frames', '3', '--json']);
    const json = parseReport(result);
    assertSchema(json, 'profile', 'single');
    assert.equal(json.frames, 3);
    assert.deepEqual(json.backends, []);
    assert.equal(json.byteEqual, null);
    assert.equal(json.reason, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('profile --repeat --json reports only the measured runs after warmup', () => {
  const base = tmpDir('json-repeat-');
  try {
    const cli = isolatedCli(base);
    writeTools(base, { cargo: false });
    const src = writeSource(base);
    const result = runCli(cli, base, ['profile', '--src', src, '--repeat', '3', '--json']);
    const json = parseReport(result);
    assertSchema(json, 'profile', 'repeat');
    assert.equal(json.frames, 1);
    assert.equal(json.p50, json.min);
    assert.equal(json.p95, json.max);
    assert.equal(json.reason, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --compare --json reports both measured backends and byte equality', () => {
  const base = tmpDir('json-compare-');
  try {
    const cli = isolatedCli(base);
    writeTools(base, { cargo: false });
    const src = writeSource(base);
    const result = runCli(cli, base, ['bench', '--src', src, '--compare', '--json']);
    const json = parseReport(result);
    assertSchema(json, 'bench', 'compare');
    assert.equal(json.frames, 2);
    assert.equal(json.byteEqual, true);
    assert.equal(json.reason, null);
    assert.equal(json.backends.length, 2);
    assertBackend(json.backends[0], 'software', true);
    assertBackend(json.backends[1], 'gpu', true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('bench --compare --json keeps an unmeasured backend null instead of substituting a value', () => {
  const base = tmpDir('json-compare-missing-');
  try {
    const cli = isolatedCli(base);
    writeTools(base, { gpu: GPU_FAILING_STUB, cargo: false });
    const src = writeSource(base);
    const result = runCli(cli, base, ['bench', '--src', src, '--compare', '--json']);
    const json = parseReport(result);
    assertSchema(json, 'bench', 'compare');
    assert.equal(json.frames, 1);
    assert.equal(json.byteEqual, null);
    assert.equal(json.reason, null);
    assert.equal(json.backends.length, 2);
    assertBackend(json.backends[0], 'software', true);
    assertBackend(json.backends[1], 'gpu', false);
    assert.match(json.backends[1].reason, /opurom-gpu raster failed/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
