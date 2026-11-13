import { discoverBinary, ensureSiblingBinary, findInPath, specFile, workspaceRoot } from './paths.mjs';
import { run } from './proc.mjs';
import fs from 'node:fs';

const HINT_RUST = 'install Rust via https://rustup.rs, then export PATH="$HOME/.cargo/bin:$PATH"';
const HINT_NODE = 'install Node.js >= 20 (v26 verified) and ensure `node` is on PATH';
const HINT_REPO = (repo, root) => `wait for the ${repo} workstream, or: cargo build --manifest-path ${root}/${repo}/Cargo.toml`;

function version(file) {
  const result = run(file, ['--version'], { timeout: 15000 });
  return result.status === 0 ? result.stdout.trim().split('\n')[0] : '';
}

export function collectDoctor({ root = workspaceRoot(), log = () => {} } = {}) {
  const rows = [];
  const tool = (name, file, hint) => {
    const v = file ? version(file) : '';
    rows.push({
      name, required: true, skip: false, ok: Boolean(file),
      detail: file ? `${file}${v ? ` (${v})` : ''}` : 'MISSING',
      hint: file ? '' : hint,
    });
  };

  tool('node', process.execPath, HINT_NODE);
  tool('cargo', findInPath('cargo'), HINT_RUST);
  tool('rustc', findInPath('rustc'), HINT_RUST);

  for (const [label, repo, names] of [
    ['opuromc', 'opurom-lang', ['opuromc']],
    ['opurom-render', 'opurom-render', ['opurom-render', 'opurom_render']],
  ]) {
    const found = ensureSiblingBinary(repo, names, { root, log });
    rows.push({
      name: label, required: true, ok: Boolean(found.path), skip: !found.path && found.skip,
      detail: found.path ?? `MISSING — ${found.reason}`,
      hint: found.path ? '' : HINT_REPO(repo, root),
    });
  }

  for (const [label, repo, names] of [
    ['opurom-core', 'opurom-core', ['opurom-core', 'opurom_core']],
    ['opurom-platform', 'opurom-platform', ['opurom-platform', 'opurom_platform']],
  ]) {
    const file = discoverBinary(names, { root, repo });
    rows.push({
      name: label, required: false, skip: false, ok: Boolean(file),
      detail: file ?? 'not built (optional for doctor; `test` builds it lazily)',
      hint: '',
    });
  }

  // Availability only: `bench --compare` resolves this binary itself, so a
  // report must never start a cargo build of its own.
  const gpu = discoverBinary(['opurom-gpu', 'opurom_gpu'], { root, repo: 'opurom-gpu' });
  rows.push({
    name: 'opurom-gpu', required: false, skip: false, ok: Boolean(gpu),
    detail: gpu ?? 'not built (needed by `bench --compare`)',
    hint: gpu ? '' : `cargo build --manifest-path ${root}/opurom-gpu/Cargo.toml`,
  });

  rows.push({
    name: 'golden spec', required: true, skip: false,
    ok: fs.existsSync(specFile('counter.opuir.json', root)) && fs.existsSync(specFile('IR_SCHEMA.md', root)),
    detail: `${root}/opurom-spec/counter.opuir.json + IR_SCHEMA.md`,
    hint: HINT_REPO('opurom-spec', root),
  });
  return rows;
}

export function runDoctor(opts = {}) {
  const log = opts.log ?? console.log;
  const rows = collectDoctor({ ...opts, log });
  log('OPUROM doctor');
  for (const row of rows) {
    const tag = row.ok ? 'ok  ' : row.required ? 'FAIL' : 'info';
    const detail = row.detail.split('\n')[0];
    log(`  [${tag}] ${row.name.padEnd(16)} ${detail}${row.detail.includes('\n') ? ' ...' : ''}`);
    if (!row.ok && row.hint) log(`         hint: ${row.hint}`);
  }
  const required = rows.filter((row) => row.required);
  const ok = required.filter((row) => row.ok).length;
  log(`result: ${ok}/${required.length} required tools OK`);
  return ok === required.length ? 0 : 1;
}
