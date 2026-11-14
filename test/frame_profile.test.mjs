import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureRenderRuns } from '../lib/async_runtime.mjs';
import {
  FRAME_PROFILE_FIELDS, MAX_FRAMES, SPARKLINE_BUCKETS,
  frameProfileJson, frameProfileMarkdown, frameProfileRecord, frameSparkline,
  parseFrameCount, profileFrames,
} from '../lib/frame_profile.mjs';
import { discoverBinary, tmpDir, workspaceRoot } from '../lib/paths.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));
const SOURCE_CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SAMPLES = [10, 20, 30, 40];
const LEVELS = '_.:-=+*#%@';
const COMPILER_STUB = `#!/bin/sh
printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4"
`;
const RENDERER_STUB = `#!/bin/sh
printf 'P6\\n1 1\\n255\\n' > "$4"
printf 'digest=0123456789abcdef\\n'
printf 'dirty=1\\n'
`;

function writeStub(base, name, body) {
  const file = path.join(base, name);
  fs.writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function writeSource(base) {
  const src = path.join(base, 'main.opu');
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  return src;
}

function writeTools(base) {
  writeStub(base, 'opuromc', COMPILER_STUB);
  writeStub(base, 'opurom-render', RENDERER_STUB);
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

test('frame count defaults to 30 and accepts 1..1000', () => {
  assert.equal(MAX_FRAMES, 1000);
  assert.equal(parseFrameCount(), 30);
  assert.equal(parseFrameCount('1'), 1);
  assert.equal(parseFrameCount('1000'), 1000);
  for (const value of ['0', '-1', '1001', '3.5', 'nope', true, Number.NaN, Infinity]) {
    assert.throws(() => parseFrameCount(value), /invalid --frames: .* \(expected 1\.\.1000\)/);
  }
});

test('hand-computed statistics, fps x10 and sparkline come from injected samples', () => {
  const record = frameProfileRecord({
    src: '/a/main.opu', requestedFrames: 4, samples: SAMPLES, status: 'PASS',
  });
  assert.deepEqual(Object.keys(record), [...FRAME_PROFILE_FIELDS]);
  assert.equal(record.frames, 4);
  assert.equal(record.p50, 25);
  assert.ok(Math.abs(record.p95 - 38.5) < 1e-12);
  assert.equal(record.min, 10);
  assert.equal(record.max, 40);
  assert.equal(record.totalMs, 100);
  assert.equal(record.fpsX10, 400);
  assert.equal(record.sparkline, '_-*@');

  const linear = Array.from({ length: 24 }, (_, index) => index + 1);
  assert.equal(frameSparkline(linear), '__..:::--===+++**###%%@@');
  const many = Array.from({ length: 1000 }, (_, index) => 1 + (index % 97));
  const bounded = frameSparkline(many);
  assert.equal(bounded.length, SPARKLINE_BUCKETS);
  assert.equal(bounded, frameSparkline([...many]));
  assert.ok([...bounded].every((char) => LEVELS.includes(char)));
});

test('frame profile JSON has deterministic keys and exact measured values', () => {
  const build = () => frameProfileRecord({
    src: '/a/main.opu', requestedFrames: 4, samples: SAMPLES, status: 'PASS',
  });
  const expected = '{"command":"profile","mode":"frames","status":"PASS","src":"/a/main.opu","requestedFrames":4,"frames":4,"p50":25,"p95":38.5,"min":10,"max":40,"totalMs":100,"fpsX10":400,"sparkline":"_-*@","unit":"ms","reason":null}';
  assert.equal(frameProfileJson(build()), expected);
  assert.equal(frameProfileJson(build()), frameProfileJson(build()));
});

test('frame profile Markdown has a fixed schema and the same measured values', () => {
  const record = frameProfileRecord({
    src: '/a/main.opu', requestedFrames: 4, samples: SAMPLES, status: 'PASS',
  });
  assert.equal(frameProfileMarkdown(record), [
    '# OPUROM frame profile',
    '',
    '| field | value |',
    '| --- | --- |',
    '| command | profile |',
    '| mode | frames |',
    '| status | PASS |',
    '| src | /a/main.opu |',
    '| requestedFrames | 4 |',
    '| frames | 4 |',
    '| p50 | 25 |',
    '| p95 | 38.5 |',
    '| min | 10 |',
    '| max | 40 |',
    '| totalMs | 100 |',
    '| fpsX10 | 400 |',
    '| sparkline | _-*@ |',
    '| unit | ms |',
    '| reason | null |',
    '',
    'Each statistic comes from one `opurom-render` process per measured frame; `fpsX10` is ten times the derived fps, rounded to an integer; `sparkline` contains at most 24 ASCII buckets.',
    '`status: SKIP` reports zero measured frames and keeps every measured field `null`.',
  ].join('\n'));
});

test('non-finite, negative and mismatched samples are errors', () => {
  for (const bad of [Number.NaN, -1, Infinity, '1', null]) {
    assert.throws(
      () => frameProfileRecord({
        src: '/a/main.opu', requestedFrames: 4, samples: [10, bad, 30, 40], status: 'PASS',
      }),
      /invalid sample at frame 2/,
    );
  }
  assert.throws(
    () => frameProfileRecord({
      src: '/a/main.opu', requestedFrames: 4, samples: [10, 20, 30], status: 'PASS',
    }),
    /needs 4 measured samples/,
  );
  assert.throws(
    () => frameProfileRecord({
      src: '/a/main.opu', requestedFrames: 2, samples: [0, 0], status: 'PASS',
    }),
    /renderer produced no measurable elapsed time/,
  );
});

test('injected sample sources avoid wall-clock timing', () => {
  const base = tmpDir('frame-profile-injected-');
  try {
    const src = writeSource(base);
    const arrayLines = [];
    assert.equal(profileFrames({
      src, frames: 4, samples: SAMPLES, root: base, envPath: '', log: (line) => arrayLines.push(String(line)),
    }), 0);
    const arrayJson = JSON.parse(arrayLines.join('\n'));
    assert.equal(arrayJson.fpsX10, 400);
    assert.equal(arrayJson.sparkline, '_-*@');

    let receivedClock = false;
    const sourceLines = [];
    assert.equal(profileFrames({
      src,
      frames: 4,
      root: base,
      envPath: '',
      sampleSource: ({ frames, now }) => {
        assert.equal(frames, 4);
        receivedClock = typeof now === 'function';
        return SAMPLES;
      },
      log: (line) => sourceLines.push(String(line)),
    }), 0);
    assert.equal(receivedClock, true);
    assert.equal(JSON.parse(sourceLines.join('\n')).status, 'PASS');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an injected clock produces exact samples from a stub renderer', () => {
  const base = tmpDir('frame-profile-clock-');
  try {
    const renderer = writeStub(base, 'opurom-render', RENDERER_STUB);
    const irFile = path.join(base, 'app.opuir.json');
    fs.writeFileSync(irFile, '{}');
    let tick = 0;
    const samples = measureRenderRuns({
      renderBin: renderer,
      irFile,
      frame: path.join(base, 'frame.ppm'),
      count: 3,
      now: () => { tick += 5; return tick; },
    });
    assert.deepEqual(samples, [5, 5, 5]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the CLI reports missing source and frame bounds before invoking tools', () => {
  assert.throws(
    () => profileFrames({ frames: 4, samples: SAMPLES }),
    /missing required option --src/,
  );
  const missing = spawnSync(process.execPath, [CLI, 'profile', '--frames', '3', '--json'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /missing required option --src/);
  const bounds = spawnSync(process.execPath, [
    CLI, 'profile', '--src', '/nonexistent/main.opu', '--frames', '1001', '--json',
  ], { encoding: 'utf8' });
  assert.equal(bounds.status, 1);
  assert.match(bounds.stderr, /invalid --frames: 1001 \(expected 1\.\.1000\)/);
});

test('a missing renderer binary is a clean SKIP with a concrete reason', () => {
  const base = tmpDir('frame-profile-skip-');
  try {
    const compiler = writeStub(base, 'opuromc', COMPILER_STUB);
    const src = writeSource(base);
    const jsonLines = [];
    const code = withCleanPath(base, () => profileFrames({
      src, frames: 2, compiler, root: base, envPath: base, log: (line) => jsonLines.push(String(line)),
    }));
    assert.equal(code, 0);
    const json = JSON.parse(jsonLines.join('\n'));
    assert.equal(json.status, 'SKIP');
    assert.equal(json.requestedFrames, 2);
    assert.equal(json.frames, 0);
    assert.match(json.reason, /^opurom-render unavailable: no executable in PATH or/);
    assert.match(json.reason, /opurom-render\/target/);
    for (const key of ['p50', 'p95', 'min', 'max', 'totalMs', 'fpsX10', 'sparkline']) {
      assert.equal(json[key], null, key);
    }
    assert.equal(json.unit, 'ms');

    const markdownLines = [];
    withCleanPath(base, () => profileFrames({
      src, frames: 2, compiler, root: base, envPath: base, markdown: true,
      log: (line) => markdownLines.push(String(line)),
    }));
    const markdown = markdownLines.join('\n');
    assert.match(markdown, /\| status \| SKIP \|/);
    assert.match(markdown, /\| p50 \| null \|/);
    assert.match(markdown, /\| reason \| opurom-render unavailable:/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('CLI --markdown emits the fixed table with measured stub samples', () => {
  const base = tmpDir('frame-profile-cli-markdown-');
  try {
    const cli = isolatedCli(base);
    writeTools(base);
    const src = writeSource(base);
    const result = runCli(cli, base, ['profile', '--src', src, '--frames', '4', '--markdown']);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /^# OPUROM frame profile\n\n\| field \| value \|\n/);
    assert.match(result.stdout, /\| status \| PASS \|/);
    assert.match(result.stdout, /\| fpsX10 \| \d+ \|/);
    const lines = result.stdout.split('\n');
    const fields = lines.slice(4, 4 + FRAME_PROFILE_FIELDS.length)
      .map((line) => line.slice(2, line.indexOf(' |')));
    assert.deepEqual(fields, [...FRAME_PROFILE_FIELDS]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('real renderer samples are positive and finite', (t) => {
  const renderBin = discoverBinary(['opurom-render', 'opurom_render'], { root: workspaceRoot() });
  if (!renderBin) return t.skip('opurom-render binary unavailable');
  const base = tmpDir('frame-profile-real-');
  try {
    const irFile = path.join(base, 'app.opuir.json');
    fs.copyFileSync(new URL('./fixtures/inspect.opuir.json', import.meta.url), irFile);
    const samples = measureRenderRuns({
      renderBin, irFile, frame: path.join(base, 'frame.ppm'), count: 3,
    });
    assert.equal(samples.length, 3);
    for (const ms of samples) assert.ok(Number.isFinite(ms) && ms > 0, `sample ${ms}`);
    const record = frameProfileRecord({
      src: '/a/main.opu', requestedFrames: 3, samples, status: 'PASS',
    });
    for (const key of ['p50', 'p95', 'min', 'max', 'totalMs']) {
      assert.ok(Number.isFinite(record[key]) && record[key] > 0, key);
    }
    assert.ok(Number.isSafeInteger(record.fpsX10) && record.fpsX10 > 0);
    assert.equal(record.sparkline.length, 3);
    assert.ok([...record.sparkline].every((char) => LEVELS.includes(char)));
    t.diagnostic(frameProfileJson(record));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
