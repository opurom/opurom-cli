// Project input discovery for incremental builds. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/build_system/dependency_graph.dart
//   (a target's input set is the transitive source closure)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (every input must be hashed, not just the entry file)
// Opurom adaptation: imports are `import "path/file.opu"` lines resolved the
// same way the compiler resolves them — relative to the importing file first,
// then project moduleRoots — with cycles and traversal reported explicitly.
// Token imports inside `theme { import "tokens.json" }` are also tracked, but
// their JSON is not compiled by the incremental decision, only hashed.

import fs from 'node:fs';
import path from 'node:path';

const OPU_IMPORT = /^\s*import\s+"([^"]+\.opu)"\s*(?:;)?\s*$/;
const TOKEN_IMPORT = /(?<![\w.])import\s+"([^"]+\.json)"/;

export class InputGraphError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputGraphError';
  }
}

function projectRootFor(main) {
  let current = path.dirname(path.resolve(main));
  for (;;) {
    const manifest = path.join(current, 'opurom.json');
    if (fs.existsSync(manifest)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.dirname(path.resolve(main));
    current = parent;
  }
}

function moduleRoots(root) {
  const manifest = path.join(root, 'opurom.json');
  const roots = [];
  if (!fs.existsSync(manifest)) return roots;
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  } catch (error) {
    throw new InputGraphError(`cannot read project manifest: ${error.message}`);
  }
  const value = doc?.moduleRoots;
  if (value === undefined) return roots;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new InputGraphError('moduleRoots must be an array of relative path strings');
  }
  for (const entry of value) {
    if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes('..')) {
      throw new InputGraphError(`moduleRoots entry '${entry}' may not be absolute or contain '..'`);
    }
    const resolved = path.resolve(root, entry);
    if (!resolved.startsWith(root)) {
      throw new InputGraphError(`moduleRoots entry '${entry}' escapes the project root`);
    }
    roots.push(resolved);
  }
  return roots;
}

function readModule(file, origin, importPath) {
  if (!fs.existsSync(file)) {
    throw new InputGraphError(`cannot read imported module '${importPath}': file not found`);
  }
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new InputGraphError(`cannot read imported module '${importPath}': ${error.message}`);
  }
}

// Resolve one import relative to the importing file, then moduleRoots.
export function resolveImportPath(importPath, origin, roots = []) {
  if (path.isAbsolute(importPath) || importPath.split(/[\\/]/).includes('..')) {
    throw new InputGraphError(`import path '${importPath}' may not be absolute or contain '..'`);
  }
  const candidates = [];
  const originDir = path.dirname(origin);
  if (fs.existsSync(originDir)) candidates.push(path.resolve(originDir, importPath));
  for (const root of roots) candidates.push(path.resolve(root, importPath));
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) {
    throw new InputGraphError(`cannot read imported module '${importPath}': file not found`);
  }
  return found;
}

// Transitive closure of .opu imports plus theme token JSON imports, starting
// from the entry file. Deterministic: imports are visited in declaration order
// and the result is sorted by absolute path. The compiler itself rejects
// import cycles; this graph is used before compilation, so a cycle is
// reported here with the same fail-closed behavior instead of silently
// dropping the file from the tracked set. BFS order makes the tracked set
// independent of visit strategy; only membership matters for hashing.
export function collectInputFiles(main, { root = null, maxFiles = 512 } = {}) {
  const entry = path.resolve(main);
  const base = root ? path.resolve(root) : projectRootFor(entry);
  const roots = moduleRoots(base);
  const queue = [entry];
  const queued = new Set(queue);
  const files = [];
  const tokenFiles = [];
  const parents = new Map();
  while (queue.length) {
    const current = queue.shift();
    queued.delete(current);
    if (files.length >= maxFiles) {
      throw new InputGraphError(`import graph exceeds ${maxFiles} files`);
    }
    files.push(current);
    const text = readModule(current, path.dirname(current), path.basename(current));
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (OPU_IMPORT.test(line)) {
        const importPath = line.match(OPU_IMPORT)[1];
        const resolved = path.resolve(resolveImportPath(importPath, current, roots));
        if (resolved === current) {
          const chain = [current, resolved].map((file) => path.relative(base, file) || '.').join(' -> ');
          throw new InputGraphError(`import cycle detected: ${chain}`);
        }
        // BFS: `current` is reached through parents.get(current); a module
        // that is still queued can be reached again through another path.
        // That is only legal when the two paths do not close a cycle, so the
        // parent chain of `current` is checked before accepting the edge.
        const chain = [];
        let cursor = current;
        while (cursor !== undefined) {
          chain.unshift(cursor);
          if (cursor === resolved) break;
          cursor = parents.get(cursor);
        }
        if (chain[0] === resolved) {
          throw new InputGraphError(`import cycle detected: ${chain.map((file) => path.relative(base, file) || '.').join(' -> ')}`);
        }
        if (queued.has(resolved) || files.includes(resolved)) continue;
        parents.set(resolved, current);
        queued.add(resolved);
        queue.push(resolved);
        continue;
      }
      const token = line.match(TOKEN_IMPORT);
      if (token) {
        const resolved = path.resolve(resolveImportPath(token[1], current, roots));
        if (!tokenFiles.includes(resolved)) tokenFiles.push(resolved);
      }
    }
  }
  return {
    entry,
    files: [...files].sort(),
    tokenFiles: [...tokenFiles].sort(),
  };
}
