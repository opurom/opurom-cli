import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { dev } from '../lib/dev.mjs';
import { devStateUrl, inspectDevState, inspectDevTree, stateViewJson, stateViewText } from '../lib/inspect_dev.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

// Self-contained stub compiler: the web-dom page carries a router-style
// `var state = {...}` closure (the shape exposeRouterState publishes) so the
// whole observability path runs without a sibling repo or a browser.
const STUB = `#!/bin/sh
set -e
case "$1" in
  compile)
    printf '%s\\n' '{"ir":"0.1.0","app":"Counter","state":[{"name":"count","type":"int","init":0}],"tree":{"id":1,"kind":"Text","props":{},"children":[],"events":{}},"theme":{}}' > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<!DOCTYPE html>' '<html lang="en"><head><meta charset="utf-8"></head><body>' '<main id="app"><button data-node-id="1" type="button">+</button></main>' '<script>(function () { var state = {"count":0}; })();</script>' '</body></html>' > "$6/index.html" ;;
  *) exit 2 ;;
esac
`;

function setup(name, stub = STUB) {
  const base = tmpDir(name);
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), stub, { mode: 0o755 });
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

async function readSseUntil(response, needle, timeoutMs = 8000) {
  const reader = response.body.getReader();
  let text = '';
  const pump = (async () => {
    while (!text.includes(needle)) {
      const { value, done } = await reader.read();
      if (done) break;
      text += Buffer.from(value).toString('utf8');
    }
    return text;
  })();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no ${needle} within ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([pump, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

test('dev server ingests state + events and serves the /__opurom/state snapshot', { timeout: 20000 }, async () => {
  const env = setup('dev-inspect-test-');
  let handle;
  let controller;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    const html = await (await fetch(`${baseUrl}/index.html`)).text();
    assert.match(html, /fetch\('\/__opurom\/state'/, 'the injected dev client must report state');
    assert.match(html, /\['click', 'input', 'change', 'keydown'\]/, 'the dev client must capture interactions');
    assert.match(html, /window\.opurom\.state = state; \/\/ __opurom_router_state__/,
      'the web-dom router closure state must be published for the reporter');

    const initial = await (await fetch(`${baseUrl}/__opurom/state`)).json();
    assert.equal(initial.state, null);
    assert.equal(initial.stateAt, null);
    assert.deepEqual(initial.events, []);
    assert.equal(initial.eventCount, 0);

    controller = new AbortController();
    const sseResponse = await fetch(`${baseUrl}/__opurom/events`, { signal: controller.signal });
    const stateFrame = readSseUntil(sseResponse, 'event: state');

    const post = await fetch(`${baseUrl}/__opurom/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        state: { count: 1 },
        events: [{ type: 'click', nodeId: 1 }, { type: 'input', nodeId: 'nope' }, { kind: 'ignored' }],
      }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), { ok: true, eventCount: 2 });

    const snapshot = await (await fetch(`${baseUrl}/__opurom/state`)).json();
    assert.deepEqual(snapshot.state, { count: 1 });
    assert.ok(snapshot.stateAt, 'the server must stamp the report');
    assert.equal(snapshot.eventCount, 2);
    assert.deepEqual(snapshot.events.map((event) => [event.seq, event.type, event.nodeId]),
      [[1, 'click', 1], [2, 'input', null]], 'seq is server-side and invalid records degrade to node=null');
    assert.ok(snapshot.events.every((event) => typeof event.at === 'string'));

    const frame = await stateFrame;
    assert.match(frame, /event: state\n/);
    assert.match(frame, /"count":1/);
    controller.abort();
    controller = null;

    const bad = await fetch(`${baseUrl}/__opurom/state`, { method: 'POST', body: 'not json' });
    assert.equal(bad.status, 400);
    const huge = await fetch(`${baseUrl}/__opurom/state`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: 'x'.repeat(70000) }),
    });
    assert.equal(huge.status, 413, 'an oversized report is refused, not buffered');
    const wrongMethod = await fetch(`${baseUrl}/__opurom/state`, { method: 'DELETE' });
    assert.equal(wrongMethod.status, 405);
  } finally {
    if (controller) controller.abort();
    if (handle) await handle.close();
    env.restore();
  }
});

test('inspect --dev renders the snapshot as text and stable JSON', { timeout: 20000 }, async () => {
  const env = setup('dev-inspect-view-');
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    await fetch(`${baseUrl}/__opurom/state`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: { count: 1 }, events: [{ type: 'click', nodeId: 1 }, { type: 'click', nodeId: 1 }] }),
    });

    const lines = [];
    const code = await inspectDevState({ url: baseUrl, log: (line) => lines.push(String(line)) });
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /Opurom inspect live state/);
    assert.match(text, new RegExp(`dev: ${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(text, /state reported at /);
    assert.match(text, /  count=1/);
    assert.match(text, /events: 2 total, showing 2 \(oldest first\)/);
    assert.match(text, /  #1 click node=1 at=/);

    const jsonLines = [];
    await inspectDevState({ url: baseUrl, json: true, log: (line) => jsonLines.push(String(line)) });
    const parsed = JSON.parse(jsonLines.join('\n'));
    assert.equal(parsed.command, 'inspect');
    assert.equal(parsed.mode, 'state');
    assert.deepEqual(parsed.state, { count: 1 });
    assert.equal(parsed.eventCount, 2);
    assert.equal(parsed.events.length, 2);

    // A page that exposes no store reads as "no state", not as a failure.
    const text2 = stateViewText({ base: 'http://x', snapshot: { state: null, stateAt: null, events: [], eventCount: 0 } });
    assert.match(text2, /state: not reported yet/);
    assert.match(text2, /events: none yet/);
    const json2 = stateViewJson({ base: 'http://x', snapshot: {} });
    assert.deepEqual(json2, { command: 'inspect', mode: 'state', url: 'http://x', state: null, stateAt: null, eventCount: 0, events: [] });
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('inspect --dev normalizes urls and fails clearly without a dev server', async () => {
  assert.equal(devStateUrl(true), 'http://127.0.0.1:5178');
  assert.equal(devStateUrl(undefined), 'http://127.0.0.1:5178');
  assert.equal(devStateUrl(''), 'http://127.0.0.1:5178');
  assert.equal(devStateUrl('127.0.0.1:5199/'), 'http://127.0.0.1:5199');
  assert.equal(devStateUrl('https://example.test:1/'), 'https://example.test:1');
  await assert.rejects(
    inspectDevState({ url: 'http://127.0.0.1:1', log: () => {} }),
    /dev server not reachable at http:\/\/127\.0\.0\.1:1/,
  );
});

test('CLI inspect refuses a positional IR together with --dev', () => {
  const result = run(process.execPath, [CLI, 'inspect', 'a.json', '--dev', 'http://127.0.0.1:1'], { timeout: 20000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /accepts <ir\.json> or --dev <url>, not both/);
  const help = run(process.execPath, [CLI, '--help'], { timeout: 20000 });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /inspect --dev \[<url>\] \[--tree\|--digest\] \[--select <id>\] \[--layers\] \[--json\]/);
});

// A renderer stub replaying bounds for the stub compiler's one-node IR; the
// tree view must treat these as authoritative, same as the static view.
const RENDERER_STUB = `#!/bin/sh
prev=""
a11y=""
commands=""
for arg in "$@"; do
  if [ "$prev" = "--a11y" ]; then a11y="$arg"; fi
  if [ "$prev" = "--commands" ]; then commands="$arg"; fi
  prev="$arg"
done
if [ -n "$a11y" ]; then
  printf '%s' '[{"id":1,"role":"text","label":"Counter","bounds":[10,20,120,24],"hidden":false}]' > "$a11y"
fi
if [ -n "$commands" ]; then printf '%s' '[]' > "$commands"; fi
printf 'digest=0123456789abcdef\\n'
printf 'dirty=1\\n'
printf 'P6\\n1 1\\n255\\n' > "$4"
`;

// The stub compiler's `target` step ignores its input, so an unreadable IR
// document still produces a serving dev server whose IR endpoint reports the
// no-compile reason instead of a broken tree.
const BROKEN_IR_STUB = STUB.replace(/\{"ir":[^']*\}/, 'not json');

function workspaceWithRenderer() {
  const base = tmpDir('inspect-dev-renderer-');
  const renderer = path.join(base, 'opurom-render');
  fs.writeFileSync(renderer, RENDERER_STUB, { mode: 0o755 });
  return { base, renderer };
}

test('dev server serves the last-good IR document at /__opurom/ir', { timeout: 20000 }, async () => {
  const env = setup('dev-inspect-ir-');
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const response = await fetch(`${baseUrl}/__opurom/ir`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.ok(payload.at, 'the endpoint stamps the IR with its build time');
    assert.equal(payload.rebuilds, 1);
    assert.equal(payload.ir.ir, '0.1.0');
    assert.equal(payload.ir.app, 'Counter');
    assert.equal(payload.ir.tree.id, 1);
    const wrongMethod = await fetch(`${baseUrl}/__opurom/ir`, { method: 'POST' });
    assert.equal(wrongMethod.status, 405);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('a dev server without a readable IR answers 404 with a reason', { timeout: 20000 }, async () => {
  assert.match(BROKEN_IR_STUB, /not json/);
  const env = setup('dev-inspect-ir-404-', BROKEN_IR_STUB);
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const response = await fetch(`${baseUrl}/__opurom/ir`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { ok: false, error: 'no compiled IR yet', reason: 'no-compile-yet' });
    await assert.rejects(
      inspectDevTree({ url: baseUrl, renderer: '/bin/true', log: () => {} }),
      /has no compiled IR yet \(reason: no-compile-yet\)/,
    );
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('inspect --dev --tree renders the live IR tree as text and stable JSON', { timeout: 20000 }, async () => {
  const env = setup('dev-inspect-tree-');
  const { renderer } = workspaceWithRenderer();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    const lines = [];
    const code = await inspectDevTree({ url: baseUrl, renderer, log: (line) => lines.push(String(line)) });
    assert.equal(code, 0);
    const text = lines.join('\n');
    assert.match(text, /Opurom inspect widget tree/);
    assert.match(text, /app: Counter \(ir 0\.1\.0\)/);
    assert.match(text, /#1 Text bounds=\[10,20,120,24\]/);

    const runJson = () => new Promise((resolve, reject) => {
      const out = [];
      inspectDevTree({ url: baseUrl, renderer, json: true, log: (line) => out.push(String(line)) })
        .then((value) => resolve({ value, text: out.join('\n') }), reject);
    });
    const first = await runJson();
    const second = await runJson();
    assert.deepEqual(first.value, 0);
    assert.equal(first.text, second.text, 'the JSON form is byte-stable');
    const parsed = JSON.parse(first.text);
    assert.deepEqual(Object.keys(parsed), ['command', 'mode', 'app', 'viewport', 'selected', 'nodes']);
    assert.equal(parsed.mode, 'tree');
    assert.equal(parsed.nodes[0].id, 1);
    assert.deepEqual(parsed.nodes[0].bounds, [10, 20, 120, 24]);

    await assert.rejects(
      inspectDevTree({ url: baseUrl, renderer, select: '9', log: () => {} }),
      /unknown node id: 9/,
    );
    const selected = [];
    await inspectDevTree({ url: baseUrl, renderer, select: '1', log: (line) => selected.push(String(line)) });
    assert.match(selected.join('\n'), /#1 Text/);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('inspect --dev --tree fails clearly without a dev server and through the CLI', () => {
  const { renderer } = workspaceWithRenderer();
  return assert.rejects(
    inspectDevTree({ url: 'http://127.0.0.1:1', renderer, log: () => {} }),
    /dev server not reachable at http:\/\/127\.0\.0\.1:1/,
  ).then(() => {
    const cli = run(process.execPath, [CLI, 'inspect', '--dev', 'http://127.0.0.1:1', '--tree'], { timeout: 20000 });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /dev server not reachable at http:\/\/127\.0\.0\.1:1/);
    const badFlags = run(process.execPath, [CLI, 'inspect', '--dev', '--select', '1'], { timeout: 20000 });
    assert.equal(badFlags.status, 1);
    assert.match(badFlags.stderr, /--select\/--layers require --tree/);
  });
});
