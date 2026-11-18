import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { dev } from '../lib/dev.mjs';

// Stub compiler: every compile bumps a counter embedded in the IR tree, so a
// manual reload always sees a tree-only (hot) change unless the mode file asks
// for a build failure (retryable) or an unreadable IR (unrecoverable).
const STUB = `#!/bin/sh
set -e
mode=plain; [ -f 'MODE_FILE' ] && mode=$(cat 'MODE_FILE')
case "$1" in
  compile)
    if [ "$mode" = "fail" ]; then exit 3; fi
    n=0; [ -f "$0.count" ] && n=$(cat "$0.count"); n=$((n + 1)); echo "$n" > "$0.count"
    printf '%s\\n' "{\\"ir\\":\\"0.1.0\\",\\"app\\":\\"Counter\\",\\"state\\":[{\\"name\\":\\"count\\",\\"type\\":\\"int\\",\\"init\\":0}],\\"tree\\":{\\"id\\":$n,\\"kind\\":\\"Text\\",\\"props\\":{\\"value\\":\\"a\\"},\\"children\\":[],\\"events\\":{}},\\"theme\\":{}}" > "$4" ;;
  target)
    if [ "$mode" = "dead" ]; then printf '%s\\n' 'opurom-render exited (1)' >&2; exit 4; fi
    mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<!DOCTYPE html><html><head></head><body><main id="app"></main></body></html>' > "$6/index.html" ;;
  *) exit 2 ;;
esac
`;

function setup() {
  const base = tmpDir('dev-manual-reload-');
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  const modeFile = path.join(base, 'mode');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), STUB.replaceAll("MODE_FILE", modeFile), { mode: 0o755 });
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  return {
    base, src, modeFile,
    restore: () => {
      process.env.PATH = oldPath;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

const post = (baseUrl, body) => fetch(`${baseUrl}/__opurom/reload`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('manual reload and restart trigger the same IR diff path', { timeout: 30000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    const reload = await (await post(baseUrl, { kind: 'reload' })).json();
    assert.equal(reload.ok, true);
    assert.equal(reload.code, 'RELOAD_APPLIED');
    assert.equal(reload.kind, 'hot', 'the counter-bumped IR is a tree-only change');

    const restart = await (await post(baseUrl, { kind: 'restart' })).json();
    assert.equal(restart.code, 'RELOAD_APPLIED');
    assert.equal(restart.kind, 'full');
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.lastReload.reason, 'manual-restart');
    assert.equal(health.reloads, 2);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('reload frames carry phase timings for machine consumers', { timeout: 30000 }, async () => {
  const env = setup();
  let handle;
  let controller;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    controller = new AbortController();
    const stream = await fetch(`${baseUrl}/__opurom/events`, { signal: controller.signal });
    const reader = stream.body.getReader();
    const frame = (async () => {
      let text = '';
      while (!text.includes('event: reload')) {
        const { value, done } = await reader.read();
        if (done) break;
        text += Buffer.from(value).toString('utf8');
      }
      return text;
    })();
    await post(baseUrl, { kind: 'reload' });
    const payload = JSON.parse((await frame).split('event: reload\ndata: ')[1].split('\n')[0]);
    for (const key of ['compileMs', 'devfsMs', 'vmMs', 'reassembleMs']) {
      assert.equal(Number.isInteger(payload.timings[key]), true, `${key} must be an integer`);
      assert.ok(payload.timings[key] >= 0, `${key} must be non-negative`);
    }
    controller.abort();
    controller = null;
  } finally {
    if (controller) controller.abort();
    if (handle) await handle.close();
    env.restore();
  }
});

test('failed builds separate retryable from restart-required errors', { timeout: 30000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    fs.writeFileSync(env.modeFile, 'fail\n');
    const retryable = await (await post(baseUrl, { kind: 'reload' })).json();
    assert.equal(retryable.ok, false);
    assert.equal(retryable.code, 'BUILD_ERROR_RETRYABLE');
    assert.equal(retryable.retryable, true);
    assert.equal(retryable.reason, 'fix-and-retry');

    fs.writeFileSync(env.modeFile, 'dead\n');
    const unrecoverable = await (await post(baseUrl, { kind: 'reload' })).json();
    assert.equal(unrecoverable.code, 'RELOAD_UNRECOVERABLE');
    assert.equal(unrecoverable.retryable, false);
    assert.equal(unrecoverable.reason, 'restart-required');

    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.lastErrorDetail.code, 'RELOAD_UNRECOVERABLE');
    assert.equal(health.lastError, unrecoverable.message);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('failed builds roll back the live IR and keep the last good state', { timeout: 30000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const good = await (await fetch(`${baseUrl}/__opurom/ir`)).json();
    assert.equal(good.ok, true);

    fs.writeFileSync(env.modeFile, 'fail\n');
    const failed = await (await post(baseUrl, { kind: 'reload' })).json();
    assert.equal(failed.ok, false);
    const after = await (await fetch(`${baseUrl}/__opurom/ir`)).json();
    assert.equal(after.ok, true);
    assert.deepEqual(after.ir, good.ir, 'a failed compile must not publish a partial IR');
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.lastErrorDetail.code, failed.code);

    fs.rmSync(env.modeFile);
    const recovered = await (await post(baseUrl, { kind: 'reload' })).json();
    assert.equal(recovered.ok, true);
    assert.equal(recovered.kind, 'hot');
    const newer = await (await fetch(`${baseUrl}/__opurom/ir`)).json();
    assert.notDeepEqual(newer.ir, good.ir, 'the next successful build must advance the IR');
    const recoveredHealth = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(recoveredHealth.lastError, null);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('SIGUSR1 triggers a manual reload', { timeout: 30000 }, async () => {
  const env = setup();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: true, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const before = (await (await fetch(`${baseUrl}/health`)).json()).reloads;
    process.kill(process.pid, 'SIGUSR1');
    const after = await waitFor(async () => {
      const health = await (await fetch(`${baseUrl}/health`)).json();
      return health.reloads > before ? health : null;
    });
    assert.equal(after.lastReload.trigger, 'signal-SIGUSR1');
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});
