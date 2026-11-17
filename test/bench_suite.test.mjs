import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_FIELDS, BENCH_SUITE_FIELDS, BENCH_SUITE_TARGETS, COMPETITOR_REASON,
  DEFAULT_RUNS, FIXTURE, MAX_RUNS, MEASUREMENT_FIELDS, SPARKLINE_BUCKETS,
  artifactRecord, benchSuite, benchSuiteJson, benchSuiteMarkdown, benchSuiteRecord,
  measurementRecord, measureRuns, parseSuiteRuns, summarize,
} from '../lib/bench_suite.mjs';
import { directoryStats } from '../lib/fullstack.mjs';
import { discoverBinary, tmpDir, workspaceRoot } from '../lib/paths.mjs';

const SOURCE_CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const COMPILE_SAMPLES = [10, 20, 30, 40];
const RENDER_SAMPLES = [5, 10, 15, 20];
const RUNS = 4;
const LEVELS = '_.:-=+*#%@';

// Real-toolchain samples are a performance benchmark: timings depend on the
// runner, so they are NOT a CI correctness gate. Opt in locally with
// OPUROM_BENCH_LOCAL=1 after building ../opurom-{lang,render}. In CI (and any
// default npm test) the gate reports an explicit N/A diagnostic instead of a
// silent skip; test/bench_gate.test.mjs asserts that marker is present.
const BENCH_LOCAL = process.env.OPUROM_BENCH_LOCAL === '1';
const BENCH_NA = 'N/A - performance benchmark, run locally (OPUROM_BENCH_LOCAL=1)';

function compilerStub(failWebDom = false) {
  const guard = failWebDom
    ? 'if [ "$4" = "web-dom" ]; then printf \'responsive DOM emitter not found: opurom-web/bin/opurom-web.mjs\\n\' >&2; exit 1; fi; '
    : '';
  return `#!/bin/sh
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1.0","app":"BenchSuite","state":[],"tree":{},"theme":{}}' > "$4" ;;
  target) ${guard}mkdir -p "$6"; printf 'stub\\n' > "$6/stub.txt" ;;
  targets) printf 'native\\nweb\\nwechat\\nalipay\\nqq\\ndouyin\\nbaidu\\nkuaishou\\nwasm\\n' ;;
  *) exit 1 ;;
esac
`;
}

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

function writeTools(base, failWebDom = false) {
  return {
    compiler: writeStub(base, 'opuromc', compilerStub(failWebDom)),
    renderer: writeStub(base, 'opurom-render', RENDERER_STUB),
  };
}

function withCleanEnv(base, fn) {
  const oldPath = process.env.PATH;
  const oldHome = process.env.HOME;
  process.env.PATH = base;
  process.env.HOME = base;
  try {
    return fn();
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
}

function isolatedCli(base) {
  const cliRoot = path.join(base, 'workspace', 'opurom-cli');
  fs.mkdirSync(cliRoot, { recursive: true });
  fs.cpSync(path.join(SOURCE_CLI_ROOT, 'lib'), path.join(cliRoot, 'lib'), { recursive: true });
  fs.cpSync(path.join(SOURCE_CLI_ROOT, 'bin'), path.join(cliRoot, 'bin'), { recursive: true });
  const fixtures = path.join(cliRoot, 'test', 'fixtures');
  fs.mkdirSync(fixtures, { recursive: true });
  fs.copyFileSync(path.join(SOURCE_CLI_ROOT, FIXTURE), path.join(fixtures, 'bench-suite.opu'));
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

function measuredArtifacts(base) {
  return BENCH_SUITE_TARGETS.map((target, index) => {
    const dir = path.join(base, 'artifacts', target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'artifact.txt'), 'x'.repeat(index + 1));
    const stats = directoryStats(dir);
    return artifactRecord({
      target, status: 'PASS', files: stats.files, bytes: stats.bytes, reason: null,
    });
  });
}

function handRecord(base) {
  return benchSuiteRecord({
    runs: RUNS,
    status: 'PASS',
    compile: measurementRecord({ runs: RUNS, samples: COMPILE_SAMPLES }),
    render: measurementRecord({ runs: RUNS, samples: RENDER_SAMPLES }),
    artifacts: measuredArtifacts(base),
  });
}

function bigintClock(durations) {
  const stamps = [];
  let cursor = 0n;
  for (const ms of durations) {
    const start = cursor;
    const end = start + BigInt(ms) * 1000000n;
    stamps.push(start, end);
    cursor = end + 5000000n;
  }
  return () => {
    if (!stamps.length) throw new Error('clock exhausted');
    return stamps.shift();
  };
}

function sampleSourceFor(stages) {
  return ({ stage, runs, now }) => {
    assert.equal(runs, RUNS);
    assert.equal(typeof now, 'function');
    assert.equal(now(), 0n);
    stages.push(stage);
    return stage === 'compile' ? COMPILE_SAMPLES : RENDER_SAMPLES;
  };
}

function assertMeasured(record, runs) {
  for (const stage of ['compile', 'render']) {
    const measurement = record[stage];
    assert.deepEqual(Object.keys(measurement), [...MEASUREMENT_FIELDS]);
    assert.equal(measurement.status, 'PASS');
    assert.equal(measurement.measuredRuns, runs);
    assert.equal(measurement.samples.length, runs);
    for (const sample of measurement.samples) {
      assert.ok(Number.isSafeInteger(sample) && sample > 0, `${stage} sample ${sample}`);
    }
    for (const key of ['p50', 'p95', 'min', 'max', 'totalMs', 'fpsX10']) {
      assert.ok(Number.isSafeInteger(measurement[key]) && measurement[key] > 0, `${stage}.${key}`);
    }
    assert.equal(measurement.totalMs, measurement.samples.reduce((sum, ms) => sum + ms, 0));
    assert.ok([...measurement.sparkline].every((char) => LEVELS.includes(char)));
  }
}

test('suite runs are bounded to 1..1000', () => {
  assert.equal(MAX_RUNS, 1000);
  assert.equal(DEFAULT_RUNS, 10);
  assert.equal(parseSuiteRuns(), 10);
  assert.equal(parseSuiteRuns('1'), 1);
  assert.equal(parseSuiteRuns('1000'), 1000);
  for (const value of ['0', '-1', '1001', '3.5', 'nope', true, Number.NaN, Infinity]) {
    assert.throws(() => parseSuiteRuns(value), /invalid --runs: .* \(expected 1\.\.1000\)/);
  }
});

test('injected clock and sample source produce hand-computed integer statistics', () => {
  assert.equal(BENCH_SUITE_TARGETS.length, 11);
  assert.deepEqual(measureRuns({ runs: RUNS, now: bigintClock(COMPILE_SAMPLES), run: () => {} }), COMPILE_SAMPLES);
  assert.deepEqual(summarize(COMPILE_SAMPLES), {
    p50: 20,
    p95: 40,
    min: 10,
    max: 40,
    totalMs: 100,
    fpsX10: 400,
    sparkline: '_-*@',
  });
  assert.deepEqual(summarize(RENDER_SAMPLES), {
    p50: 10,
    p95: 20,
    min: 5,
    max: 20,
    totalMs: 50,
    fpsX10: 800,
    sparkline: '_-*@',
  });
  const ten = Array.from({ length: 10 }, (_, index) => (index + 1) * 10);
  assert.deepEqual(summarize(ten), {
    p50: 50, p95: 100, min: 10, max: 100, totalMs: 550,
    fpsX10: 182, sparkline: '_.:-=+*#%@',
  });
  const many = Array.from({ length: MAX_RUNS }, (_, index) => 1 + (index % 97));
  assert.equal(summarize(many).sparkline.length, SPARKLINE_BUCKETS);

  const base = tmpDir('bench-suite-injected-');
  try {
    const { compiler, renderer } = writeTools(base);
    const stages = [];
    const { record } = benchSuite({
      runs: RUNS,
      root: base,
      envPath: base,
      compiler,
      renderer,
      now: () => 0n,
      sampleSource: sampleSourceFor(stages),
      json: true,
      log: () => {},
    });
    assert.deepEqual(stages, ['compile', 'render']);
    assert.equal(record.status, 'PASS');
    assert.deepEqual(record.compile.samples, COMPILE_SAMPLES);
    assert.deepEqual(record.render.samples, RENDER_SAMPLES);
    assert.equal(record.compile.fpsX10, 400);
    assert.equal(record.render.fpsX10, 800);
    assert.equal(record.compile.sparkline, '_-*@');
    assert.equal(record.render.sparkline, '_-*@');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('negative, non-finite and fractional samples are errors', () => {
  for (const bad of [Number.NaN, -1, Infinity, -Infinity, 1.5, '1', null]) {
    assert.throws(() => summarize([10, bad, 30, 40]), /invalid sample at run 2/);
  }
  assert.throws(() => summarize([0, 0]), /measurable elapsed ms/);
  let clockCall = 0;
  assert.throws(
    () => measureRuns({ runs: 1, now: () => (clockCall++ ? 0n : 1n), run: () => {} }),
    /clock moved backwards/,
  );
  const base = tmpDir('bench-suite-invalid-sample-');
  try {
    const { compiler, renderer } = writeTools(base);
    assert.throws(() => benchSuite({
      runs: RUNS,
      root: base,
      envPath: base,
      compiler,
      renderer,
      now: () => 0n,
      sampleSource: ({ stage }) => (stage === 'compile' ? [1, -2, 3, 4] : [1, 2, 3, 4]),
      json: true,
      log: () => {},
    }), /invalid sample at run 2/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('suite JSON has deterministic key order, raw samples and no wall clock', () => {
  const base = tmpDir('bench-suite-json-');
  try {
    const record = handRecord(base);
    const json = benchSuiteJson(record);
    assert.equal(json, JSON.stringify(record));
    assert.deepEqual(Object.keys(record), [...BENCH_SUITE_FIELDS]);
    assert.deepEqual(Object.keys(record.compile), [...MEASUREMENT_FIELDS]);
    assert.deepEqual(Object.keys(record.render), [...MEASUREMENT_FIELDS]);
    assert.deepEqual(Object.keys(record.artifacts[0]), [...ARTIFACT_FIELDS]);
    assert.deepEqual(record.artifacts.map((entry) => entry.target), [...BENCH_SUITE_TARGETS]);
    assert.equal(record.competitors, 'not measured');
    assert.equal(record.reason, COMPETITOR_REASON);
    assert.match(record.reason, /competitor binaries are not available on this host/);
    assert.doesNotMatch(json, /"timestamp"|"measuredAt"|\d{4}-\d{2}-\d{2}T/);
    assert.equal('baseline' in record, false);
    assert.equal(record.compile.p50, 20);
    assert.equal(record.compile.p95, 40);
    assert.equal(record.compile.totalMs, COMPILE_SAMPLES.reduce((sum, ms) => sum + ms, 0));
    assert.equal(record.artifacts[0].bytes, 1);
    assert.equal(record.artifacts.at(-1).bytes, BENCH_SUITE_TARGETS.length);

    const shuffled = Object.fromEntries(Object.entries({
      ...record,
      compile: Object.fromEntries(Object.entries(record.compile).reverse()),
      render: Object.fromEntries(Object.entries(record.render).reverse()),
      artifacts: record.artifacts.map((entry) => Object.fromEntries(Object.entries(entry).reverse())),
    }).reverse());
    assert.equal(benchSuiteJson(shuffled), json);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('suite Markdown has a fixed field and artifact schema', () => {
  const base = tmpDir('bench-suite-markdown-');
  try {
    const record = handRecord(base);
    const markdown = benchSuiteMarkdown(record);
    const lines = markdown.split('\n');
    const header = lines.indexOf('| field | value |');
    const expectedFields = [
      ...BENCH_SUITE_FIELDS.filter((key) => !['compile', 'render', 'artifacts'].includes(key)),
      ...MEASUREMENT_FIELDS.map((key) => `compile.${key}`),
      ...MEASUREMENT_FIELDS.map((key) => `render.${key}`),
    ];
    const fields = lines.slice(header + 2, header + 2 + expectedFields.length)
      .map((line) => line.slice(2, line.indexOf(' |')));
    assert.deepEqual(fields, expectedFields);
    assert.match(markdown, /\| compile\.p50 \| 20 \|/);
    assert.match(markdown, /\| render\.fpsX10 \| 800 \|/);
    assert.match(markdown, /\| competitors \| not measured \|/);
    assert.match(markdown, /competitor binaries are not available on this host/);
    const artifactHeader = lines.indexOf(`| ${ARTIFACT_FIELDS.join(' | ')} |`);
    const targets = lines.slice(artifactHeader + 2, artifactHeader + 2 + BENCH_SUITE_TARGETS.length)
      .map((line) => line.slice(2, line.indexOf(' |')));
    assert.deepEqual(targets, [...BENCH_SUITE_TARGETS]);
    assert.match(markdown, /Reports contain elapsed durations only, not calendar timestamps\./);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a missing renderer is a clean SKIP with concrete reasons and null stats', () => {
  const base = tmpDir('bench-suite-skip-');
  try {
    const compiler = writeStub(base, 'opuromc', compilerStub());
    const jsonLines = [];
    const result = withCleanEnv(base, () => benchSuite({
      runs: 2,
      root: base,
      envPath: base,
      compiler,
      renderer: null,
      json: true,
      log: (line) => jsonLines.push(String(line)),
    }));
    assert.equal(result.exitCode, 0);
    const record = result.record;
    assert.equal(record.status, 'SKIP');
    assert.equal(record.competitors, 'not measured');
    assert.match(record.reason, /^opurom-render unavailable: no executable in PATH or/);
    assert.match(record.reason, /PATH=/);
    assert.match(record.reason, /competitor binaries are not available on this host/);
    for (const stage of ['compile', 'render']) {
      assert.equal(record[stage].status, 'SKIP');
      assert.equal(record[stage].measuredRuns, 0);
      assert.deepEqual(record[stage].samples, []);
      for (const key of ['p50', 'p95', 'min', 'max', 'totalMs', 'fpsX10', 'sparkline']) {
        assert.equal(record[stage][key], null, `${stage}.${key}`);
      }
      assert.match(record[stage].reason, /opurom-render unavailable/);
    }
    for (const artifact of record.artifacts) {
      assert.equal(artifact.status, 'SKIP');
      assert.equal(artifact.files, null);
      assert.equal(artifact.bytes, null);
      assert.match(artifact.reason, /opurom-render unavailable/);
    }
    const json = JSON.parse(jsonLines.join('\n'));
    assert.deepEqual(Object.keys(json), [...BENCH_SUITE_FIELDS]);
    assert.equal(json.status, 'SKIP');

    const markdownLines = [];
    withCleanEnv(base, () => benchSuite({
      runs: 2,
      root: base,
      envPath: base,
      compiler,
      markdown: true,
      log: (line) => markdownLines.push(String(line)),
    }));
    const markdown = markdownLines.join('\n');
    assert.match(markdown, /\| status \| SKIP \|/);
    assert.match(markdown, /\| compile\.p50 \| null \|/);
    assert.match(markdown, /\| render\.fpsX10 \| null \|/);
    assert.match(markdown, /opurom-render unavailable/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an unavailable emitter target is PARTIAL with null bytes, never a fake PASS', () => {
  const base = tmpDir('bench-suite-partial-');
  try {
    const { compiler, renderer } = writeTools(base, true);
    const stages = [];
    const { record } = benchSuite({
      runs: RUNS,
      root: base,
      envPath: base,
      compiler,
      renderer,
      now: () => 0n,
      sampleSource: sampleSourceFor(stages),
      json: true,
      log: () => {},
    });
    assert.equal(record.status, 'PARTIAL');
    assert.match(record.reason, /unmeasured emitter targets: web-dom/);
    assert.match(record.reason, /competitor binaries are not available on this host/);
    const webDom = record.artifacts.find((entry) => entry.target === 'web-dom');
    assert.equal(webDom.status, 'SKIP');
    assert.equal(webDom.files, null);
    assert.equal(webDom.bytes, null);
    assert.match(webDom.reason, /responsive DOM emitter not found/);
    assert.equal(record.artifacts.filter((entry) => entry.status === 'PASS').length, BENCH_SUITE_TARGETS.length - 1);
    for (const artifact of record.artifacts.filter((entry) => entry.status === 'PASS')) {
      assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
    }
    assert.equal(record.compile.status, 'PASS');
    assert.equal(record.render.status, 'PASS');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('CLI --suite --json and --markdown emit real-process reports with fixed schemas', () => {
  const base = tmpDir('bench-suite-cli-');
  try {
    const cli = isolatedCli(base);
    writeTools(base);
    const jsonResult = runCli(cli, base, ['bench', '--suite', '--runs', '3', '--json']);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.equal(jsonResult.stderr, '');
    assert.match(jsonResult.stdout, /^\{[^\n]*\}\n$/);
    const json = JSON.parse(jsonResult.stdout.trimEnd());
    assert.equal(jsonResult.stdout, `${benchSuiteJson(json)}\n`);
    assert.deepEqual(Object.keys(json), [...BENCH_SUITE_FIELDS]);
    assert.equal(json.status, 'PASS');
    assert.equal(json.runs, 3);
    assert.equal(json.fixture, FIXTURE);
    assert.equal(json.unit, 'ms');
    assert.equal(json.sizeUnit, 'bytes');
    assert.equal(json.competitors, 'not measured');
    assert.match(json.reason, /competitor binaries are not available on this host/);
    assertMeasured(json, 3);
    assert.equal(json.artifacts.length, BENCH_SUITE_TARGETS.length);
    for (const artifact of json.artifacts) {
      assert.deepEqual(Object.keys(artifact), [...ARTIFACT_FIELDS]);
      assert.equal(artifact.status, 'PASS');
      assert.ok(Number.isSafeInteger(artifact.files) && artifact.files > 0);
      assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
      assert.equal(artifact.reason, null);
    }

    const markdownResult = runCli(cli, base, ['bench', '--suite', '--runs', '3', '--markdown']);
    assert.equal(markdownResult.status, 0, markdownResult.stderr);
    assert.equal(markdownResult.stderr, '');
    assert.match(markdownResult.stdout, /^# Opurom benchmark suite\n\n\| field \| value \|\n/);
    const lines = markdownResult.stdout.split('\n');
    const expectedFields = [
      ...BENCH_SUITE_FIELDS.filter((key) => !['compile', 'render', 'artifacts'].includes(key)),
      ...MEASUREMENT_FIELDS.map((key) => `compile.${key}`),
      ...MEASUREMENT_FIELDS.map((key) => `render.${key}`),
    ];
    const fields = lines.slice(4, 4 + expectedFields.length)
      .map((line) => line.slice(2, line.indexOf(' |')));
    assert.deepEqual(fields, expectedFields);
    assert.match(markdownResult.stdout, /\| competitors \| not measured \|/);
    assert.equal(lines.filter((line) => BENCH_SUITE_TARGETS.some((target) => line.startsWith(`| ${target} |`))).length, BENCH_SUITE_TARGETS.length);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('CLI rejects --runs outside 1..1000 before invoking tools', () => {
  const base = tmpDir('bench-suite-bounds-cli-');
  try {
    const cli = isolatedCli(base);
    for (const value of ['0', '-1', '1001', '3.5', 'nope']) {
      const result = runCli(cli, base, ['bench', '--suite', '--runs', value, '--json']);
      assert.equal(result.status, 1, `runs=${value} stderr=${result.stderr}`);
      assert.match(result.stderr, /invalid --runs: .* \(expected 1\.\.1000\)/);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('real compiler and renderer samples are positive and finite', (t) => {
  if (!BENCH_LOCAL) {
    t.diagnostic(BENCH_NA);
    return;
  }
  const root = workspaceRoot();
  const compiler = discoverBinary(['opuromc'], { root, repo: 'opurom-lang' });
  const renderer = discoverBinary(['opurom-render', 'opurom_render'], { root, repo: 'opurom-render' });
  assert.ok(compiler, 'OPUROM_BENCH_LOCAL=1 requires a built opuromc binary');
  assert.ok(renderer, 'OPUROM_BENCH_LOCAL=1 requires a built opurom-render binary');
  const lines = [];
  const { record } = benchSuite({
    runs: 2,
    root,
    envPath: process.env.PATH ?? '',
    compiler,
    renderer,
    json: true,
    log: (line) => lines.push(String(line)),
  });
  assert.ok(['PASS', 'PARTIAL'].includes(record.status));
  assert.equal(record.runs, 2);
  assert.equal(record.competitors, 'not measured');
  assert.match(record.reason, /competitor binaries are not available on this host/);
  assertMeasured(record, 2);
  assert.equal(JSON.parse(lines.join('\n')).runs, 2);
  for (const artifact of record.artifacts) {
    if (artifact.status === 'PASS') {
      assert.ok(Number.isSafeInteger(artifact.files) && artifact.files > 0);
      assert.ok(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0);
    } else {
      assert.equal(artifact.status, 'SKIP');
      assert.equal(artifact.files, null);
      assert.equal(artifact.bytes, null);
      assert.match(artifact.reason, /.+/);
    }
  }
  t.diagnostic(benchSuiteJson(record));
});
