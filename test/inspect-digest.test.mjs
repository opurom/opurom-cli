import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { dev } from '../lib/dev.mjs';
import { diffTrees, digestJson, formatDigestText, readBaseline, renderDigest } from '../lib/inspect_digest.mjs';
import { inspectDevDigest } from '../lib/inspect_dev.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

// A renderer stub that prints a fixed `digest=` line (the real renderer hashes
// its RGBA buffer; the stub only needs deterministic output for the CLI path).
function writeRenderer(base, digest) {
  const file = path.join(base, 'opurom-render');
  // The digest derives from the IR file size so a different tree yields a
  // different value, mimicking the real renderer's content-dependent hash.
  fs.writeFileSync(file, `#!/bin/sh\nsz=$(wc -c < "$1" | tr -d ' ')\nprintf 'digest=${digest}%s\\ndirty=0\\n' "$sz"\n`, { mode: 0o755 });
  return file;
}

// Compiler stub with two interchangeable IR shapes so a test can represent
// the live app, and a separate mode file picks which tree it emits.
function writeCompiler(base) {
  const file = path.join(base, 'opuromc');
  const body = `#!/bin/sh
set -e
mode=plain
[ -f '${path.join(base, 'mode')}' ] && mode=$(cat '${path.join(base, 'mode')}')
case "$1" in
  compile)
    case "$mode" in
      plain) json='{"ir":"0.1.0","app":"Counter","tree":{"id":1,"kind":"Column","children":[{"id":2,"kind":"Text","props":{"key":"a"},"children":[]},{"id":3,"kind":"Button","props":{},"children":[]}]},"theme":{}}' ;;
      added) json='{"ir":"0.1.0","app":"Counter","tree":{"id":1,"kind":"Column","children":[{"id":2,"kind":"Text","props":{"key":"a"},"children":[]},{"id":3,"kind":"Button","props":{},"children":[]},{"id":4,"kind":"Image","props":{},"children":[]}]},"theme":{}}' ;;
      removed) json='{"ir":"0.1.0","app":"Counter","tree":{"id":1,"kind":"Column","children":[{"id":2,"kind":"Text","props":{"key":"a"},"children":[]}]},"theme":{}}' ;;
      changed) json='{"ir":"0.1.0","app":"Counter","tree":{"id":1,"kind":"Column","children":[{"id":2,"kind":"Text","props":{"key":"a"},"children":[]},{"id":3,"kind":"Row","props":{},"children":[]}]},"theme":{}}' ;;
      *) exit 2 ;;
    esac
    printf '%s\\n' "$json" > "$4" ;;
  target) mkdir -p "$6"; cp "$2" "$6/ir.json";
    printf '%s\\n' '<!DOCTYPE html><html><body><main id="app"></main></body></html>' > "$6/index.html" ;;
  *) exit 2 ;;
esac
`;
  fs.writeFileSync(file, body, { mode: 0o755 });
  return { file, modePath: path.join(base, 'mode') };
}

function setup(name) {
  const base = tmpDir(name);
  const bin = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  fs.mkdirSync(bin);
  writeCompiler(bin);
  writeRenderer(bin, 'aaaabbbbccccdddd');
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath ?? ''}`;
  return {
    base, bin, src,
    setMode: (mode) => fs.writeFileSync(path.join(bin, 'mode'), mode),
    restore: () => {
      process.env.PATH = oldPath;
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// Build a root with the golden fixture so readBaseline finds it; the counter
// IR equals the "plain" live shape so a plain app diffs clean against it.
function rootWithGolden() {
  const root = tmpDir('inspect-digest-root-');
  const golden = path.join(root, 'opurom-examples', 'golden');
  fs.mkdirSync(golden, { recursive: true });
  fs.writeFileSync(path.join(golden, 'counter.opuir.json'), JSON.stringify({
    ir: '0.1.0', app: 'Counter',
    tree: { id: 1, kind: 'Column', children: [
      { id: 2, kind: 'Text', props: { key: 'a' }, children: [] },
      { id: 3, kind: 'Button', props: {}, children: [] },
    ] },
    theme: {},
  }));
  return root;
}

test('diffTrees reports added, removed and changed nodes by id', () => {
  const base = { tree: { id: 1, kind: 'Column', children: [
    { id: 2, kind: 'Text', props: { key: 'a' }, children: [] },
    { id: 3, kind: 'Button', props: {}, children: [] },
  ] } };
  const added = diffTrees(base, { tree: { id: 1, kind: 'Column', children: [
    { id: 2, kind: 'Text', props: { key: 'a' }, children: [] },
    { id: 3, kind: 'Button', props: {}, children: [] },
    { id: 4, kind: 'Image', props: {}, children: [] },
  ] } });
  assert.deepEqual(added.added.map((n) => n.id), [4]);
  assert.deepEqual(added.removed, []);
  assert.deepEqual(added.changed, []);

  const removed = diffTrees(base, { tree: { id: 1, kind: 'Column', children: [
    { id: 2, kind: 'Text', props: { key: 'a' }, children: [] },
  ] } });
  assert.deepEqual(removed.removed.map((n) => n.id), [3]);

  const changed = diffTrees(base, { tree: { id: 1, kind: 'Column', children: [
    { id: 2, kind: 'Text', props: { key: 'a' }, children: [] },
    { id: 3, kind: 'Row', props: {}, children: [] },
  ] } });
  assert.deepEqual(changed.changed.map((n) => n.id), [3]);
  assert.deepEqual(changed.changed[0].fields, ['kind Button->Row']);
});

test('renderDigest takes the renderer digest line, and missing baseline degrades', () => {
  const base = tmpDir('inspect-digest-unit-');
  try {
    const renderer = writeRenderer(base, '0123456789abcdef');
    const irFile = path.join(base, 'app.opuir.json');
    fs.writeFileSync(irFile, '{}');
    assert.match(renderDigest(renderer, irFile, base).digest, /^0123456789abcdef\d+$/);
    // No golden fixture in this base: baseline is missing, text says so and
    // JSON carries no diff.
    const missing = readBaseline(base, renderer);
    assert.equal(missing.missing, true);
    const text = formatDigestText({ liveDigest: 'x', baseline: missing, diff: null });
    assert.match(text, /baseline: unavailable .* live digest only, no diff/);
    const json = digestJson({ liveDigest: 'x', baseline: missing, diff: null });
    assert.equal(json.baseline.digest, null);
    assert.equal(json.baseline.missing, true);
    assert.equal(json.diff, null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('inspect --dev --digest reports match and the three diff kinds', { timeout: 20000 }, async () => {
  const env = setup('inspect-digest-live-');
  const root = rootWithGolden();
  const golden = path.join(root, 'opurom-examples', 'golden', 'counter.opuir.json');
  let handle;
  try {
    handle = await dev({
      src: env.src, port: 0, root: env.base, signals: false, backend: false, log: () => {},
    });
    const baseUrl = `http://127.0.0.1:${handle.server.address().port}`;

    // Plain live shape == golden IR: match, no node diff.
    const plain = await inspectDevDigest({ url: baseUrl, root, renderer: path.join(env.bin, 'opurom-render'), json: true, log: (l) => logs.push(String(l)) });
    assert.equal(plain, 0);
    const plainJson = lastJson();
    assert.equal(plainJson.mode, 'digest');
    assert.equal(plainJson.baseline.match, true);
    assert.deepEqual(plainJson.diff, { added: [], removed: [], changed: [] });

    for (const [mode, pick] of [['added', (d) => d.added], ['removed', (d) => d.removed], ['changed', (d) => d.changed]]) {
      env.setMode(mode);
      // A source touch forces a rebuild that emits the new IR shape.
      fs.appendFileSync(env.src, `\n// ${mode}\n`);
      await waitForIr(baseUrl, mode);
      const lines = [];
      await inspectDevDigest({ url: baseUrl, root, renderer: path.join(env.bin, 'opurom-render'), json: true, log: (l) => lines.push(String(l)) });
      const view = JSON.parse(lines.join('\n'));
      assert.equal(view.baseline.match, false, `${mode}: digest differs`);
      assert.equal(pick(view.diff).length, 1, `${mode}: one node`);
    }
  } finally {
    if (handle) await handle.close();
    env.restore();
    fs.rmSync(root, { recursive: true, force: true });
  }

  function lastJson() {
    const lines = logs.splice(0, logs.length);
    return JSON.parse(lines.join('\n'));
  }
});

// The compiler stub swaps IR by mode file; poll the IR endpoint until the
// live IR reflects that mode's shape, so the assertion is not racing a rebuild.
async function waitForIr(baseUrl, mode) {
  const want = { added: 4, removed: 3, changed: 'Row' }[mode];
  for (let i = 0; i < 40; i += 1) {
    const ir = (await (await fetch(`${baseUrl}/__opurom/ir`)).json()).ir;
    const kids = ir.tree.children.map((c) => c.id);
    const kinds = ir.tree.children.map((c) => c.kind);
    if (mode === 'added' && kids.includes(4)) return;
    if (mode === 'removed' && !kids.includes(3)) return;
    if (mode === 'changed' && kinds.includes('Row')) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`live IR did not reach mode ${mode} (want ${want})`);
}

const logs = [];

test('CLI gates --digest flags and reports a clear unreachable error', () => {
  const both = run(process.execPath, [CLI, 'inspect', '--dev', 'http://127.0.0.1:1', '--tree', '--digest'], { timeout: 20000 });
  assert.equal(both.status, 1);
  assert.match(both.stderr, /takes --tree or --digest, not both/);
  const bad = run(process.execPath, [CLI, 'inspect', '--dev', '--digest', '--select', '1'], { timeout: 20000 });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--digest takes only --json/);
  const unreachable = run(process.execPath, [CLI, 'inspect', '--dev', 'http://127.0.0.1:1', '--digest'], { timeout: 20000 });
  assert.equal(unreachable.status, 1);
  assert.match(unreachable.stderr, /dev server not reachable at http:\/\/127\.0\.0\.1:1/);
  const help = run(process.execPath, [CLI, '--help'], { timeout: 20000 });
  assert.match(help.stdout, /inspect --dev \[<url>\] \[--tree\|--digest\]/);
  assert.match(help.stdout, /--digest for the golden digest \+ node diff/);
});
