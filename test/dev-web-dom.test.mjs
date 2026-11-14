import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { dev, devClientScript } from '../lib/dev.mjs';

// Self-contained stub: web-dom emits one responsive index.html and no app.js,
// the legacy web emitter emits a fixed canvas plus app.js, other emitters get
// the same canvas-shaped files. No sibling Rust repo is needed.
const STUB = `#!/bin/sh
set -e
case "$1" in
  compile)
    n=0; [ -f "$0.count" ] && n=$(cat "$0.count"); n=$((n + 1)); echo "$n" > "$0.count"
    printf '%s\\n' "{\\"ir\\":\\"0.1\\",\\"app\\":\\"Counter\\",\\"state\\":[],\\"tree\\":{\\"id\\":$n},\\"theme\\":{}}" > "$4" ;;
  target)
    name="$4"; out="$6"; mkdir -p "$out"; cp "$2" "$out/ir.json"
    case "$name" in
      web-dom)
        printf '%s\\n' '<!DOCTYPE html>' '<html lang="en"><head>' \\
          '<meta name="viewport" content="width=device-width, initial-scale=1">' \\
          '<style>@media (max-width: 599px) { .row { flex-direction: column; } }</style>' \\
          '</head><body>' \\
          '<main id="app"><div data-node-id="0" class="node column"><button data-node-id="1" role="button">+</button></div></main>' \\
          '</body></html>' > "$out/index.html" ;;
      web)
        printf '%s\\n' '<html><head><title>canvas</title></head><body><canvas width="800" height="600"></canvas><script src="app.js"></script></body></html>' > "$out/index.html"
        printf '%s\\n' 'const state = {"count":7};' > "$out/app.js" ;;
      *)
        printf '%s\\n' '<html><head><title>other</title></head><body><script src="app.js"></script></body></html>' > "$out/index.html"
        printf '%s\\n' 'const state = {"count":7};' > "$out/app.js" ;;
    esac ;;
  *) exit 2 ;;
esac
`;

function setup() {
  const base = tmpDir('dev-web-dom-test-');
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

test('default dev preview is the responsive web-dom page with SSE hot reload', { timeout: 20000 }, async () => {
  const env = setup();
  const logs = [];
  let handle;
  let controller;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false,
      log: (line) => logs.push(String(line)),
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.targets, ['web-dom']);
    assert.deepEqual(health.stateRestore, ['web-dom']);
    assert.equal(health.rebuilds, 1);

    const page = await fetch(baseUrl);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="viewport"/);
    assert.match(html, /@media/);
    assert.match(html, /data-node-id=/);
    assert.match(html, /__opurom\/events/, 'the dev SSE client must be injected');
    assert.match(html, /sessionStorage/, 'the page must read/write the state snapshot');
    assert.match(html, /__OPUROM_STATE_RESTORE__/, 'the page must restore the snapshot on load');
    assert.doesNotMatch(html, /width="800" height="600"/, 'the fixed canvas is not the default page');
    assert.equal((await fetch(`${baseUrl}/app.js`)).status, 404, 'web-dom emits no app.js');
    assert.ok(logs.some((line) => /web-dom: SSE hot reload; state snapshot restored/.test(line)),
      'the dev log must state that web-dom restores a state snapshot');

    // Hot reload still works: a source change broadcasts a reload frame.
    controller = new AbortController();
    const response = await fetch(`${baseUrl}/__opurom/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    const events = (async () => {
      let text = '';
      while (!text.includes('event: reload')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
      return text;
    })();
    fs.appendFileSync(env.src, '// touch\n');
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('no reload event within 8s')), 8000);
    });
    let text;
    try {
      text = await Promise.race([events, deadline]);
    } finally {
      clearTimeout(timer);
    }
    assert.match(text, /event: reload/);
    controller.abort();
    controller = null;
  } finally {
    if (controller) controller.abort();
    if (handle) await handle.close();
    env.restore();
  }
});

test('dev --targets web keeps the legacy canvas page and state restore patch', { timeout: 20000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false,
      log: () => {}, targets: 'web',
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.targets, ['web']);
    assert.deepEqual(health.stateRestore, ['web']);
    const html = await (await fetch(baseUrl)).text();
    assert.match(html, /width="800" height="600"/);
    assert.doesNotMatch(html, /name="viewport"/);
    assert.doesNotMatch(html, /@media/);
    assert.match(html, /__opurom\/events/);
    const app = await (await fetch(`${baseUrl}/app.js`)).text();
    assert.match(app, /__OPUROM_STATE_RESTORE__/);
    assert.match(app, /window\.opurom\.state/);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('dev --targets web-dom,web serves both pages and patches only web', { timeout: 20000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false,
      log: () => {}, targets: 'web-dom,web',
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.targets, ['web-dom', 'web']);
    assert.deepEqual(health.stateRestore, ['web-dom', 'web']);
    const index = await (await fetch(baseUrl)).text();
    assert.match(index, /href="\/web-dom\/index\.html">web-dom<\/a>/);
    assert.match(index, /href="\/web\/index\.html">web<\/a>/);
    const responsive = await (await fetch(`${baseUrl}/web-dom/index.html`)).text();
    assert.match(responsive, /name="viewport"/);
    assert.match(responsive, /@media/);
    assert.match(responsive, /__opurom\/events/);
    const legacy = await (await fetch(`${baseUrl}/web/app.js`)).text();
    assert.match(legacy, /__OPUROM_STATE_RESTORE__/);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('dev --targets web,wechat still lowers two emitters from one IR', { timeout: 20000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false,
      log: () => {}, targets: 'web,wechat',
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.targets, ['web', 'wechat']);
    assert.deepEqual(health.stateRestore, ['web']);
    const index = await (await fetch(baseUrl)).text();
    assert.match(index, /href="\/web\/index\.html">web<\/a>/);
    assert.match(index, /href="\/wechat\/index\.html">wechat<\/a>/);
    const wechatApp = await (await fetch(`${baseUrl}/wechat/app.js`)).text();
    assert.doesNotMatch(wechatApp, /__OPUROM_STATE_RESTORE__/);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('web-dom hot reload writes the edited state to the session snapshot before reloading', () => {
  const body = devClientScript().replace(/^<script>/, '').replace(/<\/script>$/, '');
  const writes = [];
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, value); writes.push(value); },
  };
  const listeners = {};
  const events = {
    addEventListener(type, handler) { (listeners[type] ??= []).push(handler); },
  };
  const EventSource = function () { return events; };
  const reloads = [];
  const window = {};
  const run = new Function('window', 'sessionStorage', 'EventSource', 'location', `${body};`);
  run(window, storage, EventSource, { reload: () => reloads.push('reload') });

  // The responsive DOM page's state runtime exposes the live, edited state.
  window.opurom = { state: { count: 5 } };
  for (const handler of listeners.reload) handler();

  assert.equal(reloads.length, 1, 'a source save reloads the page');
  assert.deepEqual(JSON.parse(writes.at(-1)), { count: 5 }, 'the edited state is written before the reload');
});
