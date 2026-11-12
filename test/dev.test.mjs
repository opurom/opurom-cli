import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { devClientScript, injectDevClient, mimeType, patchAppState, resolveStatic, sseFrame } from '../lib/dev.mjs';

test('SSE client uses the state key, reload event and sessionStorage', () => {
  const script = devClientScript();
  assert.match(script, /<script>/);
  assert.match(script, /new EventSource\('\/__opurom\/events'\)/);
  assert.match(script, /'opurom\.state'/);
  assert.match(script, /sessionStorage\.setItem/);
  assert.match(script, /addEventListener\('reload'/);
  assert.match(script, /location\.reload\(\)/);
});

test('injectDevClient puts the client in head before app.js, only once', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body><script src="app.js"></script></body></html>';
  const injected = injectDevClient(html);
  assert.ok(injected.indexOf('/__opurom/events') < injected.indexOf('app.js'));
  assert.ok(injected.startsWith('<!doctype html><html><head>'));
  assert.equal(injectDevClient(injected), injected);
  const bodyOnly = injectDevClient('<body>hi</body>');
  assert.ok(bodyOnly.indexOf('<script>') < bodyOnly.indexOf('</body>'));
  assert.match(injectDevClient('plain'), /^<script>/);
});

test('patchAppState merges the snapshot into generated state and exposes it', () => {
  const js = '"use strict";\nconst state = {"count":0};\nrender();\n';
  const patched = patchAppState(js);
  assert.match(patched, /const state = Object\.assign\(\{"count":0\}, window\.__OPUROM_STATE_RESTORE__ \|\| \{\}\);/);
  assert.match(patched, /window\.opurom\.state = typeof state/);
  assert.equal(patchAppState(patched), patched);
  assert.match(patchAppState('render();\n'), /__opurom_state_exposed__/);
});

test('resolveStatic rejects traversal and maps / to index.html', () => {
  const root = path.resolve('/tmp/opurom-dev');
  assert.equal(resolveStatic(root, '/'), path.join(root, 'index.html'));
  assert.equal(resolveStatic(root, '/app.js'), path.join(root, 'app.js'));
  assert.equal(resolveStatic(root, '/../package.json'), null);
  assert.equal(resolveStatic(root, '/%2e%2e/package.json'), null);
});

test('sseFrame and mimeType produce usable wire values', () => {
  assert.equal(sseFrame('reload', { at: 'now' }), 'event: reload\ndata: {"at":"now"}\n\n');
  assert.match(mimeType('app.js'), /javascript/);
  assert.match(mimeType('index.html'), /text\/html/);
  assert.equal(mimeType('data.bin'), 'application/octet-stream');
});
