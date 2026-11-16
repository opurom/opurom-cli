import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFrameBudget, nearestRank, perfReport } from '../lib/frame_tier.mjs';
import { AVAILABILITY, createInspectRelay } from '../lib/inspect_relay.mjs';
import { createKernelSource, parseKernelLine } from '../lib/kernel_source.mjs';
import { dev } from '../lib/dev.mjs';
import { tmpDir } from '../lib/paths.mjs';

const GOLDEN = JSON.parse(fs.readFileSync(
  fileURLToPath(new URL('./fixtures/frame-tier-golden.json', import.meta.url)), 'utf8'));

// The online mirror must reproduce the golden vectors rule for rule; this is
// the same module the dev loop injects into the page, so the page cannot
// drift either.
for (const item of GOLDEN.cases) {
  test(`tier mirror golden: ${item.name}`, () => {
    const budget = createFrameBudget({ targetMs: 16 });
    const records = [];
    item.samples.forEach((ms, i) => {
      for (let n = 0; n < item.repeat[i]; n += 1) records.push({ frameMs: ms, tier: budget.push(ms) });
    });
    for (const [from, to] of item.tierIndices) {
      for (let i = from; i <= to; i += 1) assert.equal(records[i].tier, expectedTier(item, i), `frame ${i}`);
    }
    assert.deepEqual(
      perfReport(records.map((r) => r.frameMs), records[records.length - 1].tier),
      { ...item.report, fpsX10: fps(records.map((r) => r.frameMs)) },
    );
    assert.equal(budget.tier, item.report.tier);
    assert.equal('budgetMs' in records[0], false, 'the mirror returns only the tier; the relay stamps the record');
  });
}

function fps(values) {
  const sorted = values.map((ms) => Math.max(0, Math.trunc(ms))).sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  return total <= 0 ? 0 : Math.trunc((10000 * sorted.length) / total);
}

function expectedTier(item, index) {
  for (let entry = 0; entry < item.tierIndices.length; entry += 1) {
    const [from, to] = item.tierIndices[entry];
    if (index >= from && index <= to) return item.tiers[entry];
  }
  throw new Error(`no tier expectation for frame ${index}`);
}

test('nearest rank matches the documented integer formula', () => {
  assert.equal(nearestRank([10, 16, 20], 95), 20);
  assert.equal(nearestRank([10, 16], 95), 16);
  assert.equal(nearestRank([], 95), 0);
});

test('the relay stamps seq server-side, caps the ring and reports availability', () => {
  const relay = createInspectRelay();
  assert.deepEqual(relay.pullFrames(), {
    ...AVAILABILITY.frames.absent, version: 0, frames: [], report: null,
  });
  relay.addFrames([{ frameMs: 16, startMs: 5, tier: 'full' }, { frameMs: 'bogus' }, { frameMs: -3 }]);
  const view = relay.pullFrames();
  assert.equal(view.availability, 'partial');
  assert.deepEqual(view.frames.map((r) => [r.seq, r.frameMs, r.startMs, r.tier]), [[0, 16, 5, 'full']]);
  assert.deepEqual(view.report, { p50Ms: 16, p95Ms: 16, fpsX10: 625, tier: 'full' });
  for (let i = 0; i < 250; i += 1) relay.addFrames([{ frameMs: i }]);
  assert.equal(relay.pullFrames().frames.length, 200, 'the ring is capped at 200');
  assert.equal(relay.pullFrames({ since: 240 }).frames[0].seq, 240, 'since filters on the server seq');
  assert.deepEqual(relay.pullNetwork(), {
    ...AVAILABILITY.network.absent, version: 0, network: [],
  });
  assert.equal(relay.pullNetwork().availability, 'absent', 'no proxy, no fabricated records');
});

test('memory records one entry per dispatch with honest nulls', () => {
  const relay = createInspectRelay();
  assert.equal(relay.pullMemory().availability, 'absent');
  relay.addMemory({ state: { count: 1 } });
  const view = relay.pullMemory();
  assert.equal(view.availability, 'partial');
  assert.equal(view.memory.stateBytes, Buffer.byteLength(JSON.stringify({ count: 1 })));
  assert.equal(view.memory.cache, null);
  assert.equal(view.memory.images, null);
  assert.deepEqual(view.memory.history, [{ version: 0, totalBytes: view.memory.stateBytes }]);
  for (let i = 0; i < 60; i += 1) relay.addMemory({ state: { i } });
  assert.equal(relay.pullMemory().history.length, 50, 'the history ring is capped at 50');
});

test('reset bumps the version and clears the rings', () => {
  const relay = createInspectRelay();
  relay.addFrames([{ frameMs: 16, tier: 'full' }]);
  relay.addMemory({ state: { a: 1 } });
  relay.reset();
  assert.equal(relay.version, 1);
  assert.deepEqual(relay.pullFrames().frames, []);
  // Source badges stay sticky across a reset (the host still has that source);
  // the rings and the version are what reset.
  assert.equal(relay.pullMemory().memory, null);
  assert.equal(relay.pullMemory().version, 1);
});

// The compiler counts its calls and adds a state field after the first, so a
// second build takes the full (state-schema-changed) reload path that resets
// the relay rings; the first build is the dev startup compile.
const STUB = `#!/bin/sh
set -e
case "$1" in
  compile)
    n=0; [ -f "$0.count" ] && n=$(cat "$0.count"); n=$((n+1)); echo $n > "$0.count"
    extra=""; [ "$n" -gt 1 ] && extra=', {"name":"extra","type":"int","init":0}'
    printf '%s\\n' "{\"ir\":\"0.1.0\",\"app\":\"Counter\",\"state\":[{\"name\":\"count\",\"type\":\"int\",\"init\":0}$extra],\"tree\":{\"id\":$n,\"kind\":\"Text\",\"props\":{},\"children\":[],\"events\":{}},\"theme\":{}}" > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<!DOCTYPE html><html><head></head><body><main id="app"></main><script>(function () { var state = {"count":0}; })();</script></body></html>' > "$6/index.html" ;;
  *) exit 2 ;;
esac
`;

function setup(name) {
  const base = tmpDir(name);
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), STUB, { mode: 0o755 });
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  return {
    base, src,
    restore: () => {
      process.env.PATH = oldPath;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

test('the dev server relays frames and memory over SSE and the pull endpoints', { timeout: 20000 }, async () => {
  const env = setup('inspect-relay-dev-');
  let handle;
  let controller;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    controller = new AbortController();
    const sse = await fetch(`${baseUrl}/__opurom/events`, { signal: controller.signal });
    assert.equal(sse.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = sse.body.getReader();
    let streamText = '';
    const pump = (async () => {
      while (!streamText.includes('event: frame')) {
        const { value, done } = await reader.read();
        if (done) break;
        streamText += Buffer.from(value).toString('utf8');
      }
    })();
    let deadlineTimer;
    const frameDeadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Error('no frame event within 8000ms')), 8000);
    });
    const post = await fetch(`${baseUrl}/__opurom/frames`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames: [{ frameMs: 12, startMs: 0, tier: 'full' }, { frameMs: 30, startMs: 16, tier: 'reduced' }] }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true, availability: 'partial' });

    const frames = await (await fetch(`${baseUrl}/api/inspect/frames`)).json();
    assert.equal(frames.availability, 'partial');
    assert.equal(frames.version, 0);
    assert.deepEqual(frames.frames.map((r) => [r.seq, r.frameMs]), [[0, 12], [1, 30]]);
    assert.deepEqual(frames.report, { p50Ms: 12, p95Ms: 30, fpsX10: 476, tier: 'reduced' });
    const since = await (await fetch(`${baseUrl}/api/inspect/frames?since=1`)).json();
    assert.deepEqual(since.frames.map((r) => r.seq), [1]);

    const bad = await fetch(`${baseUrl}/__opurom/frames`, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);
    const wrongMethod = await fetch(`${baseUrl}/__opurom/frames`, { method: 'GET' });
    assert.equal(wrongMethod.status, 405);

    try {
      await Promise.race([pump, frameDeadline]);
    } finally {
      clearTimeout(deadlineTimer);
    }
    assert.match(streamText, /event: frame\n/);
    assert.match(streamText, /"frameMs":12/);
    controller.abort();
    controller = null;

    await fetch(`${baseUrl}/__opurom/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { count: 3 } }),
    });
    const memory = await (await fetch(`${baseUrl}/api/inspect/memory`)).json();
    assert.equal(memory.availability, 'partial');
    assert.equal(memory.memory.stateBytes, Buffer.byteLength(JSON.stringify({ count: 3 })));
    assert.equal(memory.memory.cache, null, 'absent mirrors stay null');
    const network = await (await fetch(`${baseUrl}/api/inspect/network`)).json();
    assert.equal(network.availability, 'absent');
    assert.deepEqual(network.network, []);

    const bundle = await fetch(`${baseUrl}/inspector`);
    assert.equal(bundle.status, 200, 'the CLI hosts the opurom-web bundle at /inspector');
    assert.match(await bundle.text(), /<html/i);
  } finally {
    if (controller) controller.abort();
    if (handle) await handle.close();
    env.restore();
  }
});

test('a reload resets the relay rings and bumps the version', { timeout: 20000 }, async () => {
  const env = setup('inspect-relay-reset-');
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    await fetch(`${baseUrl}/__opurom/frames`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ frames: [{ frameMs: 12, tier: 'full' }] }),
    });
    assert.equal((await (await fetch(`${baseUrl}/api/inspect/frames`)).json()).frames.length, 1);
    const src = fs.readFileSync(env.src, 'utf8');
    fs.writeFileSync(env.src, src.replace('count = 0', 'count = 5'));
    let view = null;
    for (let i = 0; i < 40 && !view; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const next = await (await fetch(`${baseUrl}/api/inspect/frames`)).json();
      if (next.version > 0) view = next;
    }
    assert.ok(view, 'the version must bump after the applied reload');
    assert.deepEqual(view.frames, [], 'the rings reset with the reload');
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

// Fixture kernel: answers `frames 0` and `memory` with the spec record
// shapes, so the relay's full-availability path is pinned before the real
// opurom-core kernel binary lands.
const KERNEL_FRAMES = { frames: [{ frameMs: 16, startMs: 0, tier: 'full' }, { frameMs: 30, startMs: 16, tier: 'reduced' }], report: { p50Ms: 30, p95Ms: 30, fpsX10: 400, tier: 'reduced' }, version: 0 };
const KERNEL_MEMORY = { cache: { budget: 8, usedBytes: 3, entries: 1 }, stateBytes: 12, layersBytes: 4, images: { entries: 1, bytes: 9 }, history: [{ version: 0, totalBytes: 16 }] };
const KERNEL_STUB = `#!/bin/sh
while IFS= read -r line || [ -n "$line" ]; do
  set -- $line
  case "$1" in
    frames) printf '%s\\n' 'frames ${JSON.stringify(KERNEL_FRAMES)} version 0' ;;
    memory) printf '%s\\n' 'memory ${JSON.stringify(KERNEL_MEMORY)} version 0' ;;
    *) echo 'error: unknown command' ;;
  esac
done
`;

test('parseKernelLine reads only channel answer lines', () => {
  assert.deepEqual(parseKernelLine(`frames ${JSON.stringify(KERNEL_FRAMES)} version 3`),
    { channel: 'frames', payload: KERNEL_FRAMES, version: 3 });
  assert.equal(parseKernelLine('state count=1'), null);
  assert.equal(parseKernelLine('frames not json version 0'), null);
  assert.equal(parseKernelLine('network [] version 0'), null, 'network is not a kernel channel');
});

test('createKernelSource answers sequential queries per channel', { timeout: 10000 }, async () => {
  const base = tmpDir('inspect-kernel-');
  const binary = path.join(base, 'opurom_kernel');
  fs.writeFileSync(binary, KERNEL_STUB, { mode: 0o755 });
  const logs = [];
  const kernel = createKernelSource({ binary, irPath: path.join(base, 'app.opuir.json'), log: (l) => logs.push(l) });
  try {
    kernel.start();
    const frames = await kernel.query('frames 0');
    assert.equal(frames.channel, 'frames');
    assert.deepEqual(frames.payload, KERNEL_FRAMES);
    const memory = await kernel.query('memory');
    assert.deepEqual(memory.payload, KERNEL_MEMORY);
    await assert.rejects(kernel.query('network'), /frames or memory/);
  } finally {
    await kernel.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('kernel data reaches the pull endpoints as full availability', { timeout: 20000 }, async () => {
  const env = setup('inspect-relay-kernel-');
  const bin = path.join(env.base, 'bin');
  fs.writeFileSync(path.join(bin, 'opurom_kernel'), KERNEL_STUB, { mode: 0o755 });
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
      kernel: { binary: path.join(bin, 'opurom_kernel'), irPath: path.join(env.base, 'app.opuir.json') },
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const frames = await (await fetch(`${baseUrl}/api/inspect/frames`)).json();
    assert.equal(frames.availability, 'full');
    assert.deepEqual(frames.frames.map((r) => r.frameMs), [16, 30]);
    assert.deepEqual(frames.report, { p50Ms: 16, p95Ms: 30, fpsX10: 434, tier: 'reduced' });
    const memory = await (await fetch(`${baseUrl}/api/inspect/memory`)).json();
    assert.equal(memory.availability, 'full');
    assert.deepEqual(memory.memory, KERNEL_MEMORY);
    // The kernel owns the memory ledger even when the page also reports state.
    await fetch(`${baseUrl}/__opurom/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { count: 1 } }),
    });
    const memoryAfter = await (await fetch(`${baseUrl}/api/inspect/memory`)).json();
    assert.equal(memoryAfter.availability, 'full');
    assert.deepEqual(memoryAfter.memory, KERNEL_MEMORY);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});
