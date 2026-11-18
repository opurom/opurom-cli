import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, ensureSiblingBinary, findInPath, workspaceRoot } from './paths.mjs';
import { environmentProcessEnv } from './config.mjs';
import { modeDefines, writeModeRecord } from './build_mode.mjs';
import { buildTimingsJson, createTimer, formatBuildTimings } from './build_timings.mjs';
import { createFileStore, FILE_STORE_NAME } from './file_store.mjs';
import { collectInputFiles } from './imports.mjs';
import { decideIncremental, incrementalDecisionJson } from './incremental_decision.mjs';
import {
  diffOutputMarks, discoverOutputFiles, OUTPUT_MARK_FILE, readOutputMarks, writeOutputMarks,
} from './incremental_outputs.mjs';
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

export function check(src, { root = workspaceRoot(), env = process.env, log = console.log, environment = null, buildInfo = null } = {}) {
  const file = path.resolve(src);
  if (!fs.existsSync(file)) throw new Error(`source not found: ${file}`);
  const opuromc = compilerPath({ root, log });
  const args = ['check', file];
  if (environment) args.push('--dart-define', `Environment=${environment.name}`);
  if (buildInfo) {
    args.push('--dart-define', `BuildMode=${buildInfo.mode}`);
    if (buildInfo.target) args.push('--dart-define', `TargetFile=${buildInfo.target}`);
  }
  const result = run(opuromc, args, { inherit: true, env });
  if (result.status !== 0) {
    throw new Error(`opuromc check failed (exit ${result.status})`);
  }
  return result;
}

// opuromc resolves imports from the main file, so a project needs only one
// source path to enter the existing compile-and-lower pipeline.
export function projectMain(dir) {
  if (typeof dir !== 'string' || dir === '') throw new Error('usage: --project <dir>');
  const main = path.join(path.resolve(dir), 'main.opu');
  if (!fs.existsSync(main) || !fs.statSync(main).isFile()) {
    throw new Error(`project main.opu not found: ${main}`);
  }
  return main;
}

export function build({
  src, target, out, root = workspaceRoot(), quiet = false, log = console.log,
  optimize = false, minify = false, treeShake = false, sourcemap = false,
  env = process.env, environment = null, buildInfo = null, modeContext = null,
  timings = false, timingsFile = null, incremental = false, incrementalEnforce = false,
}) {
  validateTarget(target);
  if (incrementalEnforce && !incremental) {
    throw new Error('--incremental=enforce requires --incremental');
  }
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  const fileStore = incremental
    ? createFileStore({
      cacheFile: path.join(outAbs, FILE_STORE_NAME), root: path.dirname(srcAbs), log,
    })
    : null;
  let dirtyInputs = [];
  let trackedInputs = [srcAbs];
  let dirtyOutputs = [];
  let currentOutputMarks = 0;
  let recordedSteps = [];
  let outputMarks = null;
  if (fileStore) {
    fileStore.initialize();
    // Transitive import closure: a changed module invalidates the entry just
    // like the entry itself. Token JSON imports are hashed but never compile.
    const inputs = collectInputFiles(srcAbs, { root: path.dirname(srcAbs) });
    trackedInputs = [...inputs.files, ...inputs.tokenFiles];
    dirtyInputs = fileStore.diff(trackedInputs);

    // External edits to lower/postprocess outputs invalidate the next
    // decision. Output marks now gate enforcement only; observation remains
    // non-mutating apart from its deterministic cache artifacts.
    outputMarks = path.join(outAbs, OUTPUT_MARK_FILE);
    const previousOutputMarks = readOutputMarks(outputMarks);
    const currentOutputs = discoverOutputFiles(outAbs);
    currentOutputMarks = Object.keys(previousOutputMarks).length;
    dirtyOutputs = diffOutputMarks(currentOutputs, previousOutputMarks, outAbs);
    recordedSteps = [];
    const decisionFile = path.join(outAbs, '.opurom-incremental', 'latest.json');
    if (fs.existsSync(decisionFile)) {
      try {
        const previousDecision = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
        if (Array.isArray(previousDecision.lastExecutedSteps)) {
          recordedSteps = previousDecision.lastExecutedSteps.map(String);
        } else if (Array.isArray(previousDecision.executedSteps)) {
          recordedSteps = previousDecision.executedSteps.map(String);
        }
      } catch {
        recordedSteps = [];
      }
    }
  }
  if (modeContext) writeModeRecord(outAbs, modeContext);
  const timer = createTimer();

  const opuromc = compilerPath({ root, log: quiet ? () => {} : log });
  const cargo = findInPath('cargo');
  if (target === 'native' && !cargo) {
    throw new Error('cargo not found: install Rust via https://rustup.rs');
  }

  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'ir-'));
  const sourceIr = path.join(tmp, optimize ? 'source.opuir.json' : 'app.opuir.json');
  const optimizedIr = optimize ? path.join(tmp, 'app.opuir.json') : null;
  const buildSteps = planBuild({
    src: srcAbs, target, out: outAbs, ir: sourceIr, optimizedIr, optimize, opuromc, cargo,
  });
  const stepLabels = buildSteps.map((step) => step.label);
  if (minify || treeShake || sourcemap) stepLabels.push('postprocess');
  const dirty = [...dirtyInputs, ...dirtyOutputs];
  // Enforcement may skip only when a prior complete build was recorded.
  // Missing caches or outputs force a full rebuild even when input marks are
  // clean; a clean first run can never silently reuse absent artifacts.
  const recordedBuild = fileStore && fileStore.size > 0
    && currentOutputMarks > 0
    && stepLabels.every((label) => recordedSteps.includes(label));
  const enforcement = incrementalEnforce ? 'enforced' : 'none';
  const skipSteps = Boolean(enforcement === 'enforced' && recordedBuild && dirty.length === 0);
  const incrementalDecision = fileStore
    ? decideIncremental({ dirty, steps: stepLabels, enforcement })
    : null;
  // Enforcement only skips after a complete recorded build; otherwise it must
  // run every step even when the tracked inputs happen to be clean.
  // A skipped build is a no-op: keep the previous complete decision so the
  // recorded step set remains available for the next incremental check.
  // Enforcement may skip only after a complete recorded build. Observation
  // always executes every step but still reports would-skip for clean inputs.
  if (incrementalDecision && !skipSteps) {
    const observeClean = enforcement === 'none' && dirty.length === 0;
    const runs = recordedBuild
      ? 'dirty tracked inputs require a rebuild'
      : 'no complete recorded build; full rebuild required';
    incrementalDecision.steps.forEach((row) => {
      row.action = observeClean ? 'would-skip' : 'run';
      row.executed = true;
      row.reason = observeClean ? 'all tracked inputs clean; observation-only skip' : runs;
    });
    incrementalDecision.skipped = observeClean
      ? incrementalDecision.steps.map((row) => row.step)
      : [];
    incrementalDecision.summary.skipped = incrementalDecision.skipped.length;
    incrementalDecision.summary.executed = incrementalDecision.steps.length;
  }
  let caughtFailure = false;
  try {
    let optimization = null;
    for (const step of buildSteps) {
      if (incrementalDecision?.steps.find((row) => row.step === step.label)?.action === 'skipped') continue;
      if (step.label === 'optimize') {
        optimization = timer.measure('optimize', () => optimizeIrFile({
          opuromc, input: sourceIr, output: optimizedIr, log,
        }));
      } else {
        const stepEnv = (step.label === 'compile' && environment)
          ? environmentProcessEnv(environment, env) : env;
        timer.measure(step.label, () => runOrThrow(step.cmd, step.args, { cwd: step.cwd, env: stepEnv }));
      }
    }
    const ir = optimizedIr ?? sourceIr;
    let minification = null;
    const minLog = [];
    const skipPostprocess = incrementalDecision?.steps.some(
      (row) => row.step === 'postprocess' && row.action === 'skipped',
    );
    if ((minify || treeShake || sourcemap) && !skipPostprocess) {
      minification = timer.measure('postprocess', () => postProcessBuild({
        out: outAbs, target, opuromc, minify, treeShake, sourcemap,
        log: (line) => minLog.push(String(line)),
      }));
    }
    const files = fs.readdirSync(outAbs).filter((f) => !f.startsWith('.'));
    // Hand back the parsed IR too: dev's watch loop classifies reloads from it
    // without paying a second compile (the temp IR is removed below).
    let irData = null;
    // A fully skipped build produces no temporary IR; the prior artifacts are
    // byte-identical and the cached decision records the last executed steps.
    if (!(enforcement === 'enforced' && skipSteps)) {
      try { irData = readIrFile(ir); } catch { irData = null; }
    }
    if (!quiet) {
      const shown = files.slice(0, 6).join(', ');
      const tag = optimization ? ` [optimize=${optimization.applied ? 'applied' : 'unavailable'}]` : '';
      const minTag = buildFlagsTag({ minify, treeShake, sourcemap });
      log(`build ok: ${srcAbs} [${target}] -> ${outAbs}${tag}${minTag} (${files.length} entries: ${shown}${files.length > 6 ? ', ...' : ''})`);
      for (const line of minLog) log(line);
      if (minification) log(minification.report);
      if (timings) log(formatBuildTimings(timer.rows));
    }
    if (timingsFile) {
      fs.writeFileSync(path.resolve(timingsFile), buildTimingsJson(timer.rows, {
        src: srcAbs, target, out: outAbs,
      }));
    }
    if (incrementalDecision) {
      const decisionDir = path.join(outAbs, '.opurom-incremental');
      fs.mkdirSync(decisionDir, { recursive: true });
      const executedSteps = incrementalDecision.steps
        .filter((row) => row.executed).map((row) => row.step);
      fs.writeFileSync(
        path.join(decisionDir, 'latest.json'),
        incrementalDecisionJson(incrementalDecision, {
          src: srcAbs, target, out: outAbs,
          executedSteps: !skipSteps ? executedSteps : undefined,
          lastExecutedSteps: skipSteps ? recordedSteps : executedSteps,
        }),
      );
      writeOutputMarks(outputMarks, discoverOutputFiles(outAbs), {
        previous: readOutputMarks(outputMarks),
      });
    }
    return {
      src: srcAbs, target, out: outAbs, ir, irData, files,
      ...(optimization ? { optimization } : {}),
      ...(minification ? { minification } : {}),
      ...(timings ? { timings: timer.rows } : {}),
      ...(fileStore ? { incremental: true, fileStore: fileStore.file } : {}),
      ...(incrementalDecision ? { incrementalDecision, dirtyOutputs } : {}),
    };
  } catch (error) {
    caughtFailure = true;
    if (incrementalEnforce) {
      // Enforcement is best-effort: any failure invalidates recorded marks and
      // the next build runs every step from scratch. Do not invalidate caches
      // for the normal observation mode.
      if (fileStore) fs.rmSync(fileStore.file, { force: true });
      if (outputMarks) fs.rmSync(outputMarks, { force: true });
      fs.rmSync(path.join(outAbs, '.opurom-incremental', 'latest.json'), { force: true });
    }
    throw error;
  } finally {
    if (fileStore && !(incrementalEnforce && fs.existsSync(fileStore.file) === false && caughtFailure)) fileStore.persist();
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
  env = process.env, environment = null, buildInfo = null, modeContext = null,
}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  if (modeContext) writeModeRecord(outAbs, modeContext);

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
  env = process.env, environment = null, buildInfo = null, modeContext = null,
}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  if (modeContext) writeModeRecord(outAbs, modeContext);
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
