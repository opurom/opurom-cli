import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, ensureSiblingBinary, findInPath, workspaceRoot } from './paths.mjs';
import { run, runOrThrow } from './proc.mjs';
import { validateTarget } from './targets.mjs';
import {
  assertFullArtifacts, collectArtifacts, compilerSupportsTarget, isFullStackIr,
  planFullBuild, summarizeArtifacts, syncMigrationFiles, typesFromIr, wasmTargetInstalled, writeSharedTypes,
  verifyArtifactManifest, writeArtifactManifest,
} from './fullstack.mjs';
import { finalizeBuild, finalizeMinifiedBuild } from './minify.mjs';
import { ANALYZE_TRANSFORMS } from './optimize.mjs';

// Pure orchestration plan; unit-tested without any sibling repo present.
export function planBuild({ src, target, out, ir, optimizedIr = null, optimize = false, opuromc, cargo }) {
  const emitIr = optimize ? (optimizedIr ?? `${ir}.optimized.json`) : ir;
  const steps = [
    { label: 'compile', cmd: opuromc, args: ['compile', src, '-o', ir] },
  ];
  if (optimize) {
    steps.push({ label: 'optimize', cmd: opuromc, args: ['optimize', ir, '-o', emitIr] });
  }
  steps.push({ label: 'lower', cmd: opuromc, args: ['target', emitIr, '--target', target, '-o', out] });
  if (target === 'native') {
    steps.push({ label: 'cargo', cmd: cargo, args: ['build', '--release'], cwd: out });
  }
  return steps;
}

export function formatMeasuredBytes(inputBytes, outputBytes) {
  return `optimizer: input=${inputBytes} B, output=${outputBytes} B (measured from files)`;
}

function postProcessBuild({ out, target, opuromc, minify, treeShake, sourcemap, log }) {
  if (!minify && !treeShake && !sourcemap) return null;
  if (minify && !treeShake && !sourcemap) {
    return finalizeMinifiedBuild({ out, target, opuromc, log });
  }
  return finalizeBuild({
    out, target, opuromc, minify, treeShake, sourcemap, transforms: ANALYZE_TRANSFORMS, log,
  });
}

function buildFlagsTag({ minify, treeShake, sourcemap }) {
  const names = [minify && 'minify', treeShake && 'tree-shake', sourcemap && 'sourcemap'].filter(Boolean);
  return names.length ? ` [${names.join('+')}=applied]` : '';
}

function firstLine(text) {
  return String(text ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

export function optimizeIrFile({ opuromc, input, output, log = console.log }) {
  if (path.resolve(input) === path.resolve(output)) {
    throw new Error('optimizer input and output IR paths must differ');
  }
  if (!fs.existsSync(input)) throw new Error(`optimizer input IR not found: ${input}`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.rmSync(output, { force: true });
  let result;
  try {
    result = run(opuromc, ['optimize', input, '-o', output]);
  } catch (error) {
    result = { status: 1, stdout: '', stderr: error.message };
  }
  const detail = firstLine(`${result.stdout}${result.stderr}`);
  const produced = result.status === 0 && fs.existsSync(output) && fs.statSync(output).size > 0;
  if (!produced) {
    const reason = `exit ${result.status}: ${detail || 'no optimized IR file'}`;
    fs.copyFileSync(input, output);
    log(`build: opuromc optimize unavailable or failed (${reason}); using original IR (NOT optimized)`);
  }
  const inputBytes = fs.statSync(input).size;
  const outputBytes = fs.statSync(output).size;
  log(formatMeasuredBytes(inputBytes, outputBytes));
  return {
    applied: produced,
    inputBytes,
    outputBytes,
    reason: produced ? null : `exit ${result.status}: ${detail || 'no optimized IR file'}`,
  };
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

export function build({
  src, target, out, root = workspaceRoot(), quiet = false, log = console.log,
  optimize = false, minify = false, treeShake = false, sourcemap = false,
}) {
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
    const sourceIr = path.join(tmp, optimize ? 'source.opuir.json' : 'app.opuir.json');
    const optimizedIr = optimize ? path.join(tmp, 'app.opuir.json') : null;
    let optimization = null;
    for (const step of planBuild({
      src: srcAbs, target, out: outAbs, ir: sourceIr, optimizedIr, optimize, opuromc, cargo,
    })) {
      if (step.label === 'optimize') {
        optimization = optimizeIrFile({ opuromc, input: sourceIr, output: optimizedIr, log });
      } else {
        runOrThrow(step.cmd, step.args, { cwd: step.cwd });
      }
    }
    const ir = optimizedIr ?? sourceIr;
    let minification = null;
    const minLog = [];
    if (minify || treeShake || sourcemap) {
      minification = postProcessBuild({
        out: outAbs, target, opuromc, minify, treeShake, sourcemap,
        log: (line) => minLog.push(String(line)),
      });
    }
    const files = fs.readdirSync(outAbs).filter((f) => !f.startsWith('.'));
    if (!quiet) {
      const shown = files.slice(0, 6).join(', ');
      const tag = optimization ? ` [optimize=${optimization.applied ? 'applied' : 'unavailable'}]` : '';
      const minTag = buildFlagsTag({ minify, treeShake, sourcemap });
      log(`build ok: ${srcAbs} [${target}] -> ${outAbs}${tag}${minTag} (${files.length} entries: ${shown}${files.length > 6 ? ', ...' : ''})`);
      for (const line of minLog) log(line);
      if (minification) log(minification.report);
    }
    return {
      src: srcAbs, target, out: outAbs, ir, files,
      ...(optimization ? { optimization } : {}),
      ...(minification ? { minification } : {}),
    };
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
export function buildFull({
  src, out, root = workspaceRoot(), quiet = false, log = console.log,
  optimize = false, minify = false, treeShake = false, sourcemap = false,
}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });

  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  const { serverc, migrate } = backendTools({ root, log: quiet ? () => {} : log });
  const irFile = path.join(outAbs, 'app.opuir.json');
  let tmp = null;
  try {
    let sourceIr = irFile;
    let optimizedIr = null;
    if (optimize) {
      fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
      tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'full-ir-'));
      sourceIr = path.join(tmp, 'source.opuir.json');
      optimizedIr = irFile;
    }
    let optimization = null;
    for (const step of planFullBuild({
      src: srcAbs, ir: sourceIr, optimizedIr, optimize, out: outAbs, root, opuromc, serverc, migrate,
    })) {
      if (step.label === 'optimize') {
        optimization = optimizeIrFile({ opuromc, input: sourceIr, output: optimizedIr, log });
      } else {
        runOrThrow(step.cmd, step.args, { cwd: step.cwd });
      }
    }

    const ir = readIrFile(irFile);
    writeSharedTypes(ir, outAbs);
    syncMigrationFiles(outAbs);
    assertFullArtifacts(outAbs);

    let minification = null;
    const minLog = [];
    if (minify || treeShake || sourcemap) {
      minification = postProcessBuild({
        out: outAbs, target: 'full', opuromc, minify, treeShake, sourcemap,
        log: (line) => minLog.push(String(line)),
      });
    }
    const artifacts = collectArtifacts(outAbs);
    writeArtifactManifest(outAbs);
    verifyArtifactManifest(outAbs);
    if (!quiet) {
      const tag = optimization ? ` [optimize=${optimization.applied ? 'applied' : 'unavailable'}]` : '';
      const minTag = buildFlagsTag({ minify, treeShake, sourcemap });
      log(`build ok: ${srcAbs} [full] -> ${outAbs}${tag}${minTag}`);
      log(`  app=${ir.app ?? '?'} models=${typesFromIr(ir).models.length} api=${typesFromIr(ir).api.length}`);
      log(summarizeArtifacts(artifacts));
      if (!isFullStackIr(ir)) log('  note: IR has no models/api: the service exposes /health and /ssr only');
      for (const line of minLog) log(line);
      if (minification) log(minification.report);
    }
    return {
      src: srcAbs, out: outAbs, ir: irFile, artifacts, app: ir.app,
      ...(optimization ? { optimization } : {}),
      ...(minification ? { minification } : {}),
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
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
export function buildWasm({
  src, out, root = workspaceRoot(), quiet = false, log = console.log,
  optimize = false, minify = false, treeShake = false, sourcemap = false,
}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  if (!compilerSupportsTarget(opuromc, 'wasm')) {
    throw new Error('this opuromc has no wasm target: rebuild opurom-lang (the wasm emitter is part of the compiler)');
  }
  const cargo = findInPath('cargo');
  if (!cargo) throw new Error('cargo not found: install Rust via https://rustup.rs');
  if (!wasmTargetInstalled()) {
    throw new Error('rust target wasm32-unknown-unknown is not installed: rustup target add wasm32-unknown-unknown');
  }
  const irFile = path.join(outAbs, 'app.opuir.json');
  let tmp = null;
  try {
    let optimization = null;
    if (optimize) {
      fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
      tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'wasm-ir-'));
      const sourceIr = path.join(tmp, 'source.opuir.json');
      runOrThrow(opuromc, ['compile', srcAbs, '-o', sourceIr]);
      optimization = optimizeIrFile({ opuromc, input: sourceIr, output: irFile, log });
    } else {
      runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
    }
    runOrThrow(opuromc, ['target', irFile, '--target', 'wasm', '-o', outAbs]);
    runOrThrow(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: outAbs });
    const minLog = [];
    let minification = null;
    if (minify || treeShake || sourcemap) {
      minification = postProcessBuild({
        out: outAbs, target: 'wasm', opuromc, minify, treeShake, sourcemap,
        log: (line) => minLog.push(String(line)),
      });
    }
    if (!quiet) {
      const wasm = path.join(outAbs, 'target', 'wasm32-unknown-unknown', 'release');
      const tag = optimization ? ` [optimize=${optimization.applied ? 'applied' : 'unavailable'}]` : '';
      const minTag = buildFlagsTag({ minify, treeShake, sourcemap });
      log(`build ok: ${srcAbs} [wasm] -> ${outAbs}${tag}${minTag}`);
      log(`  wasm: ${fs.existsSync(wasm) ? fs.readdirSync(wasm).filter((f) => f.endsWith('.wasm')).join(', ') || '(none)' : '(none)'}`);
      for (const line of minLog) log(line);
      if (minification) log(minification.report);
    }
    return {
      src: srcAbs, out: outAbs, ir: irFile,
      ...(optimization ? { optimization } : {}),
      ...(minification ? { minification } : {}),
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
