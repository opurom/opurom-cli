// Incremental file store tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/file_store.dart:65-83,88-110,111-160,162-230
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { createFileStore, FILE_STORE_NAME, FILE_STORE_VERSION } from '../lib/file_store.mjs';

const CLI = path.resolve(fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url)));
import { fileURLToPath } from 'node:url';

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
