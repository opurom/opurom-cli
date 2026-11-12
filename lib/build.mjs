import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, ensureSiblingBinary, findInPath, workspaceRoot } from './paths.mjs';
import { runOrThrow } from './proc.mjs';
import { validateTarget } from './targets.mjs';

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
