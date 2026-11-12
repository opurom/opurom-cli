import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CLI_ROOT, discoverBinary, findInPath } from './paths.mjs';
import { runOrThrow } from './proc.mjs';
import { freePort, startService } from './service.mjs';
import {
  collectArtifacts, compilerSupportsTarget, findWasmFile, formatBytes, wasmTargetInstalled,
} from './fullstack.mjs';

// Measured numbers only: every row below comes from a real run of a real command.
export function formatMillis(ms) {
  if (!Number.isFinite(ms)) return 'n/a';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function markdownTable(rows, columns) {
  const head = `| ${columns.join(' | ')} |`;
  const rule = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${columns.map((c) => row[c] ?? '').join(' | ')} |`);
  return [head, rule, ...body].join('\n');
}

export function benchArtifactRows(artifacts) {
  return artifacts.map((entry) => ({
    artifact: entry.name,
    files: String(entry.files),
    bytes: formatBytes(entry.bytes),
  }));
}

export function unavailable(reason) {
  const text = String(reason ?? 'not run').split(/\r?\n/)[0].replaceAll('|', '/').trim();
  return `n/a (${text || 'not run'})`;
}

export function formatExactMillis(ms) {
  return Number.isFinite(ms) ? `${ms} ms` : unavailable('no timing');
}

export function formatExactBytes(bytes) {
  return Number.isFinite(bytes) ? `${bytes} B` : unavailable('no byte count');
}

export const FULL_STEPS = Object.freeze([
  ['compile', 'compile (opuromc compile)'],
  ['lower', 'lower to web (opuromc target --target web)'],
  ['render', 'render (opurom-render 800x600)'],
  ['native', 'native build (cargo build --release)'],
  ['wasm', 'wasm build (cargo build --release --target wasm32)'],
  ['service', 'service request (GET /health)'],
]);

export const FULL_BENCH_ARTIFACTS = Object.freeze([
  'web', 'native', 'wasm', 'wasm module', 'frame.ppm', 'server', 'migrations',
  'shared/types.json', 'app.opuir.json', 'service /health body',
]);

export function measuredRows(measurements) {
  return FULL_STEPS.map(([key, step]) => {
    const value = measurements[key];
    let elapsed;
    if (typeof value === 'number') elapsed = formatExactMillis(value);
    else if (value && Number.isFinite(value.ms)) elapsed = formatExactMillis(value.ms);
    else elapsed = unavailable(value?.reason ?? 'not run');
    return { step, elapsed };
  });
}

export function measuredArtifactRows(artifacts, names = FULL_BENCH_ARTIFACTS) {
  const byName = new Map(artifacts.map((entry) => [entry.name, entry]));
  return names.map((name) => {
    const entry = byName.get(name);
    if (!entry || !Number.isFinite(entry.files) || !Number.isFinite(entry.bytes)) {
      return { artifact: name, files: unavailable('not generated'), bytes: unavailable('not generated') };
    }
    return { artifact: name, files: String(entry.files), bytes: formatExactBytes(entry.bytes) };
  });
}

function errorReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? 'unknown error';
}

async function timed(fn) {
  const start = performance.now();
  try {
    const value = await fn();
    return { ms: performance.now() - start, value };
  } catch (error) {
    return { reason: errorReason(error) };
  }
}

const SYNTHETIC_ARTIFACTS = new Set(['wasm module', 'service /health body']);

async function runFullBench({ src, out, root, log, keep }) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  const runOut = fs.mkdtempSync(path.join(outAbs, 'full-'));
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'bench-full-'));
  const irFile = path.join(tmp, 'app.opuir.json');
  const measurements = {};
  const synthetic = [];
  let service = null;

  try {
    let opuromc = null;
    let buildFull = null;
    try {
      ({ buildFull } = await import('./build.mjs'));
      const { compilerPath } = await import('./build.mjs');
      opuromc = compilerPath({ root, log: () => {} });
    } catch (error) {
      const reason = `opuromc unavailable: ${errorReason(error)}`;
      for (const [key] of FULL_STEPS) measurements[key] = { reason };
    }

    if (opuromc) {
      measurements.compile = await timed(() => runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]));
      if (!Number.isFinite(measurements.compile.ms)) {
        const reason = `compile unavailable: ${measurements.compile.reason ?? 'not run'}`;
        for (const [key] of FULL_STEPS.slice(1)) measurements[key] = { reason };
      } else {
        measurements.lower = await timed(() => runOrThrow(
          opuromc, ['target', irFile, '--target', 'web', '-o', path.join(runOut, 'web')],
        ));

        const renderer = discoverBinary(['opurom-render', 'opurom_render'], { root, repo: 'opurom-render' });
        const frame = path.join(runOut, 'frame.ppm');
        measurements.render = renderer
          ? await timed(() => runOrThrow(renderer, [irFile, '800', '600', frame]))
          : { reason: 'opurom-render not found' };

        const cargo = findInPath('cargo');
        if (!cargo) {
          measurements.native = { reason: 'cargo not found' };
        } else {
          try {
            runOrThrow(opuromc, ['target', irFile, '--target', 'native', '-o', path.join(runOut, 'native')]);
            measurements.native = await timed(() => runOrThrow(
              cargo, ['build', '--release'], { cwd: path.join(runOut, 'native') },
            ));
          } catch (error) {
            measurements.native = { reason: errorReason(error) };
          }
        }

        let wasmReason = null;
        let wasmSupported = false;
        try {
          wasmSupported = compilerSupportsTarget(opuromc, 'wasm');
        } catch (error) {
          wasmReason = errorReason(error);
        }
        if (!wasmSupported) wasmReason ??= 'this opuromc has no wasm emitter';
        else if (!cargo || !wasmTargetInstalled()) wasmReason = 'cargo or wasm32 std not installed';
        if (wasmReason) {
          measurements.wasm = { reason: wasmReason };
        } else {
          const wasmDir = path.join(runOut, 'wasm');
          try {
            runOrThrow(opuromc, ['target', irFile, '--target', 'wasm', '-o', wasmDir]);
            measurements.wasm = await timed(() => runOrThrow(
              cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: wasmDir },
            ));
            const wasmFile = findWasmFile(wasmDir);
            if (wasmFile) {
              synthetic.push({ name: 'wasm module', files: 1, bytes: fs.statSync(wasmFile).size });
            }
          } catch (error) {
            measurements.wasm = { reason: errorReason(error) };
          }
        }

        try {
          // The migration generator leaves no directory for an IR without models.
          fs.mkdirSync(path.join(runOut, 'migrations'), { recursive: true });
          buildFull({ src: srcAbs, out: runOut, root, quiet: true, log: () => {} });
          const port = await freePort();
          service = await startService({
            out: runOut, port, root, log: () => {}, wait: true, offline: true,
          });
          measurements.service = await timed(async () => {
            const response = await fetch(`${service.base}/health`);
            const body = await response.text();
            if (!response.ok) throw new Error(`status ${response.status}: ${body.slice(0, 200)}`);
            return body;
          });
          if (Number.isFinite(measurements.service.ms)) {
            synthetic.push({
              name: 'service /health body',
              files: 1,
              bytes: Buffer.byteLength(String(measurements.service.value ?? ''), 'utf8'),
            });
          }
        } catch (error) {
          measurements.service = { reason: errorReason(error) };
        }
      }
    }

    const diskNames = FULL_BENCH_ARTIFACTS.filter((name) => !SYNTHETIC_ARTIFACTS.has(name));
    const artifacts = [...collectArtifacts(runOut, diskNames), ...synthetic];
    log('OPUROM bench --full (measured on this machine, this run)');
    log('');
    log(markdownTable(measuredRows(measurements), ['step', 'elapsed']));
    log('');
    log(markdownTable(measuredArtifactRows(artifacts), ['artifact', 'files', 'bytes']));
    log('');
    log('Exact performance.now() timings and on-disk/response byte counts; n/a means the measurement could not run.');
    log('No fps, startup, throughput or competitor claims.');
    return { rows: measuredRows(measurements), artifacts, measurements, out: runOut };
  } finally {
    if (service) await service.stop().catch(() => {});
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function bench({ src, out, root, log = console.log, keep = false, full = false } = {}) {
  if (full) return runFullBench({ src, out, root, log, keep });
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const outAbs = path.resolve(out);
  fs.mkdirSync(outAbs, { recursive: true });
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'bench-'));
  const irFile = path.join(tmp, 'app.opuir.json');

  const rows = [];
  try {
    const { compilerPath } = await import('./build.mjs');
    const opuromc = compilerPath({ root, log: () => {} });
    const cargo = findInPath('cargo');

    const t0 = performance.now();
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
    rows.push({ step: 'compile (opuromc compile)', elapsed: formatMillis(performance.now() - t0) });

    const t1 = performance.now();
    runOrThrow(opuromc, ['target', irFile, '--target', 'web', '-o', path.join(outAbs, 'web')]);
    rows.push({ step: 'lower to web (opuromc target --target web)', elapsed: formatMillis(performance.now() - t1) });

    if (cargo) {
      runOrThrow(opuromc, ['target', irFile, '--target', 'native', '-o', path.join(outAbs, 'native')]);
      const t2 = performance.now();
      try {
        runOrThrow(cargo, ['build', '--release'], { cwd: path.join(outAbs, 'native') });
        rows.push({ step: 'native build (cargo build --release)', elapsed: formatMillis(performance.now() - t2) });
      } catch (error) {
        rows.push({ step: 'native build (cargo build --release)', elapsed: `failed: ${error.message.split('\n')[0]}` });
      }
    } else {
      rows.push({ step: 'native build (cargo build --release)', elapsed: 'skipped: cargo not found' });
    }

    if (!compilerSupportsTarget(opuromc, 'wasm')) {
      rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: 'skipped: this opuromc has no wasm emitter' });
    } else if (!cargo || !wasmTargetInstalled()) {
      rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: 'skipped: cargo or wasm32 std not installed' });
    } else {
      try {
        runOrThrow(opuromc, ['target', irFile, '--target', 'wasm', '-o', path.join(outAbs, 'wasm')]);
        const t3 = performance.now();
        runOrThrow(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: path.join(outAbs, 'wasm') });
        rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: formatMillis(performance.now() - t3) });
      } catch (error) {
        rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: `failed: ${error.message.split('\n')[0]}` });
      }
    }

    const artifacts = collectArtifacts(outAbs, ['web', 'native', 'wasm']);
    log('OPUROM bench (measured on this machine, this run)');
    log('');
    log(markdownTable(rows, ['step', 'elapsed']));
    log('');
    log(markdownTable(benchArtifactRows(artifacts), ['artifact', 'files', 'bytes']));
    log('');
    log('Only wall-clock time and on-disk size are reported. No fps, startup or throughput claims.');
    return { rows, artifacts };
  } finally {
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
