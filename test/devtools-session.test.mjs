// DevTools session discovery parity. Flutter authority (3.50-candidate.0):
// - packages/flutter_tools/lib/src/commands/daemon.dart:1636-1660 (devtools.serve -> host/port)
// - packages/flutter_tools/lib/src/devtools_launcher.dart:39-95 (serve + URL pattern)
// - packages/flutter_tools/lib/src/resident_runner.dart:2012-2043,2090-2098 (launcher/address contract)
// Opurom has no VM Service: the running `opurom dev` server is the session and
// its read-only data-plane endpoints are advertised verbatim.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { tmpDir, workspaceRoot } from '../lib/paths.mjs';
import { dev } from '../lib/dev.mjs';
import { inspectDevtools } from '../lib/inspect_dev.mjs';
import { run } from '../lib/proc.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));
const STUB = `#!/bin/sh
set -e
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1.0","app":"Counter","state":[],"tree":{"id":1,"kind":"Text","props":{},"children":[],"events":{}},"theme":{}}' > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json"; printf '%s\\n' '<!DOCTYPE html><html><body>ok</body></html>' > "$6/index.html" ;;
  *) exit 2 ;;
esac
`;

test('devtools.serve advertises the live session and its data plane', { timeout: 20000 }, async () => {
  const base = tmpDir('devtools-session-');
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), STUB, { mode: 0o755 });
  fs.writeFileSync(src, 'app Counter\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  let handle;
  try {
    handle = await dev({
      src, port: 0, root: base, signals: false, backend: false, log: () => {},
      environment: { name: 'test', defines: {} }, buildInfo: { mode: 'debug' },
    });
    const url = `http://127.0.0.1:${handle.server.address().port}`;
    const session = await (await fetch(`${url}/api/devtools/session`)).json();
    assert.equal(session.service, 'opurom-devtools');
    assert.equal(session.host, '127.0.0.1');
    assert.equal(session.port, handle.server.address().port);
    assert.equal(session.uri, url);
    assert.equal(session.devtoolsUri, `${url}/inspector`);
    assert.equal(session.framesUri, `${url}/api/inspect/frames`);
    assert.equal(session.logsUri, `${url}/api/logs`);
    assert.equal(session.exitUri, `${url}/api/devtools/exit`);
    assert.equal(session.environment, 'test');
    assert.equal(session.mode, 'debug');
    assert.equal(typeof session.inspectorAvailable, 'boolean');
    assert.equal(session.debugAdapter, path.join(workspaceRoot(), 'opurom-debug', 'bin', 'server.mjs'));

    // Every advertised URL must be real; no dead links in the session record.
    assert.equal((await fetch(session.framesUri)).status, 200);
    assert.equal((await fetch(session.memoryUri)).status, 200);
    assert.equal((await fetch(session.networkUri)).status, 200);
    assert.equal((await fetch(session.irUri)).status, 200);
    assert.equal((await fetch(session.devtoolsUri)).status, session.inspectorAvailable ? 200 : 404);
    const logResponse = await fetch(`${session.logsUri}?level=info&q=dev%20server&format=text`);
    assert.equal(logResponse.status, 200);
    assert.match(await logResponse.text(), /\[INFO\] dev: dev server starting/);
    const badLevel = await fetch(`${session.logsUri}?level=debug`);
    assert.equal(badLevel.status, 400);
    assert.match((await badLevel.json()).error, /invalid log level/);

    const lines = [];
    await inspectDevtools({ url, log: (line) => lines.push(String(line)) });
    assert.match(lines.join('\n'), /Opurom DevTools session/);
    assert.match(lines.join('\n'), new RegExp(session.framesUri.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const jsonLines = [];
    await inspectDevtools({ url, json: true, log: (line) => jsonLines.push(String(line)) });
    assert.deepEqual(JSON.parse(jsonLines.join('\n')), session);
  } finally {
    if (handle) await handle.close();
    process.env.PATH = oldPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('devtools CLI prints a clear error when no dev server is running', () => {
  const result = run(process.execPath, [CLI, 'devtools', 'http://127.0.0.1:1'], { timeout: 20000 });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr + result.stdout, /dev server not reachable/);
});

test('devtools CLI help documents the session command', () => {
  const help = run(process.execPath, [CLI, '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /devtools \[<url>\] \[--json\]/);
});
