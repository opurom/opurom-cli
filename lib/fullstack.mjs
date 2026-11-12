import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, findInPath } from './paths.mjs';
import { run } from './proc.mjs';

export const FULL_ARTIFACTS = Object.freeze([
  'web', 'native', 'server', 'migrations', 'shared/types.json', 'app.opuir.json',
]);

// The IR `models` array is the only type source; no second schema is invented.
export function typesFromIr(ir) {
  return {
    ir: ir?.ir ?? '0.1',
    app: ir?.app ?? null,
    models: Array.isArray(ir?.models) ? ir.models : [],
    api: Array.isArray(ir?.api) ? ir.api : [],
  };
}

export function isFullStackIr(ir) {
  return Array.isArray(ir?.models) && ir.models.length > 0
    && Array.isArray(ir?.api) && ir.api.length > 0;
}

export function writeSharedTypes(ir, out) {
  const file = path.join(path.resolve(out), 'shared', 'types.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(typesFromIr(ir), null, 2)}\n`);
  return file;
}

// One command: compile -> frontend (web + native) -> server crate -> SQL migrations.
export function planFullBuild({ src = null, ir, out, root, opuromc, serverc, migrate, optimize = false, optimizedIr = null }) {
  const outAbs = path.resolve(out);
  const rootAbs = path.resolve(root);
  const irAbs = path.resolve(ir);
  const emitIr = path.resolve(optimize ? (optimizedIr ?? `${ir}.optimized.json`) : ir);
  const steps = [];
  if (src) steps.push({ label: 'compile', cmd: opuromc, args: ['compile', path.resolve(src), '-o', irAbs] });
  if (optimize) steps.push({ label: 'optimize', cmd: opuromc, args: ['optimize', irAbs, '-o', emitIr] });
  for (const target of ['web', 'native']) {
    steps.push({
      label: `frontend-${target}`,
      cmd: opuromc,
      args: ['target', emitIr, '--target', target, '-o', path.join(outAbs, target)],
    });
  }
  steps.push({
    label: 'server',
    cmd: serverc,
    args: [emitIr, '-o', path.join(outAbs, 'server'), '--dep-root', rootAbs],
    cwd: rootAbs,
  });
  steps.push({
    label: 'migrations',
    cmd: migrate,
    args: [emitIr, '-o', outAbs],
    cwd: rootAbs,
  });
  return steps;
}

export function assertFullArtifacts(out) {
  const outAbs = path.resolve(out);
  const required = [
    'web/index.html', 'native/Cargo.toml', 'server/Cargo.toml',
    'migrations', 'shared/types.json', 'app.opuir.json',
  ];
  const missing = required.filter((name) => !fs.existsSync(path.join(outAbs, name)));
  if (missing.length) throw new Error(`full build incomplete; missing ${missing.join(', ')} in ${outAbs}`);
}

// The generated crate embeds its SQL with include_str!; make sure the files
// it points at sit next to the crate, whichever way the generator lays them out.
export function syncMigrationFiles(out) {
  const outAbs = path.resolve(out);
  const source = path.join(outAbs, 'migrations');
  const targets = [path.join(outAbs, 'server', 'migrations'), source];
  if (!fs.existsSync(source)) return [];
  const files = fs.readdirSync(source).filter((f) => f.endsWith('.sql'));
  if (!files.length) return [];
  for (const target of targets) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of files) fs.copyFileSync(path.join(source, file), path.join(target, file));
  }
  return files;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function summarizeArtifacts(entries) {
  if (!entries.length) return '  (no artifacts)';
  return entries.map((entry) => {
    const noun = entry.files === 1 ? 'file' : 'files';
    return `  ${entry.name}: ${entry.files} ${noun}, ${formatBytes(entry.bytes)}`;
  }).join('\n');
}

export function directoryStats(dir, { skip = new Set(['target', '.DS_Store']) } = {}) {
  let files = 0;
  let bytes = 0;
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const file = path.join(current, entry.name);
      if (entry.isFile()) {
        files++;
        bytes += fs.statSync(file).size;
      } else if (entry.isDirectory()) {
        walk(file);
      }
    }
  };
  walk(path.resolve(dir));
  return { files, bytes };
}

export function collectArtifacts(out, names = FULL_ARTIFACTS) {
  const root = path.resolve(out);
  return names.flatMap((name) => {
    const file = path.resolve(root, name);
    if (file !== root && !file.startsWith(`${root}${path.sep}`)) {
      throw new Error(`artifact path escapes output directory: ${name}`);
    }
    let stats;
    try {
      stats = fs.statSync(file);
    } catch {
      return [];
    }
    if (stats.isFile()) return [{ name, files: 1, bytes: stats.size }];
    if (stats.isDirectory()) return [{ name, ...directoryStats(file) }];
    return [];
  });
}

export function removeTempDir(dir) {
  const abs = path.resolve(dir);
  const tmp = path.resolve(CLI_ROOT, 'tmp');
  if (abs === tmp || !abs.startsWith(`${tmp}${path.sep}`)) {
    throw new Error(`refusing to remove non-temp path: ${abs}`);
  }
  fs.rmSync(abs, { recursive: true, force: true });
  return abs;
}

export function compilerSupportsTarget(opuromc, target) {
  const result = run(opuromc, ['targets']);
  if (result.status !== 0) return false;
  return `${result.stdout}${result.stderr}`.split(/\r?\n/)
    .some((line) => line.trim().split(/\s+/)[0] === target);
}

export function wasmTargetInstalled() {
  const rustc = findInPath('rustc');
  if (!rustc) return false;
  const result = run(rustc, ['--print', 'target-libdir', '--target', 'wasm32-unknown-unknown']);
  const dir = result.stdout.trim();
  return result.status === 0 && Boolean(dir) && fs.existsSync(dir);
}

export function findWasmFile(out) {
  const found = new Set();
  const walk = (dir, depth = 0) => {
    if (depth > 5) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.wasm')) found.add(file);
      else if (entry.isDirectory()) walk(file, depth + 1);
    }
  };
  walk(path.join(path.resolve(out), 'target'));
  return [...found].sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] ?? null;
}

// The wasm ABI exposes int states; pick the node whose tap action increments one.
export function wasmTapNodeId(ir) {
  let found = null;
  const walk = (node) => {
    if (found !== null || !node || typeof node !== 'object') return;
    const tap = node.events?.tap;
    const actions = Array.isArray(tap?.actions) ? tap.actions : [tap];
    if (actions.some((action) => action?.op === 'add' && Number(action.value) > 0)) {
      found = node.id;
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(ir?.tree);
  return found;
}
