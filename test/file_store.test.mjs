// Incremental file store tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/file_store.dart:65-83,88-110,111-160,162-230
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { createFileStore, FILE_STORE_NAME, FILE_STORE_VERSION } from '../lib/file_store.mjs';

const CLI = path.resolve(fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url)));

function writeValidCache(cache, { strategy = 'hash', marks = {} } = {}) {
  fs.writeFileSync(cache, `${JSON.stringify({ version: FILE_STORE_VERSION, strategy, marks }, null, 2)}\n`);
}

test('hash store marks first build dirty and second build clean', () => {
  const base = tmpDir('file-store-');
  try {
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Demo\n');
    const cache = path.join(base, FILE_STORE_NAME);
    const store = createFileStore({ cacheFile: cache, root: base, strategy: 'hash' });
    store.initialize();
    assert.equal(store.size, 0);
    assert.deepEqual(store.diff([src]), [src]);
    store.persist();

    const next = createFileStore({ cacheFile: cache, root: base, strategy: 'hash' });
    next.initialize();
    assert.equal(next.size, 1);
    assert.deepEqual(next.diff([src]), []);

    fs.writeFileSync(src, 'app Demo { state count = 0 }\n');
    assert.deepEqual(next.diff([src]), [src]);
    fs.rmSync(src);
    assert.deepEqual(next.diff([src]), [src]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('timestamp strategy uses mtime and rejects invalid caches', () => {
  const base = tmpDir('file-store-ts-');
  try {
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Demo\n');
    const cache = path.join(base, FILE_STORE_NAME);
    const store = createFileStore({ cacheFile: cache, root: base, strategy: 'timestamp' });
    store.initialize();
    assert.deepEqual(store.diff([src]), [src]);
    store.persist();
    const parsed = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(parsed.version, FILE_STORE_VERSION);
    assert.equal(parsed.strategy, 'timestamp');

    fs.writeFileSync(cache, '{broken');
    const logs = [];
    const recovered = createFileStore({ cacheFile: cache, root: base, strategy: 'timestamp', log: (line) => logs.push(line) });
    recovered.initialize();
    assert.equal(recovered.size, 0);
    assert.match(logs.join('\n'), /invalid cache cleared/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('incremental build writes the file store without changing artifacts', () => {
  const base = tmpDir('file-store-build-');
  try {
    const out = path.join(base, 'out');
    const source = path.resolve('../opurom-examples/golden/counter.opu');
    const result = run(process.execPath, [
      CLI, 'build', '--src', source, '--target', 'web-dom', '--out', out, '--incremental',
    ], { timeout: 120000 });
    assert.equal(result.status, 0, result.stderr);
    const cache = path.join(out, FILE_STORE_NAME);
    assert.ok(fs.existsSync(cache));
    const data = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(data.version, FILE_STORE_VERSION);
    assert.deepEqual(Object.keys(data.marks), ['counter.opu']);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('version and strategy transitions clear the prior cache', () => {
  const base = tmpDir('file-store-lifecycle-');
  try {
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Demo { Column { Text("lifecycle") } }\n');
    const cache = path.join(base, FILE_STORE_NAME);

    fs.writeFileSync(cache, `${JSON.stringify({
      version: FILE_STORE_VERSION + 1, strategy: 'hash', marks: { 'main.opu': 'md5:stale' },
    }, null, 2)}\n`);
    const oldVersion = createFileStore({ cacheFile: cache, root: base, strategy: 'hash' });
    oldVersion.initialize();
    assert.equal(oldVersion.size, 0);
    assert.deepEqual(oldVersion.diff([src]), [src]);
    oldVersion.persist();
    assert.equal(JSON.parse(fs.readFileSync(cache, 'utf8')).version, FILE_STORE_VERSION);

    writeValidCache(cache, { strategy: 'hash', marks: { 'main.opu': 'md5:stale' } });
    const switched = createFileStore({ cacheFile: cache, root: base, strategy: 'timestamp' });
    switched.initialize();
    assert.equal(switched.size, 0);
    assert.deepEqual(switched.diff([src]), [src]);
    switched.persist();
    const persisted = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(persisted.version, FILE_STORE_VERSION);
    assert.equal(persisted.strategy, 'timestamp');
    assert.match(Object.values(persisted.marks)[0], /^mtime:/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('missing source is reported dirty without poisoning later valid marks', () => {
  const base = tmpDir('file-store-missing-');
  try {
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Demo { Column { Text("missing") } }\n');
    const cache = path.join(base, FILE_STORE_NAME);
    const store = createFileStore({ cacheFile: cache, root: base });
    store.initialize();
    assert.deepEqual(store.diff([src]), [src]);
    store.persist();

    fs.rmSync(src);
    assert.deepEqual(store.diff([src]), [src]);
    store.persist();
    const afterMissing = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.deepEqual(afterMissing.marks, {});

    fs.writeFileSync(src, 'app Demo { Column { Text("restored") } }\n');
    const restored = createFileStore({ cacheFile: cache, root: base });
    restored.initialize();
    assert.equal(restored.size, 0);
    assert.deepEqual(restored.diff([src]), [src]);
    restored.persist();
    const final = createFileStore({ cacheFile: cache, root: base });
    final.initialize();
    assert.deepEqual(final.diff([src]), []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('cache persist replaces the file atomically and preserves valid content', () => {
  const base = tmpDir('file-store-atomic-');
  try {
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Demo { Column { Text("atomic") } }\n');
    const cache = path.join(base, FILE_STORE_NAME);
    const previous = `${JSON.stringify({ version: FILE_STORE_VERSION, strategy: 'hash', marks: {} }, null, 2)}\n`;
    fs.writeFileSync(cache, previous);
    const store = createFileStore({ cacheFile: cache, root: base });
    store.initialize();
    store.diff([src]);

    const originalRename = fs.renameSync;
    const attempted = [];
    fs.renameSync = (from, to) => {
      attempted.push({ from, to });
      assert.equal(fs.readFileSync(to, 'utf8'), previous, 'old cache must remain intact until rename');
      const temp = `${from}.moved`;
      originalRename(from, temp);
      throw new Error('simulated rename failure');
    };
    let failure = null;
    try { store.persist(); } catch (error) { failure = error; }
    finally { fs.renameSync = originalRename; }

    assert.match(failure?.message ?? '', /simulated rename failure/);
    assert.equal(fs.readFileSync(cache, 'utf8'), previous, 'failed persist keeps the old cache');
    assert.equal(attempted.length, 1);
    assert.equal(fs.readdirSync(base).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.equal(fs.existsSync(`${attempted[0].from}.moved`), true);

    store.persist();
    const persisted = JSON.parse(fs.readFileSync(cache, 'utf8'));
    assert.equal(persisted.version, FILE_STORE_VERSION);
    assert.equal(persisted.strategy, 'hash');
    assert.equal(Object.keys(persisted.marks).length, 1);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('incremental build cache survives missing and restored sources without skipping work', () => {
  const base = tmpDir('file-store-build-lifecycle-');
  try {
    const src = path.join(base, 'main.opu');
    const program = (label) => `app Demo {\n  Column(gap: 8) {\n    Text("${label}")\n  }\n}\n`;
    fs.writeFileSync(src, program('a'));
    const out = path.join(base, 'out');
    const args = [
      CLI, 'build', '--src', src, '--target', 'web-dom', '--out', out, '--incremental',
    ];
    const build = () => {
      const result = run(process.execPath, args, { timeout: 120000 });
      assert.equal(result.status, 0, result.stderr);
    };
    build();
    const decisionFile = path.join(out, '.opurom-incremental', 'latest.json');
    const cleanBuild = () => {
      const result = run(process.execPath, args, { timeout: 120000 });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
      assert.deepEqual(report.dirty, []);
      assert.equal(report.enforcement, 'none');
      assert.deepEqual(report.skipped, report.steps.map((row) => row.step));
      assert.ok(report.steps.every((row) => row.executed));
    };
    cleanBuild();

    fs.rmSync(src);
    const missing = run(process.execPath, args, { timeout: 120000 });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr ?? '', /source not found/);
    fs.writeFileSync(src, program('a'));
    cleanBuild();
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
