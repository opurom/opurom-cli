import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { dev } from '../lib/dev.mjs';
import { decideReload } from '../lib/hot_reload.mjs';
import {
  DEFAULT_DEVICE_CAP, DEVICE_TARGETS, DeviceRegistryError,
  createDeviceRegistry, handleDeviceRequest,
} from '../lib/device_sync.mjs';

// Real IR shapes, mirroring hot_reload.test.mjs, so decisions come from the
// actual IR-diff classifier rather than fabricated kinds/reasons.
const baseIr = () => ({
  ir: '0.1',
  app: 'Counter',
  state: [{ name: 'count', type: 'int', init: 0 }],
  tree: {
    id: 0,
    kind: 'Column',
    props: { gap: 8 },
    children: [{ id: 1, kind: 'Text', props: { value: 'Count: {count}' }, children: [], events: {} }],
    events: {},
  },
  theme: { mode: 'system' },
});
const leafOf = (ir) => { const n = structuredClone(ir); n.tree.children[0].props.value = 'Total: {count}'; return n; };
const schemaOf = (ir) => { const n = structuredClone(ir); n.state.push({ name: 'label', type: 'string', init: '' }); return n; };
const shellOf = (ir) => { const n = structuredClone(ir); n.theme.accent = '#f00'; return n; };

test('registry caps at 32 and rejects duplicate ids with clear errors', () => {
  const reg = createDeviceRegistry();
  assert.equal(reg.snapshot().cap, DEFAULT_DEVICE_CAP);
  for (let i = 0; i < DEFAULT_DEVICE_CAP; i += 1) {
    reg.register({ id: `dev-${i}`, target: DEVICE_TARGETS[i % DEVICE_TARGETS.length] });
  }
  assert.equal(reg.size, DEFAULT_DEVICE_CAP);
  assert.throws(
    () => reg.register({ id: 'one-more', target: 'web' }),
    (e) => e instanceof DeviceRegistryError && e.status === 429 && /full \(cap 32\)/.test(e.message),
  );
  assert.throws(
    () => reg.register({ id: 'dev-0', target: 'native' }),
    (e) => e instanceof DeviceRegistryError && e.status === 409 && /duplicate device id: dev-0/.test(e.message),
  );
  assert.equal(reg.size, DEFAULT_DEVICE_CAP, 'rejected registrations do not mutate the registry');
});

test('registry rejects malformed payloads without crashing', () => {
  const reg = createDeviceRegistry();
  assert.deepEqual(DEVICE_TARGETS, ['web', 'native', 'mini', 'wasm']);
  const bad = [
    null, undefined, 5, 'x', [],
    { target: 'web' }, { id: '', target: 'web' }, { id: 42, target: 'web' },
    { id: 'ok' }, { id: 'ok', target: 'desktop' },
    { id: 'x'.repeat(256), target: 'web' },
  ];
  for (const payload of bad) {
    assert.throws(
      () => reg.register(payload),
      (e) => e instanceof DeviceRegistryError && e.status === 400,
      `must reject ${JSON.stringify(payload)}`,
    );
  }
  assert.equal(reg.size, 0);
  for (const target of DEVICE_TARGETS) {
    const record = reg.register({ id: `valid-${target}`, target });
    assert.equal(record.target, target);
    assert.equal(typeof record.connectedAt, 'number');
    assert.equal(typeof record.lastSeen, 'number');
  }
  assert.equal(reg.size, DEVICE_TARGETS.length);
});

test('one broadcast delivers the identical payload to every client, in id order', () => {
  const delivered = [];
  const reg = createDeviceRegistry({ deliver: (id, payload) => delivered.push({ id, payload }) });
  for (const [id, target] of [['web-1', 'web'], ['native-1', 'native'], ['mini-1', 'mini'], ['wasm-1', 'wasm']]) {
    reg.register({ id, target });
  }
  const payload = reg.broadcast(baseIr(), leafOf(baseIr()));
  assert.equal(delivered.length, 4, 'all four targets receive the decision');
  const ids = delivered.map((d) => d.id);
  assert.deepEqual(ids, [...ids].sort(), 'client id order');
  for (const d of delivered) assert.strictEqual(d.payload, payload, 'same payload object reference');
  assert.deepEqual(Object.keys(payload).sort(), ['kind', 'reason', 'revision']);
  assert.deepEqual(payload, { revision: 1, kind: 'hot', reason: 'tree-changed' });
  assert.ok(reg.snapshot().devices.every((d) => d.lastSeen === 1), 'all devices see revision 1');
  assert.equal(reg.logText(), [
    'mini-1 r1 hot (tree-changed)',
    'native-1 r1 hot (tree-changed)',
    'wasm-1 r1 hot (tree-changed)',
    'web-1 r1 hot (tree-changed)',
  ].join('\n'));
});

test('broadcast reuses decideReload: kind/reason come from real IR diffs', () => {
  const reg = createDeviceRegistry();
  const cases = [
    [baseIr(), leafOf(baseIr()), 'hot', 'tree-changed'],
    [baseIr(), schemaOf(baseIr()), 'full', 'state-schema-changed'],
    [baseIr(), shellOf(baseIr()), 'full', 'shell-changed'],
    [baseIr(), structuredClone(baseIr()), 'none', 'unchanged'],
    [null, baseIr(), 'full', 'initial-build'],
    [baseIr(), null, 'full', 'removed-ir'],
  ];
  let expectedRevision = 0;
  for (const [prev, next, kind, reason] of cases) {
    const payload = reg.broadcast(prev, next);
    expectedRevision += 1;
    assert.equal(payload.revision, expectedRevision, 'monotonic revision');
    assert.equal(payload.kind, kind);
    assert.equal(payload.reason, reason);
    assert.deepEqual(
      { kind: payload.kind, reason: payload.reason },
      decideReload(prev, next),
      'the payload decision equals the shared classifier output',
    );
  }
});

test('replay(since) returns the exact stored decisions; invalid since is rejected', () => {
  const reg = createDeviceRegistry();
  const p1 = reg.broadcast(baseIr(), leafOf(baseIr()));
  const p2 = reg.broadcast(leafOf(baseIr()), schemaOf(baseIr()));
  const p3 = reg.broadcast(baseIr(), shellOf(baseIr()));
  assert.equal(reg.revision, 3);

  const all = reg.replay(0);
  assert.equal(all.since, 0);
  assert.equal(all.revision, 3);
  assert.deepEqual(all.decisions, [p1, p2, p3]);
  assert.strictEqual(all.decisions[0], p1, 'byte-identical: same frozen payload object');
  assert.deepEqual(reg.replay(1).decisions, [p2, p3], 'a client that missed a revision catches up');
  assert.deepEqual(reg.replay(2).decisions, [p3]);
  assert.deepEqual(reg.replay(3).decisions, [], 'up to date');
  assert.deepEqual(reg.replay().decisions, [p1, p2, p3], 'since defaults to 0');
  for (const bad of [-1, 1.5, '2', null]) {
    assert.throws(() => reg.replay(bad), (e) => e instanceof DeviceRegistryError && e.status === 400);
  }
});

test('broadcast log is byte-identical across two runs with different clocks', () => {
  const run = (clockValues) => {
    let i = 0;
    const reg = createDeviceRegistry({ clock: () => clockValues[i++ % clockValues.length] });
    for (const id of ['web-a', 'mini-b', 'native-c']) reg.register({ id, target: id.split('-')[0] });
    reg.broadcast(baseIr(), leafOf(baseIr()));
    reg.broadcast(leafOf(baseIr()), schemaOf(baseIr()));
    reg.broadcast(baseIr(), shellOf(baseIr()));
    return { text: reg.logText(), decisions: reg.decisions, log: reg.log() };
  };
  const a = run([100, 200, 300]);
  const b = run([1700000000000, 1700000009999, 42]); // wall-clock-like values differ
  assert.equal(a.text, b.text, 'the emitted broadcast log is byte-identical');
  assert.deepEqual(a.decisions, b.decisions, 'decision payloads are byte-identical');
  assert.deepEqual(a.log, b.log);
  assert.equal(a.text.split('\n').length, 9, '3 clients x 3 revisions');
  assert.doesNotMatch(a.text, /\d{4}-\d{2}-\d{2}|"at"|timestamp/i, 'no wall clock in the log');
  for (const payload of a.decisions.slice(1)) {
    assert.deepEqual(Object.keys(payload).sort(), ['kind', 'reason', 'revision']);
    assert.equal(typeof payload.revision, 'number');
    assert.equal(Object.isFrozen(payload), true);
  }
  // connectedAt uses the injected clock, but never leaks into the payload/log.
  assert.equal(a.text.includes('1700000000000'), false);
});

// Real local HTTP server on an ephemeral port, verified through fetch.
test('real HTTP server: /devices and /reload via fetch, errors never crash it', { timeout: 15000 }, async () => {
  const registry = createDeviceRegistry({ cap: 3 });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (handleDeviceRequest(registry, req, res, url)) return;
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) => fetch(`${base}/devices`, { method: 'POST', body });
  try {
    let r = await fetch(`${base}/devices`);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).devices, []);

    r = await post(JSON.stringify({ id: 'phone', target: 'mini' }));
    assert.equal(r.status, 201);
    const phone = await r.json();
    assert.equal(phone.id, 'phone');
    assert.equal(phone.target, 'mini');
    assert.equal(typeof phone.connectedAt, 'number');
    assert.equal(typeof phone.lastSeen, 'number');

    r = await post(JSON.stringify({ id: 'phone', target: 'mini' }));
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /duplicate device id: phone/);

    r = await post('{ not json');
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /invalid JSON body/);

    r = await post(JSON.stringify({ id: 'bad', target: 'desktop' }));
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /one of web, native, mini, wasm/);

    r = await post(JSON.stringify({ target: 'web' }));
    assert.equal(r.status, 400, 'malformed id');

    assert.equal((await post(JSON.stringify({ id: 'tv', target: 'web' }))).status, 201);
    assert.equal((await post(JSON.stringify({ id: 'watch', target: 'native' }))).status, 201);
    r = await post(JSON.stringify({ id: 'overflow', target: 'wasm' }));
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /full \(cap 3\)/);

    r = await fetch(`${base}/devices`, { method: 'DELETE' });
    assert.equal(r.status, 405);
    assert.equal((await fetch(`${base}/nope`)).status, 404, 'unknown route is not intercepted');

    const p1 = registry.broadcast(baseIr(), leafOf(baseIr()));
    const p2 = registry.broadcast(leafOf(baseIr()), schemaOf(baseIr()));
    const p3 = registry.broadcast(baseIr(), shellOf(baseIr()));

    const listed = await (await fetch(`${base}/devices`)).json();
    assert.equal(listed.devices.length, 3);
    assert.deepEqual(listed.devices.map((d) => d.connectedAt), [1, 2, 3], 'connected-at sequence');
    assert.ok(listed.devices.every((d) => d.lastSeen === 3), 'all clients saw every broadcast');

    r = await fetch(`${base}/reload?since=1`);
    assert.equal(r.status, 200);
    const replay = await r.json();
    assert.equal(replay.since, 1);
    assert.equal(replay.revision, 3);
    assert.deepEqual(replay.decisions, [p2, p3], 'exact decisions for the missed revisions');
    assert.deepEqual((await (await fetch(`${base}/reload?since=3`)).json()).decisions, []);
    assert.deepEqual((await (await fetch(`${base}/reload`)).json()).decisions, [p1, p2, p3]);
    r = await fetch(`${base}/reload?since=abc`);
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /non-negative integer/);

    assert.equal((await fetch(`${base}/devices`)).status, 200, 'server alive after every error');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// The registry is actually wired into dev(): a source change commits one
// decision that every registered device sees, readable over the real dev port.
const DEV_STUB = `#!/bin/sh
set -e
case "$1" in
  compile)
    n=0; [ -f "$0.count" ] && n=$(cat "$0.count"); n=$((n + 1)); echo "$n" > "$0.count"
    printf '%s\\n' "{\\"ir\\":\\"0.1\\",\\"app\\":\\"Counter\\",\\"state\\":[],\\"tree\\":{\\"id\\":$n},\\"theme\\":{}}" > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<html><head><title>x</title></head><body><script src="app.js"></script></body></html>' > "$6/index.html";
    printf '%s\\n' 'const state = {"count":7};' > "$6/app.js" ;;
  *) exit 2 ;;
esac
`;

test('dev() wires /devices and /reload and broadcasts decisions to devices', { timeout: 20000 }, async () => {
  const root = tmpDir('dev-devices-test-');
  const bin = path.join(root, 'bin');
  const src = path.join(root, 'main.opu');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), DEV_STUB, { mode: 0o755 });
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  let handle;
  try {
    handle = await dev({ src, port: 0, root, signals: false, backend: false, log: () => {}, targets: ['web'] });
    const base = `http://127.0.0.1:${handle.server.address().port}`;

    assert.equal((await fetch(`${base}/devices`, {
      method: 'POST', body: JSON.stringify({ id: 'laptop', target: 'web' }),
    })).status, 201);
    assert.equal((await fetch(`${base}/devices`, {
      method: 'POST', body: JSON.stringify({ id: 'phone', target: 'mini' }),
    })).status, 201);

    let listed = await (await fetch(`${base}/devices`)).json();
    assert.equal(listed.devices.length, 2);
    assert.equal(listed.revision, 0);
    const health0 = await (await fetch(`${base}/health`)).json();
    assert.equal(health0.devices, 2);
    assert.equal(health0.revision, 0);

    fs.appendFileSync(src, '// touch\n');
    const deadline = Date.now() + 9000;
    let health = health0;
    while (health.revision < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      health = await (await fetch(`${base}/health`)).json();
    }
    assert.ok(health.revision >= 1, 'a reload decision was committed');

    listed = await (await fetch(`${base}/devices`)).json();
    assert.equal(listed.revision, handle.registry.revision);
    assert.ok(listed.devices.every((d) => d.lastSeen === listed.revision), 'both devices saw the broadcast');

    const replay = await (await fetch(`${base}/reload?since=0`)).json();
    assert.ok(replay.decisions.length >= 1);
    for (const decision of replay.decisions) {
      assert.deepEqual(Object.keys(decision).sort(), ['kind', 'reason', 'revision']);
      assert.equal(typeof decision.revision, 'number');
    }
  } finally {
    if (handle) await handle.close();
    process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
