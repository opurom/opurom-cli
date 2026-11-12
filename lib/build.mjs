import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, ensureSiblingBinary, findInPath, workspaceRoot } from './paths.mjs';
import { runOrThrow } from './proc.mjs';
import { validateTarget } from './targets.mjs';
import {
  assertFullArtifacts, collectArtifacts, compilerSupportsTarget, isFullStackIr,
  planFullBuild, summarizeArtifacts, syncMigrationFiles, typesFromIr, wasmTargetInstalled, writeSharedTypes,
} from './fullstack.mjs';

// Pure orchestration plan; unit-tested without any sibling repo present.
export function planBuild({ src, target, out, ir, opuromc, cargo }) {
  const steps = [
    { label: 'compile', cmd: opuromc, args: ['compile', src, '-o', ir] },
    { label: 'lower', cmd: opuromc, args: ['target', ir, '--target', target, '-o', out] },
  ];
  if (target === 'native') {
    steps.push({ label: 'cargo', cmd: cargo, args: ['build', '--release'], cwd: out });
  }
  return steps;
}

export function compilerPath({ root = workspaceRoot(), log = console.log } = {}) {
  const found = ensureSiblingBinary('opurom-lang', ['opuromc'], { root, log });
  if (!found.path) throw new Error(`opuromc unavailable: ${found.reason}`);
  return found.path;
}

// Sibling backend tools; a missing repo is a hard error (no silent success).
export function backendTools({ root = workspaceRoot(), log = console.log } = {}) {
  const server = ensureSiblingBinary('opurom-server', ['opurom-serverc', 'opurom_serverc'], { root, log });
  if (!server.path) throw new Error(`opurom-serverc unavailable: ${server.reason}`);
  const migrate = ensureSiblingBinary('opurom-db', ['opurom-migrate', 'opurom_migrate'], { root, log });
  if (!migrate.path) throw new Error(`opurom-migrate unavailable: ${migrate.reason}`);
  return { serverc: server.path, migrate: migrate.path };
}

// Only the migration generator is needed for SQL; the service generator is not.
export function migrateTool({ root = workspaceRoot(), log = console.log } = {}) {
  const migrate = ensureSiblingBinary('opurom-db', ['opurom-migrate', 'opurom_migrate'], { root, log });
  if (!migrate.path) throw new Error(`opurom-migrate unavailable: ${migrate.reason}`);
  return migrate.path;
}

export function check(src, { root = workspaceRoot() } = {}) {
  const file = path.resolve(src);
  if (!fs.existsSync(file)) throw new Error(`source not found: ${file}`);
  const opuromc = compilerPath({ root });
  return runOrThrow(opuromc, ['check', file], { inherit: true });
}

export function build({ src, target, out, root = workspaceRoot(), quiet = false, log = console.log }) {
  validateTarget(target);
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });

  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  const cargo = findInPath('cargo');
  if (target === 'native' && !cargo) {
    throw new Error('cargo not found: install Rust via https://rustup.rs');
  }

  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'ir-'));
  try {
    const ir = path.join(tmp, 'app.opuir.json');
    for (const step of planBuild({ src: srcAbs, target, out: outAbs, ir, opuromc, cargo })) {
      runOrThrow(step.cmd, step.args, { cwd: step.cwd });
    }
    const files = fs.readdirSync(outAbs).filter((f) => !f.startsWith('.'));
    if (!quiet) {
      const shown = files.slice(0, 6).join(', ');
      log(`build ok: ${srcAbs} [${target}] -> ${outAbs} (${files.length} entries: ${shown}${files.length > 6 ? ', ...' : ''})`);
    }
    return { src: srcAbs, target, out: outAbs, ir, files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function readIrFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid IR JSON in ${file}: ${error.message}`);
  }
}

// One command for the whole chain: frontend + generated service + SQL migrations
// + the shared type file derived from the IR models.
export function buildFull({ src, out, root = workspaceRoot(), quiet = false, log = console.log }) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });

  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  const { serverc, migrate } = backendTools({ root, log: quiet ? () => {} : log });
  const irFile = path.join(outAbs, 'app.opuir.json');

  for (const step of planFullBuild({ src: srcAbs, ir: irFile, out: outAbs, root, opuromc, serverc, migrate })) {
    runOrThrow(step.cmd, step.args, { cwd: step.cwd });
  }

  const ir = readIrFile(irFile);
  writeSharedTypes(ir, outAbs);
  syncMigrationFiles(outAbs);
  assertFullArtifacts(outAbs);

  const artifacts = collectArtifacts(outAbs);
  if (!quiet) {
    log(`build ok: ${srcAbs} [full] -> ${outAbs}`);
    log(`  app=${ir.app ?? '?'} models=${typesFromIr(ir).models.length} api=${typesFromIr(ir).api.length}`);
    log(summarizeArtifacts(artifacts));
    if (!isFullStackIr(ir)) log('  note: IR has no models/api: the service exposes /health and /ssr only');
  }
  return { src: srcAbs, out: outAbs, ir: irFile, artifacts, app: ir.app };
}

export function migrate({ src, out, root = workspaceRoot(), quiet = false, log = console.log }) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  const migrateBin = migrateTool({ root, log: quiet ? () => {} : log });

  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'migrate-'));
  try {
    const ir = path.join(tmp, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', ir]);
    runOrThrow(migrateBin, [ir, '-o', outAbs]);
    const dir = path.join(outAbs, 'migrations');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort() : [];
    if (!quiet) {
      log(`migrate ok: ${srcAbs} -> ${dir}`);
      for (const file of files) log(`  ${path.join(dir, file)}`);
      if (!files.length) log('  (no models in IR: no migration files)');
    }
    return { src: srcAbs, out: outAbs, files };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// wasm32 emitter: generate the crate, then build it for wasm32-unknown-unknown.
export function buildWasm({ src, out, root = workspaceRoot(), quiet = false, log = console.log }) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  if (!compilerSupportsTarget(opuromc, 'wasm')) {
    throw new Error('this opuromc has no wasm target: rebuild opurom-lang (R2 adds the wasm emitter)');
  }
  const cargo = findInPath('cargo');
  if (!cargo) throw new Error('cargo not found: install Rust via https://rustup.rs');
  if (!wasmTargetInstalled()) {
    throw new Error('rust target wasm32-unknown-unknown is not installed: rustup target add wasm32-unknown-unknown');
  }
  const irFile = path.join(outAbs, 'app.opuir.json');
  runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
  runOrThrow(opuromc, ['target', irFile, '--target', 'wasm', '-o', outAbs]);
  runOrThrow(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: outAbs });
  if (!quiet) {
    const wasm = path.join(outAbs, 'target', 'wasm32-unknown-unknown', 'release');
    log(`build ok: ${srcAbs} [wasm] -> ${outAbs}`);
    log(`  wasm: ${fs.existsSync(wasm) ? fs.readdirSync(wasm).filter((f) => f.endsWith('.wasm')).join(', ') || '(none)' : '(none)'}`);
  }
  return { src: srcAbs, out: outAbs, ir: irFile };
}
