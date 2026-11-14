import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { measureRenderRuns } from '../lib/async_runtime.mjs';
import {
  FRAME_PROFILE_FIELDS, FRAME_PROFILE_TIER_FIELDS, MAX_FRAMES, SPARKLINE_BUCKETS,
  frameProfileJson, frameProfileMarkdown, frameProfileRecord, frameSparkline,
  parseDegradeHz, parseFrameCount, profileFrames, summarizeTiers,
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

// A stub renderer that mirrors opurom-render's auto-degrade state machine from
// its argv, so the CLI wiring is exercised without the real binary.
const DEGRADE_RENDERER_STUB = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const at = (name) => { const i = argv.indexOf(name); return i === -1 ? null : argv[i + 1]; };
let tier = 0;
const rate = at('--auto-degrade');
if (rate) {
  const target = rate === '120' ? 8 : 16;
  const samples = at('--frame-ms').split(',').map(Number);
  const n = Number(at('--frame-samples') ?? 20);
  const counts = [0, 0, 0];
  let good = 0;
  for (let f = 1; f <= n; f += 1) {
    if (f % 20 === 0) {
      const w = [];
      for (let k = f - 20; k < f; k += 1) w.push(samples[k % samples.length]);
      w.sort((a, b) => a - b);
      const p95 = w[Math.ceil(95 * w.length / 100) - 1];
      if (p95 > target) { tier = Math.min(tier + 1, 2); good = 0; }
      else if (p95 < target * 3 / 4 && tier !== 0) { good += 1; if (good >= 3) { tier = Math.max(tier - 1, 0); good = 0; } }
      else good = 0;
    }
    counts[tier] += 1;
  }
  process.stdout.write('quality=' + ['Full', 'Reduced', 'Minimal'][tier] + '\\n');
}
const out = argv[3];
require('fs').writeFileSync(out, 'P6\\n1 1\\n255\\n');
process.stdout.write('digest=0123456789abcdef\\ndirty=1\\n');
`;

test('parseDegradeHz accepts only 60 or 120 and treats absence as off', () => {
  assert.equal(parseDegradeHz(undefined), null);
  assert.equal(parseDegradeHz(null), null);
  assert.equal(parseDegradeHz('60'), 60);
  assert.equal(parseDegradeHz('120'), 120);
  for (const bad of ['90', '', '60.5', true, 60]) {
    assert.throws(() => parseDegradeHz(bad), /invalid --degrade: .* \(expected 60 or 120\)/);
  }
});

test('summarizeTiers mirrors the renderer policy constant-for-constant', () => {
  const repeat = (value, n) => Array(n).fill(value);
  // Steady fast samples never drop a tier and stay Full.
  assert.deepEqual(summarizeTiers(repeat(5, 60), 60), {
    tiers: [{ tier: 'Full', frames: 60 }], degraded: false, p50: 5, p95: 5,
  });
  // Exactly at the target (16 ms) is not over, so Full is kept.
  assert.equal(summarizeTiers(repeat(16, 40), 60).degraded, false);
  // Sustained slow: the first evaluated window (frames 1..19 still Full, the
  // drop lands on frame 20) degrades one tier, a second window one more.
  assert.deepEqual(summarizeTiers(repeat(30, 60), 60), {
    tiers: [
      { tier: 'Full', frames: 19 },
      { tier: 'Reduced', frames: 20 },
      { tier: 'Minimal', frames: 21 },
    ],
    degraded: true, p50: 30, p95: 30,
  });
  // At 120 fps the target is 8 ms, so 10 ms is over budget and degrades.
  assert.equal(summarizeTiers(repeat(10, 20), 120).degraded, true);
  assert.equal(summarizeTiers(repeat(8, 20), 120).degraded, false);
});

test('summarizeTiers needs three consecutive good windows to promote', () => {
  const slow = Array(20).fill(30); // one bad window -> Reduced at frame 20
  // 20 slow then 40 fast = only two good windows: stays Reduced.
  const twoWindows = summarizeTiers([...slow, ...Array(40).fill(5)], 60);
  assert.equal(twoWindows.degraded, true);
  assert.deepEqual(twoWindows.tiers.at(-1), { tier: 'Reduced', frames: 41 });
  // 20 slow then 60 fast = three good windows: promotes back to Full at frame 80.
  const recovered = summarizeTiers([...slow, ...Array(60).fill(5)], 60);
  assert.equal(recovered.degraded, false);
  assert.deepEqual(recovered.tiers, [
    { tier: 'Full', frames: 20 },
    { tier: 'Reduced', frames: 60 },
  ]);
});

test('frame record adds the tiers field only with --degrade', () => {
  const plain = frameProfileRecord({ src: '/a/main.opu', requestedFrames: 4, samples: SAMPLES, status: 'PASS' });
  assert.deepEqual(Object.keys(plain), [...FRAME_PROFILE_FIELDS]);
  assert.equal('tiers' in plain, false);

  const degraded = frameProfileRecord({
    src: '/a/main.opu', requestedFrames: 4, samples: SAMPLES, status: 'PASS', degradeHz: 60,
  });
  assert.deepEqual(Object.keys(degraded), [...FRAME_PROFILE_TIER_FIELDS]);
  assert.deepEqual(degraded.tiers, [{ tier: 'Full', frames: 4 }]);
  assert.match(frameProfileJson(degraded), /"reason":null,"tiers":\[\{"tier":"Full","frames":4\}\]\}$/);
  assert.match(frameProfileMarkdown(degraded), /\| tiers \| Full:4 \|/);
});

test('--degrade feeds the SAME measured samples through --frame-ms and reports the stub tier', () => {
  const base = tmpDir('frame-profile-degrade-stub-');
  try {
    writeStub(base, 'opuromc', COMPILER_STUB);
    writeStub(base, 'opurom-render', DEGRADE_RENDERER_STUB);
    const src = writeSource(base);

    const slowLines = [];
    withCleanPath(base, () => profileFrames({
      src, frames: 60, degrade: '60', root: base, envPath: base, keep: false,
      samples: Array(60).fill(30), log: (line) => slowLines.push(String(line)),
    }));
    const slow = JSON.parse(slowLines.join('\n'));
    assert.deepEqual(slow.tiers.map((t) => t.tier), ['Full', 'Reduced', 'Minimal']);
    assert.equal(slow.tiers.reduce((sum, t) => sum + t.frames, 0), 60);

    const fastLines = [];
    withCleanPath(base, () => profileFrames({
      src, frames: 60, degrade: '60', root: base, envPath: base,
      samples: Array(60).fill(5), log: (line) => fastLines.push(String(line)),
    }));
    assert.deepEqual(JSON.parse(fastLines.join('\n')).tiers, [{ tier: 'Full', frames: 60 }]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a real renderer run degrades a slow --frame-ms list below a fast one', (t) => {
  const renderBin = discoverBinary(['opurom-render', 'opurom_render'], { root: workspaceRoot() });
  if (!renderBin) return t.skip('opurom-render binary unavailable');
  const base = tmpDir('frame-profile-real-degrade-');
  try {
    const irFile = path.join(base, 'app.opuir.json');
    fs.copyFileSync(new URL('./fixtures/widget-inspect.opuir.json', import.meta.url), irFile);
    const frame = path.join(base, 'frame.ppm');
    const digestOf = (args) => {
      const { status, stdout, stderr } = spawnSync(renderBin, [irFile, '800', '600', frame, ...args], { encoding: 'utf8' });
      assert.equal(status, 0, stderr);
      const match = /^digest=([0-9a-f]+)$/m.exec(stdout);
      assert.ok(match, stdout);
      return match[1];
    };
    // Fast samples stay on budget; slow samples degrade the Full-only `glass`
    // Card, so the two PPM digests differ. `--frame-ms 5` differs from the
    // measured slow list, proving a real renderer responded to the tier.
    const fast = digestOf(['--auto-degrade', '60', '--frame-ms', '5', '--frame-samples', '60']);
    const slow = digestOf(['--auto-degrade', '60', '--frame-ms', '30', '--frame-samples', '60']);
    assert.notEqual(slow, fast);
    const fastTier = summarizeTiers(Array(60).fill(5), 60).tiers.at(-1).tier;
    const slowTier = summarizeTiers(Array(60).fill(30), 60).tiers.at(-1).tier;
    assert.equal(fastTier, 'Full');
    assert.equal(slowTier, 'Minimal');
    t.diagnostic(`fast=${fast} (${fastTier}) slow=${slow} (${slowTier})`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
