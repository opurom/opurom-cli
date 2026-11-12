import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './proc.mjs';

export const CLI_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function workspaceRoot(cliRoot = CLI_ROOT) {
  return path.dirname(cliRoot);
}

export function siblingRoot(name, root = workspaceRoot()) {
  return path.join(root, name);
}

// Temp work directory inside the repo (gitignored); created on demand.
export function tmpDir(prefix = 'opurom-') {
  const dir = path.join(CLI_ROOT, 'tmp');
  fs.mkdirSync(dir, { recursive: true });
  return fs.mkdtempSync(path.join(dir, prefix));
}

export function specFile(file, root = workspaceRoot()) {
  return path.join(root, 'opurom-spec', file);
}

export function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

export function findInPath(name, envPath = process.env.PATH ?? '', home = os.homedir()) {
  if (name.includes('/')) return isExecutable(name) ? path.resolve(name) : null;
  const dirs = [...envPath.split(path.delimiter), path.join(home, '.cargo', 'bin'), '/usr/local/bin'];
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (isExecutable(candidate)) return path.resolve(candidate);
  }
  return null;
}

// Looks in a sibling Rust repo's cargo target dirs, then PATH. Unit-testable via `root`.
export function discoverBinary(names, { root = workspaceRoot(), repo = null, envPath = process.env.PATH ?? '' } = {}) {
  const list = Array.isArray(names) ? names : [names];
  const repos = repo ? [repo] : list;
  for (const bin of list) {
    for (const r of repos) {
      for (const profile of ['debug', 'release']) {
        const candidate = path.join(root, r, 'target', profile, bin);
        if (isExecutable(candidate)) return path.resolve(candidate);
      }
    }
    const onPath = findInPath(bin);
    if (onPath) return onPath;
  }
  // A cargo [[bin]] may differ from the repo name by an underscore or suffix.
  if (repo) {
    for (const profile of ['debug', 'release']) {
      const dir = path.join(root, repo, 'target', profile);
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const normalized = entry.name.replaceAll('_', '-');
        if (!list.some((bin) => normalized === bin.replaceAll('_', '-'))) continue;
        const candidate = path.join(dir, entry.name);
        if (isExecutable(candidate)) return path.resolve(candidate);
      }
    }
  }
  return null;
}

// Lazy build: use an existing binary, otherwise `cargo build` a present sibling repo.
// `skip: true` means the repo is genuinely not here yet; other failures are real errors.
// `env` lets callers force an offline build from cached crates.
export function ensureSiblingBinary(repo, names, { root = workspaceRoot(), log = () => {}, env = process.env } = {}) {
  const existing = discoverBinary(names, { root, repo });
  if (existing) return { path: existing, built: false, reason: null, skip: false };

  const dir = siblingRoot(repo, root);
  if (!fs.existsSync(dir)) {
    return { path: null, built: false, skip: true, reason: `sibling repo ${repo} is absent (${dir})` };
  }
  const manifest = path.join(dir, 'Cargo.toml');
  if (!fs.existsSync(manifest)) {
    return { path: null, built: false, skip: true, reason: `${repo} has no Cargo.toml yet (${dir})` };
  }
  const cargo = findInPath('cargo');
  if (!cargo) {
    return { path: null, built: false, skip: false, reason: 'cargo not found on PATH or $HOME/.cargo/bin' };
  }
  log(`building ${repo} with cargo ...`);
  const built = run(cargo, ['build', '--manifest-path', manifest], { cwd: dir, env });
  if (built.status !== 0) {
    const detail = [built.stdout, built.stderr].filter(Boolean).join('\n').trim();
    return { path: null, built: false, skip: false, reason: `cargo build ${repo} failed: ${detail}` };
  }
  const found = discoverBinary(names, { root, repo });
  return found
    ? { path: found, built: true, reason: null, skip: false }
    : { path: null, built: false, skip: false, reason: `cargo build ${repo} produced no ${names} binary` };
}
