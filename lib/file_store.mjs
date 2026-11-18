// Incremental build file store, adapted from Flutter FileStore.
// Flutter authority (3.50.0, flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/build_system/file_store.dart:65-83
//   (hash vs timestamp invalidation strategies)
// - file_store.dart:88-110 (cache file name .filecache and format version 2)
// - file_store.dart:111-160 (initialize deletes invalid/old-version caches;
//   persist writes current marks)
// - file_store.dart:162-230 (missing files are dirty; hash strategy uses MD5)
// Opurom adaptation: JSON cache, stable relative paths, no protobuf runtime and
// no runtime interpretation; dirty-file lists drive the CLI build decision.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const FILE_STORE_NAME = '.opurom-filecache.json';
export const FILE_STORE_VERSION = 1;
export const FILE_STORE_STRATEGIES = Object.freeze(['hash', 'timestamp']);

export function createFileStore({ cacheFile, strategy = 'hash', root = process.cwd(), log = () => {} }) {
  if (!FILE_STORE_STRATEGIES.includes(strategy)) {
    throw new Error(`invalid file store strategy: ${strategy}`);
  }
  const file = path.resolve(cacheFile);
  const base = path.resolve(root);
  let previous = {};
  let current = {};

  const initialize = () => {
    if (!fs.existsSync(file)) return;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      log('file store: invalid cache cleared');
      fs.rmSync(file, { force: true });
      return;
    }
    if (data?.version !== FILE_STORE_VERSION || data?.strategy !== strategy
        || !data.marks || typeof data.marks !== 'object' || Array.isArray(data.marks)) {
      log('file store: format changed, clearing old marks');
      fs.rmSync(file, { force: true });
      return;
    }
    previous = data.marks;
  };

  const keyFor = (filePath) => path.relative(base, path.resolve(filePath)).split(path.sep).join('/');

  const markFor = (filePath) => {
    const absolute = path.resolve(filePath);
    if (!fs.existsSync(absolute)) return null;
    if (strategy === 'timestamp') return `mtime:${fs.statSync(absolute).mtimeMs}`;
    return `md5:${crypto.createHash('md5').update(fs.readFileSync(absolute)).digest('hex')}`;
  };

  return {
    get size() { return Object.keys(previous).length; },
    get strategy() { return strategy; },
    get file() { return file; },
    initialize,
    diff(files = []) {
      const dirty = [];
      for (const candidate of files) {
        const key = keyFor(candidate);
        const mark = markFor(candidate);
        if (mark === null) {
          delete previous[key];
          delete current[key];
          dirty.push(path.resolve(candidate));
          continue;
        }
        current[key] = mark;
        if (previous[key] !== mark) dirty.push(path.resolve(candidate));
      }
      return dirty;
    },
    persist() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify({
        version: FILE_STORE_VERSION,
        strategy,
        marks: current,
      }, null, 2)}\n`);
    },
    persistIncremental() {
      previous = { ...current };
      current = {};
    },
  };
}
