// Incremental build output discovery. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923-1016
//   (per-node PerformanceMeasurement records skipped work)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (inputs and outputs both need content marks to make a stable decision)
// Opurom adaptation: observation-only output marks for emitted lower target
// artifacts and post-processing outputs. These marks never gate or mutate a
// build; they make an externally modified output visible in the next report.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const OUTPUT_MARK_FILE = '.opurom-outputcache.json';
export const OUTPUT_MARK_VERSION = 1;

// Files that describe the incremental decision/cache itself are metadata,
// not build outputs. Everything else non-hidden in the output directory is
// produced by the lower/postprocess steps and is tracked.
export function discoverOutputFiles(out, { metadata = new Set([
  '.opurom-filecache.json',
  '.opurom-outputcache.json',
]) } = {}) {
  const root = path.resolve(out);
  if (!fs.existsSync(root)) return [];
  const walk = (dir) => {
    const found = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || metadata.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...walk(full));
      else if (entry.isFile()) found.push(full);
    }
    return found;
  };
  return walk(root).sort();
}

export function readOutputMarks(markFile) {
  if (!fs.existsSync(markFile)) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(markFile, 'utf8'));
  } catch {
    return {};
  }
  if (data?.version !== OUTPUT_MARK_VERSION || data?.strategy !== 'hash'
      || !data.marks || typeof data.marks !== 'object' || Array.isArray(data.marks)) {
    return {};
  }
  return data.marks;
}

export function writeOutputMarks(markFile, outputs, { previous = {} } = {}) {
  const file = path.resolve(markFile);
  const root = path.dirname(file);
  const marks = {};
  for (const output of outputs) {
    const relative = path.relative(root, path.resolve(output)).split(path.sep).join('/');
    const absolute = path.resolve(output);
    let digest = null;
    try {
      digest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}`;
    } catch {
      // A missing output is dirty next time; keep the prior mark if present.
      if (previous[relative] !== undefined) marks[relative] = previous[relative];
    }
    if (digest) marks[relative] = digest;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({
    version: OUTPUT_MARK_VERSION, strategy: 'hash', marks,
  }, null, 2)}\n`);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return marks;
}

export function diffOutputMarks(outputs, previous, root) {
  const base = path.resolve(root);
  const changed = [];
  for (const output of outputs.map((file) => path.resolve(file))) {
    const key = path.relative(base, output).split(path.sep).join('/');
    if (previous[key] === undefined) {
      changed.push(output);
      continue;
    }
    let digest;
    try {
      digest = `sha256:${crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex')}`;
    } catch {
      changed.push(output);
      continue;
    }
    if (digest !== previous[key]) changed.push(output);
  }
  return changed.sort();
}
