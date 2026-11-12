import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { flagEnabled, parseArgs } from '../lib/args.mjs';
import { build, formatMeasuredBytes, planBuild } from '../lib/build.mjs';
import { planFullBuild } from '../lib/fullstack.mjs';
import {
  formatExactBytes, formatExactMillis, measuredArtifactRows, measuredRows, unavailable,
} from '../lib/bench.mjs';
import { createSyncHub, dev, devClientScript } from '../lib/dev.mjs';
import { tmpDir } from '../lib/paths.mjs';

const INPUT_IR = '{"ir":"0.1","app":"Counter","state":[{"name":"unused","typ":"int","value":0}],"tree":{},"theme":{}}';
const OPTIMIZED_IR = '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}';

function compilerStub(logFile, optimizeBody) {
  return `#!/bin/sh
printf '%s\\n' "$*" >> '${logFile}'
case "$1" in
  compile) printf '%s\\n' '${INPUT_IR}' > "$4" ;;
  optimize) ${optimizeBody} ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json"; printf '%s\\n' '<html><head></head></html>' > "$6/index.html" ;;
  *) exit 2 ;;
esac
`;
}

function writeStub(binDir, logFile, optimizeBody) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'opuromc'), compilerStub(logFile, optimizeBody), { mode: 0o755 });
}

async function withStubPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

function sseReader(response) {
  const reader = response.body.getReader();
  let text = '';
  return {
    async until(marker) {
      while (!text.includes(marker)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream closed before ${marker}: ${text.slice(-200)}`);
        text += Buffer.from(value).toString('utf8');
      }
      return text;
    },
  };
}

function reloadFrame(text) {
  return /event: reload\ndata: [^\n]*\n\n/.exec(text)?.[0] ?? '';
}

test('R3 flags parse as booleans and can be disabled explicitly', () => {
  const { flags, positionals } = parseArgs([
    'build', '--src', 'main.opu', '--target', 'web', '--out', 'dist',
    '--optimize', '--full', '--sync', '--port', '5178',
  ]);
  assert.deepEqual(positionals, ['build']);
  assert.equal(flags.port, '5178');
  for (const key of ['optimize', 'full', 'sync']) assert.equal(flagEnabled(flags, key), true);
  const disabled = parseArgs(['build', '--optimize=false', '--full=0', '--sync=no']).flags;
  for (const key of ['optimize', 'full', 'sync']) assert.equal(flagEnabled(disabled, key), false);
});

test('measured formatters print exact supplied numbers and honest n/a reasons', () => {
  assert.equal(formatMeasuredBytes(1234567, 890123), 'optimizer: input=1234567 B, output=890123 B (measured from files)');
  assert.equal(formatExactMillis(12.345678), '12.345678 ms');
  assert.equal(formatExactBytes(987654321), '987654321 B');
  assert.equal(unavailable('cargo | missing\nsecond line'), 'n/a (cargo / missing)');
  const rows = measuredRows({ compile: 12.345678, render: { reason: 'renderer unavailable' } });
  assert.equal(rows[0].elapsed, '12.345678 ms');
  assert.equal(rows.find((row) => row.step.includes('render')).elapsed, 'n/a (renderer unavailable)');
  assert.equal(rows.find((row) => row.step.includes('service')).elapsed, 'n/a (not run)');
  assert.deepEqual(measuredArtifactRows([{ name: 'web', files: 3, bytes: 2048 }], ['web', 'frame.ppm']), [
    { artifact: 'web', files: '3', bytes: '2048 B' },
    { artifact: 'frame.ppm', files: 'n/a (not generated)', bytes: 'n/a (not generated)' },
  ]);
});

test('optimize is inserted before emitters only when requested', () => {
  const base = {
    src: '/a/main.opu', ir: '/tmp/ir.json', out: '/a/dist/web', opuromc: '/bin/opuromc', cargo: '/bin/cargo',
  };
  const steps = planBuild({ ...base, target: 'web', optimize: true, optimizedIr: '/tmp/optimized.json' });
  assert.deepEqual(steps.map((step) => step.label), ['compile', 'optimize', 'lower']);
  assert.deepEqual(steps[1].args, ['optimize', '/tmp/ir.json', '-o', '/tmp/optimized.json']);
  assert.equal(steps[2].args[1], '/tmp/optimized.json');
  const full = planFullBuild({
    src: '/a/main.opu', ir: '/tmp/source.json', optimizedIr: '/out/app.opuir.json', optimize: true,
    out: '/out', root: '/ws', opuromc: '/bin/opuromc', serverc: '/bin/s', migrate: '/bin/m',
  });
  assert.deepEqual(full.map((step) => step.label), [
    'compile', 'optimize', 'frontend-web', 'frontend-native', 'server', 'migrations',
  ]);
  assert.equal(full[2].args[1], '/out/app.opuir.json');
});

test('build --optimize runs the optimizer and leaves default output unchanged', async () => {
  const base = tmpDir('optimize-success-');
  try {
    const binDir = path.join(base, 'bin');
    const logFile = path.join(base, 'opuromc.log');
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    writeStub(binDir, logFile, `printf '%s\\n' '${OPTIMIZED_IR}' > "$4"; exit 0`);
    const logs = [];
    let baseline;
    let optimized;
    await withStubPath(binDir, () => {
      baseline = build({ src, target: 'web', out: path.join(base, 'default'), root: base, quiet: true, log: () => {} });
      optimized = build({
        src, target: 'web', out: path.join(base, 'optimized'), root: base, quiet: true,
        optimize: true, log: (line) => logs.push(String(line)),
      });
    });
    assert.equal('optimization' in baseline, false);
    assert.equal(optimized.optimization.applied, true);
    assert.equal(optimized.optimization.inputBytes, Buffer.byteLength(`${INPUT_IR}\n`));
    assert.equal(optimized.optimization.outputBytes, Buffer.byteLength(`${OPTIMIZED_IR}\n`));
    assert.equal(fs.readFileSync(path.join(baseline.out, 'ir.json'), 'utf8'), `${INPUT_IR}\n`);
    assert.equal(fs.readFileSync(path.join(optimized.out, 'ir.json'), 'utf8'), `${OPTIMIZED_IR}\n`);
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    const optimizeLine = lines.find((line) => line.startsWith('optimize '));
    assert.match(optimizeLine, /^optimize \S+ -o \S+$/);
    const targetLines = lines.filter((line) => line.startsWith('target '));
    assert.equal(targetLines.at(-1).split(' ')[1], optimizeLine.split(' ')[3]);
    assert.ok(lines.indexOf(optimizeLine) < lines.lastIndexOf(targetLines.at(-1)));
    assert.ok(logs.some((line) => line === formatMeasuredBytes(
      optimized.optimization.inputBytes, optimized.optimization.outputBytes,
    )));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('build --optimize reports an explicit fallback when the compiler lacks optimize', async () => {
  const base = tmpDir('optimize-fallback-');
  try {
    const binDir = path.join(base, 'bin');
    const logFile = path.join(base, 'opuromc.log');
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    writeStub(binDir, logFile, `printf '%s\\n' 'missing or unknown subcommand' >&2; exit 1`);
    const logs = [];
    let result;
    await withStubPath(binDir, () => {
      result = build({
        src, target: 'web', out: path.join(base, 'web'), root: base, quiet: true,
        optimize: true, log: (line) => logs.push(String(line)),
      });
    });
    assert.equal(result.optimization.applied, false);
    assert.match(result.optimization.reason, /missing or unknown subcommand/);
    assert.equal(result.optimization.inputBytes, Buffer.byteLength(`${INPUT_IR}\n`));
    assert.equal(result.optimization.outputBytes, result.optimization.inputBytes);
    assert.equal(fs.readFileSync(path.join(result.out, 'ir.json'), 'utf8'), `${INPUT_IR}\n`);
    assert.ok(logs.some((line) => line.includes('NOT optimized')));
    assert.ok(logs.some((line) => line === formatMeasuredBytes(
      result.optimization.inputBytes, result.optimization.outputBytes,
    )));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('sync hub adds, broadcasts, removes clients and sends a snapshot on connect', () => {
  const writesA = [];
  const writesB = [];
  const clientA = { write: (frame) => writesA.push(frame) };
  const clientB = { write: (frame) => writesB.push(frame) };
  const hub = createSyncHub({ mode: 'dev-preview', reloads: 0, lastReload: null });
  const snapshotA = hub.add(clientA);
  assert.equal(hub.size, 1);
  assert.equal(snapshotA.clients, 1);
  assert.match(writesA[0], /^event: snapshot\ndata: /);
  const snapshotB = hub.add(clientB);
  assert.equal(hub.size, 2);
  assert.equal(snapshotB.clients, 2);
  assert.match(writesB[0], /^event: snapshot\ndata: /);
  assert.equal(hub.broadcast('reload', { at: 'now', src: 'main.opu' }), 2);
  const firstReload = writesA.at(-1);
  assert.equal(firstReload, writesB.at(-1));
  assert.match(firstReload, /^event: reload\ndata: /);
  assert.equal(hub.snapshot().reloads, 1);
  assert.deepEqual(hub.snapshot().lastReload, { at: 'now', src: 'main.opu' });
  assert.equal(hub.remove(clientA), true);
  assert.equal(hub.size, 1);
  assert.equal(hub.broadcast('reload', { at: 'later' }), 1);
  assert.match(writesB.at(-1), /"at":"later"/);
  assert.equal(writesA.at(-1), firstReload);
  assert.match(devClientScript(), /addEventListener\('snapshot'/);
});

test('dev --sync sends snapshots and identical reload frames to two SSE clients', { timeout: 20000 }, async () => {
  const base = tmpDir('dev-sync-test-');
  const binDir = path.join(base, 'bin');
  const logFile = path.join(base, 'opuromc.log');
  const src = path.join(base, 'main.opu');
  writeStub(binDir, logFile, `printf '%s\\n' 'unused' >&2; exit 1`);
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
  const controllers = [];
  let handle;
  let timer;
  try {
    handle = await dev({ src, port: 0, root: base, signals: false, backend: false, sync: true, log: () => {} });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.sync.mode, 'dev-preview');
    assert.equal(health.sync.clients, 0);
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    controllers.push(controllerA, controllerB);
    const readerA = sseReader(await fetch(`${baseUrl}/__opurom/events`, { signal: controllerA.signal }));
    const readerB = sseReader(await fetch(`${baseUrl}/__opurom/events`, { signal: controllerB.signal }));
    timer = setTimeout(() => {
      controllerA.abort();
      controllerB.abort();
    }, 8000);
    const snapshotA = await readerA.until('event: snapshot');
    const snapshotB = await readerB.until('event: snapshot');
    assert.match(snapshotA, /"mode":"dev-preview"/);
    assert.match(snapshotB, /"mode":"dev-preview"/);
    assert.equal(handle.hub.size, 2);
    fs.appendFileSync(src, '// touch\n');
    const reloadA = await readerA.until('event: reload');
    const reloadB = await readerB.until('event: reload');
    assert.equal(reloadFrame(reloadA), reloadFrame(reloadB));
    assert.match(reloadFrame(reloadA), /^event: reload\ndata: /);
    clearTimeout(timer);
    timer = null;
  } finally {
    if (timer) clearTimeout(timer);
    for (const controller of controllers) controller.abort();
    if (handle) await handle.close();
    process.env.PATH = oldPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
