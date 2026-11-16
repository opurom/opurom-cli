import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { dev } from '../lib/dev.mjs';
import { devStateUrl, inspectDevState, stateViewJson, stateViewText } from '../lib/inspect_dev.mjs';

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
  assert.match(help.stdout, /inspect --dev \[<url>\] \[--json\]/);
});
