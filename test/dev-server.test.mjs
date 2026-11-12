import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLI_ROOT } from '../lib/paths.mjs';
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
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const base = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'dev-test-'));
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
    handle = await dev({ src, port: 0, root: base, signals: false, log: () => {} });
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
