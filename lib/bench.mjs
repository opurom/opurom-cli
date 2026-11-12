import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, findInPath } from './paths.mjs';
import { runOrThrow } from './proc.mjs';
import { collectArtifacts, compilerSupportsTarget, formatBytes, wasmTargetInstalled } from './fullstack.mjs';

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

export async function bench({ src, out, root, log = console.log, keep = false } = {}) {
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

    let nativeMs = null;
    if (cargo) {
      runOrThrow(opuromc, ['target', irFile, '--target', 'native', '-o', path.join(outAbs, 'native')]);
      const t2 = performance.now();
      try {
        runOrThrow(cargo, ['build', '--release'], { cwd: path.join(outAbs, 'native') });
        nativeMs = performance.now() - t2;
        rows.push({ step: 'native build (cargo build --release)', elapsed: formatMillis(nativeMs) });
      } catch (error) {
        rows.push({ step: 'native build (cargo build --release)', elapsed: `failed: ${error.message.split('\n')[0]}` });
      }
    } else {
      rows.push({ step: 'native build (cargo build --release)', elapsed: 'skipped: cargo not found' });
    }

    let wasmMs = null;
    if (!compilerSupportsTarget(opuromc, 'wasm')) {
      rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: 'skipped: this opuromc has no wasm emitter' });
    } else if (!cargo || !wasmTargetInstalled()) {
      rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: 'skipped: cargo or wasm32 std not installed' });
    } else {
      try {
        runOrThrow(opuromc, ['target', irFile, '--target', 'wasm', '-o', path.join(outAbs, 'wasm')]);
        const t3 = performance.now();
        runOrThrow(cargo, ['build', '--release', '--target', 'wasm32-unknown-unknown'], { cwd: path.join(outAbs, 'wasm') });
        wasmMs = performance.now() - t3;
        rows.push({ step: 'wasm build (cargo build --release --target wasm32)', elapsed: formatMillis(wasmMs) });
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
