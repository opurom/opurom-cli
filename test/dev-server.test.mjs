import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { dev } from '../lib/dev.mjs';

// Self-contained: a stub opuromc on PATH means no sibling Rust repo is needed.
const STUB = `#!/bin/sh
set -e
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<html><head><title>x</title></head><body><script src="app.js"></script></body></html>' > "$6/index.html";
    printf '%s\\n' 'const state = {"count":7};' > "$6/app.js" ;;
  *) exit 2 ;;
esac
`;

test('dev server serves injected html, health, and an SSE reload on source change', { timeout: 20000 }, async () => {
  const base = tmpDir('dev-test-');
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), STUB, { mode: 0o755 });
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  let handle;
  let controller;
  try {
    // The legacy web canvas page keeps the state-preserving app.js rewrite.
    handle = await dev({ src, port: 0, root: base, signals: false, log: () => {}, targets: ['web'] });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.rebuilds, 1);
    const html = await (await fetch(`${baseUrl}/index.html`)).text();
    assert.match(html, /__opurom\/events/);
    assert.ok(html.indexOf('__opurom/events') < html.indexOf('app.js'));
    const app = await (await fetch(`${baseUrl}/app.js`)).text();
    assert.match(app, /__OPUROM_STATE_RESTORE__/);
    assert.match(app, /window\.opurom\.state/);

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
    fs.appendFileSync(src, '// touch\n');
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
    assert.match(text, /event: ready/);
    assert.match(text, /event: reload/);
    controller.abort();
    controller = null;
  } finally {
    if (controller) controller.abort();
    if (handle) await handle.close();
    process.env.PATH = oldPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// Same stub compiler as above, plus one log line per invocation so the test can
// count compiles and lowerings.
function stubWithCallLog(callsFile) {
  return `#!/bin/sh
set -e
printf '%s\\n' "$1" >> '${callsFile}'
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<html><head><title>multi</title></head><body><script src="app.js"></script></body></html>' > "$6/index.html";
    printf '%s\\n' 'const state = {"count":7};' > "$6/app.js" ;;
  *) exit 2 ;;
esac
`;
}

test('dev --targets lowers two targets from one IR per rebuild and serves a listing page', { timeout: 20000 }, async () => {
  const base = tmpDir('dev-multi-test-');
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  const calls = path.join(base, 'calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), stubWithCallLog(calls), { mode: 0o755 });
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  let handle;
  try {
    handle = await dev({
      src, port: 0, root: base, signals: false, backend: false, log: () => {}, targets: ['web', 'wechat'],
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.deepEqual(health.targets, ['web', 'wechat']);
    assert.equal(health.rebuilds, 1);

    // One compile, two lowerings: both previews come from the same compiled IR.
    const callNames = () => fs.readFileSync(calls, 'utf8').trim().split('\n');
    let names = callNames();
    assert.equal(names.filter((n) => n === 'compile').length, 1);
    assert.equal(names.filter((n) => n === 'target').length, 2);

    const index = await (await fetch(baseUrl)).text();
    assert.match(index, /<title>opurom dev targets<\/title>/);
    assert.match(index, /href="\/web\/index\.html">web<\/a>/);
    assert.match(index, /href="\/wechat\/index\.html">wechat<\/a>/);
    assert.match(index, /__opurom\/events/);
    const webApp = await (await fetch(`${baseUrl}/web/app.js`)).text();
    assert.match(webApp, /__OPUROM_STATE_RESTORE__/);
    const wechatApp = await (await fetch(`${baseUrl}/wechat/app.js`)).text();
    assert.doesNotMatch(wechatApp, /__OPUROM_STATE_RESTORE__/);
    const wechatIr = await (await fetch(`${baseUrl}/wechat/ir.json`)).text();
    assert.match(wechatIr, /"ir":"0\.1"/);

    fs.appendFileSync(src, '// touch\n');
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('rebuild not observed within 8s')), 8000);
    });
    const poll = (async () => {
      for (;;) {
        const current = await (await fetch(`${baseUrl}/health`)).json();
        if (current.rebuilds === 2) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    })();
    try {
      await Promise.race([poll, deadline]);
    } finally {
      clearTimeout(timer);
    }
    names = callNames();
    assert.equal(names.filter((n) => n === 'compile').length, 2);
    assert.equal(names.filter((n) => n === 'target').length, 4);
  } finally {
    if (handle) await handle.close();
    process.env.PATH = oldPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
