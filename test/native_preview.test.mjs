import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { dev } from '../lib/dev.mjs';
import {
  createNativePreview, eventLine, parseStateOutput, replayLines, statePreserved,
} from '../lib/native_preview.mjs';
import { inspectDevState } from '../lib/inspect_dev.mjs';

const logs = [];
const lines = [];
const buildLogs = [];

// Pure routing: state parsing, event validation and the replay plan.
test('parseStateOutput reads the binary state line into typed fields', () => {
  assert.deepEqual(parseStateOutput('state count=7'), { count: 7 });
  assert.deepEqual(parseStateOutput('state count=-3 name=ok'), { count: -3, name: 'ok' });
  assert.deepEqual(parseStateOutput('state count=1.5'), { count: '1.5' }, 'decimals stay strings');
  assert.deepEqual(parseStateOutput('frame: 800x600 wrote /tmp/x\nstate count=2\n'), { count: 2 });
  assert.deepEqual(parseStateOutput('no state here'), {});
});

test('eventLine validates interactions into stdio lines', () => {
  assert.equal(eventLine({ op: 'tap', id: 4 }), 'tap 4');
  assert.equal(eventLine({ op: 'input', id: 5, text: 'hello world' }), 'input 5 hello world');
  assert.equal(eventLine({ op: 'input', id: 5 }), 'input 5');
  assert.equal(eventLine({ op: 'input', id: 5, text: 'a\nb' }), 'input 5 a b', 'newlines cannot inject commands');
  assert.equal(eventLine({ op: 'hover', id: 1 }), null, 'unknown ops are refused');
  assert.equal(eventLine({ op: 'tap', id: 'x' }), null, 'non-integer ids are refused');
  assert.equal(eventLine({ op: 'tap', id: -1 }), null);
  assert.equal(eventLine({ op: 'tap' }), null);
  assert.equal(eventLine(null), null);
});

test('replayLines maps the recorded log and preserves the ordering', () => {
  assert.deepEqual(replayLines([{ op: 'tap', id: 4 }, { op: 'input', id: 5, text: 'hi' }, { op: 'hover', id: 1 }]),
    ['tap 4', 'input 5 hi']);
  assert.deepEqual(replayLines([]), []);
});

test('statePreserved compares reports and treats unknown as unverifiable', () => {
  assert.equal(statePreserved({ count: 2 }, { count: 2 }), true);
  assert.equal(statePreserved({ count: 2 }, { count: 3 }), false);
  assert.equal(statePreserved(null, { count: 2 }), null);
  assert.equal(statePreserved({ count: 2 }, null), null);
});

// The binary under test is a shell state machine with the real protocol: a
// `state k=v` line after every command, `error:` lines without one.
const FAKE_NATIVE = `#!/bin/sh
count=0
while IFS= read -r line || [ -n "$line" ]; do
  set -- $line
  case "$1" in
    quit) exit 0 ;;
    state) echo "state count=$count" ;;
    tap) if [ "$2" = "4" ]; then count=$((count + 1)); fi
         if [ "$2" = "3" ]; then count=$((count - 1)); fi
         echo "state count=$count" ;;
    input) echo "state count=$count" ;;
    *) echo "error: unknown command" ;;
  esac
done
`;

test('createNativePreview drives the stdio state machine sequentially', { timeout: 10000 }, async () => {
  const base = tmpDir('native-preview-unit-');
  const binary = path.join(base, 'opurom_native');
  fs.writeFileSync(binary, FAKE_NATIVE, { mode: 0o755 });
  const logs = [];
  const preview = createNativePreview({ binary, log: (line) => logs.push(line), timeoutMs: 400 });
  try {
    assert.equal(preview.running, false);
    preview.start();
    assert.equal(preview.running, true);
    assert.ok(preview.pid > 0);
    assert.deepEqual((await preview.command('state')).state, { count: 0 });
    assert.deepEqual((await preview.command('tap 4')).state, { count: 1 });
    assert.deepEqual((await preview.command('tap 4')).state, { count: 2 });
    await assert.rejects(preview.command('bogus'), /did not answer/, 'an error-only answer never resolves a wait');
    await preview.stop();
    assert.equal(preview.running, false);
    await assert.rejects(preview.command('state'), /not running/);
  } finally {
    await preview.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

// The dev loop under a stubbed toolchain: the stub compiler produces changing
// IR (hot) or a changed state schema (full), and the stub cargo installs the
// fake binary, so no sibling repo or real cargo is needed.

function stubCompiler(modeFile) {
  return `#!/bin/sh
set -e
case "$1" in
  compile)
    n=0; [ -f "$0.count" ] && n=$(cat "$0.count"); n=$((n + 1)); echo "$n" > "$0.count"
    mode=plain; [ -f '${modeFile}' ] && mode=$(cat '${modeFile}')
    if [ "$mode" = "schema" ]; then
      printf '%s\\n' "{\\"ir\\":\\"0.1.0\\",\\"app\\":\\"Counter\\",\\"state\\":[{\\"name\\":\\"count\\",\\"type\\":\\"int\\",\\"init\\":0},{\\"name\\":\\"extra\\",\\"type\\":\\"int\\",\\"init\\":0}],\\"tree\\":{\\"id\\":$n,\\"kind\\":\\"Text\\",\\"props\\":{\\"value\\":\\"a\\"},\\"children\\":[],\\"events\\":{}},\\"theme\\":{}}" > "$4"
    else
      printf '%s\\n' "{\\"ir\\":\\"0.1.0\\",\\"app\\":\\"Counter\\",\\"state\\":[{\\"name\\":\\"count\\",\\"type\\":\\"int\\",\\"init\\":0}],\\"tree\\":{\\"id\\":$n,\\"kind\\":\\"Text\\",\\"props\\":{\\"value\\":\\"a\\"},\\"children\\":[],\\"events\\":{}},\\"theme\\":{}}" > "$4"
    fi ;;
  target) mkdir -p "$6/src"; printf '%s\\n' '[workspace]' > "$6/Cargo.toml" ;;
  *) exit 2 ;;
esac
`;
}

function stubCargo(fakeBinary) {
  return `#!/bin/sh
mkdir -p target/release
cp '${fakeBinary}' target/release/opurom_native
`;
}

function setupNativeDev() {
  const base = tmpDir('native-preview-dev-');
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  const modeFile = path.join(base, 'mode');
  const fakeBinary = path.join(base, 'fake-native');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'opuromc'), stubCompiler(modeFile), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'cargo'), stubCargo(fakeBinary), { mode: 0o755 });
  fs.writeFileSync(fakeBinary, FAKE_NATIVE, { mode: 0o755 });
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

const waitUntil = async (poll, timeoutMs = 8000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await poll();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met within the deadline');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

test('dev native preview preserves state across a hot swap and resets on full', { timeout: 30000 }, async () => {
  const env = setupNativeDev();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, targets: 'native',
      log: (line) => logs.push(String(line)),
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.native.enabled, true);
    assert.deepEqual(health.targets, ['native']);
    const snapshot = await (await fetch(`${baseUrl}/__opurom/state`)).json();
    assert.deepEqual(snapshot.state, { count: 0 }, 'the preview seeds the feed at startup');

    const tap = (id) => fetch(`${baseUrl}/__opurom/native`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'tap', id }),
    });
    assert.deepEqual((await (await tap(4)).json()).state, { count: 1 });
    assert.deepEqual((await (await tap(4)).json()).state, { count: 2 });
    const bad = await fetch(`${baseUrl}/__opurom/native`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'hover', id: 1 }),
    });
    assert.equal(bad.status, 400);

    const view = await inspectDevState({ url: baseUrl, log: (line) => lines.push(String(line)) });
    assert.equal(view, 0);
    assert.match(lines.join('\n'), /  count=2/, 'inspect --dev reads the native preview state');

    // Tree-only edit: hot decision, the event log replays into the fresh binary.
    fs.appendFileSync(env.src, '// touch\n');
    await waitUntil(async () => {
      const current = await (await fetch(`${baseUrl}/health`)).json();
      return current.native.reloads === 1 ? current : null;
    });
    const afterHot = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(afterHot.native.lastReload.kind, 'hot');
    assert.equal(afterHot.native.lastReload.preserved, true, 'replaying the log reproduces the state');
    assert.deepEqual(afterHot.native.lastReload.state, { count: 2 });

    // State-schema edit: full decision, the log is dropped and state resets.
    fs.writeFileSync(env.modeFile, 'schema\n');
    fs.appendFileSync(env.src, '// touch\n');
    await waitUntil(async () => {
      const current = await (await fetch(`${baseUrl}/health`)).json();
      return current.native.reloads === 2 ? current : null;
    });
    const afterFull = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(afterFull.native.lastReload.kind, 'full');
    assert.equal(afterFull.native.lastReload.preserved, null);
    assert.deepEqual(afterFull.native.lastReload.state, { count: 0 });
    const finalFeed = await (await fetch(`${baseUrl}/__opurom/state`)).json();
    assert.deepEqual((await (await fetch(`${baseUrl}/__opurom/state`)).json()).state, { count: 0 });
    assert.equal(finalFeed.eventCount, 2, 'the interaction log lives in the feed, not the process swap');
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('native preview is disabled outside the single-target native dev loop', { timeout: 20000 }, async () => {
  const env = setupNativeDev();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, targets: 'web-dom',
      log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.equal(health.native, undefined, 'no native state without the native target');
    const noPreview = await fetch(`${baseUrl}/__opurom/native`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'tap', id: 1 }),
    });
    assert.equal(noPreview.status, 404);
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

test('a failed build keeps the preview on the previous binary', { timeout: 30000 }, async () => {
  const env = setupNativeDev();
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, targets: 'native',
      log: (line) => buildLogs.push(String(line)),
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;
    await (await fetch(`${baseUrl}/__opurom/native`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'tap', id: 4 }),
    })).json();

    // Break the compiler: the next change fails to build and the preview must
    // keep running the previous binary with its state replayed.
    fs.writeFileSync(path.join(env.base, 'bin', 'opuromc'), '#!/bin/sh\nexit 3\n', { mode: 0o755 });
    fs.appendFileSync(env.src, '// touch\n');
    await waitUntil(() => (buildLogs.some((line) => line.includes('build failed')) ? true : null));
    const health = await (await fetch(`${baseUrl}/health`)).json();
    assert.match(health.lastError, /exit 3/);
    assert.deepEqual((await (await fetch(`${baseUrl}/__opurom/state`)).json()).state, { count: 1 },
      'the preview survives the failed build with its state');
  } finally {
    if (handle) await handle.close();
    env.restore();
  }
});

