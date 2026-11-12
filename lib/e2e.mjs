import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, ensureSiblingBinary, specFile, workspaceRoot } from './paths.mjs';
import { run, runOrThrow } from './proc.mjs';
import { build } from './build.mjs';
import { collectDoctor } from './doctor.mjs';

export class SkipError extends Error {}

function requireBin(repo, names, { root, log }) {
  const found = ensureSiblingBinary(repo, names, { root, log });
  if (found.path) return found.path;
  if (found.skip) throw new SkipError(`${repo}: ${found.reason}`);
  throw new Error(`${repo}: ${found.reason}`);
}

function tempDir(name, cleanup) {
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', `e2e-${name}-`));
  cleanup.push(dir);
  return dir;
}

function nodeCheck(file) {
  assert.ok(fs.existsSync(file), `missing generated file: ${file}`);
  runOrThrow(process.execPath, ['--check', file]);
}

function readIr(result, irFile) {
  if (fs.existsSync(irFile)) return fs.readFileSync(irFile, 'utf8');
  const start = result.stdout.indexOf('{');
  assert.ok(start !== -1, 'opuromc compile wrote no IR file and printed no JSON');
  return result.stdout.slice(start);
}

export function digestOf(text) {
  const match = /(?:digest|hash|sha256|sha)[^\n]*?\b([0-9a-f]{8,64})\b/gi.exec(text);
  return match ? match[1].toLowerCase() : null;
}

export function dirtyOf(text) {
  const match = /dirty[^\n]*?(\d+)/i.exec(text);
  return match ? Number(match[1]) : null;
}

// opurom-platform prints a header line plus 14 registry rows with " | " separators.
export function platformRows(text) {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(' | '))
    .filter((line) => !/^name\s*\|/i.test(line));
}

function nativeBinary(outDir) {
  const cargo = path.join(outDir, 'Cargo.toml');
  let name = null;
  if (fs.existsSync(cargo)) {
    const text = fs.readFileSync(cargo, 'utf8');
    name = /\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(text)?.[1]
      ?? /\[package\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(text)?.[1]
      ?? null;
  }
  const release = path.join(outDir, 'target', 'release');
  const candidates = name ? [path.join(release, name)] : [];
  if (fs.existsSync(release)) {
    for (const entry of fs.readdirSync(release)) {
      const file = path.join(release, entry);
      if (fs.statSync(file).isFile() && !path.extname(entry)) candidates.push(file);
    }
  }
  return candidates.find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) ?? null;
}

export function runE2e({ root = workspaceRoot(), log = console.log } = {}) {
  const cleanup = [];
  const checks = [
    ['doctor passes', () => {
      const rows = collectDoctor({ root, log: () => {} });
      const skipped = rows.find((row) => row.required && !row.ok && row.skip);
      if (skipped) throw new SkipError(skipped.detail);
      const missing = rows.filter((row) => row.required && !row.ok).map((row) => row.name);
      assert.deepEqual(missing, [], `doctor missing: ${missing.join(', ')}`);
      return `${rows.filter((r) => r.required && r.ok).length} required tools OK`;
    }],
    ['golden IR deep-equal', () => {
      const opuromc = requireBin('opurom-lang', ['opuromc'], { root, log: () => {} });
      const dir = tempDir('ir', cleanup);
      const irFile = path.join(dir, 'counter.opuir.json');
      const src = specFile('counter.opu', root);
      const golden = specFile('counter.opuir.json', root);
      assert.ok(fs.existsSync(src) && fs.existsSync(golden), `golden spec files missing in ${root}/opurom-spec`);
      const result = runOrThrow(opuromc, ['compile', src, '-o', irFile]);
      const actual = JSON.parse(readIr(result, irFile));
      assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')));
      return `app=${actual.app}, ir=${actual.ir}`;
    }],
    ['web app.js is valid JS', () => {
      const dir = tempDir('web', cleanup);
      const out = path.join(dir, 'web');
      build({ src: specFile('counter.opu', root), target: 'web', out, root, quiet: true });
      nodeCheck(path.join(out, 'app.js'));
      return 'node --check app.js';
    }],
    ['mini-program index.js is valid JS', () => {
      const dir = tempDir('wechat', cleanup);
      const out = path.join(dir, 'wechat');
      build({ src: specFile('counter.opu', root), target: 'wechat', out, root, quiet: true });
      nodeCheck(path.join(out, 'index.js'));
      return 'node --check index.js (wechat)';
    }],
    ['native builds and prints state', () => {
      const dir = tempDir('native', cleanup);
      const out = path.join(dir, 'native');
      build({ src: specFile('counter.opu', root), target: 'native', out, root, quiet: true });
      const bin = nativeBinary(out);
      assert.ok(bin, `no native binary in ${path.join(out, 'target', 'release')}`);
      const result = run(bin, [], { input: 'tap 4\nstate\nquit\n', timeout: 30000 });
      const text = `${result.stdout}${result.stderr}`;
      assert.match(text, /state\s+count=/i, `native output has no state line:\n${text.slice(0, 400)}`);
      return `${path.basename(bin)} printed "state count=..."`;
    }],
    ['renderer digest + dirty count', () => {
      const bin = requireBin('opurom-render', ['opurom-render', 'opurom_render'], { root, log });
      const ir = specFile('counter.opuir.json', root);
      const dir = tempDir('render', cleanup);
      const ppm = path.join(dir, 'frame.ppm');
      const attempts = [
        [ir, '320', '240', ppm], [ir, '800', '600', ppm], [ir], ['--ir', ir], [ir, '--json'],
      ];
      let chosen = null;
      for (const args of attempts) {
        const result = run(bin, args, { timeout: 30000 });
        if (result.status === 0 && digestOf(`${result.stdout}${result.stderr}`) !== null
          && dirtyOf(`${result.stdout}${result.stderr}`) !== null) {
          chosen = { args, text: `${result.stdout}${result.stderr}` };
          break;
        }
      }
      assert.ok(chosen, 'opurom-render printed no digest + dirty count for any known argv');
      const again = runOrThrow(bin, chosen.args, { timeout: 30000 });
      const first = digestOf(chosen.text);
      const second = digestOf(`${again.stdout}${again.stderr}`);
      assert.equal(second, first, 'renderer digest is not stable across two identical runs');
      const dirty = dirtyOf(chosen.text);
      assert.ok(Number.isInteger(dirty), 'dirty count is not numeric');
      return `${chosen.args.join(' ') || '(no args)'}: digest=${first}, dirty=${dirty}`;
    }],
    ['platform prints 14 rows', () => {
      const bin = requireBin('opurom-platform', ['opurom-platform', 'opurom_platform'], { root, log });
      const attempts = [[], ['capabilities'], ['--list'], ['list']];
      let best = null;
      for (const args of attempts) {
        const result = run(bin, args, { timeout: 30000 });
        if (result.status !== 0) continue;
        const rows = platformRows(`${result.stdout}${result.stderr}`);
        best = { args, rows, text: `${result.stdout}${result.stderr}` };
        if (rows.length === 14) break;
      }
      assert.ok(best, 'opurom-platform did not run successfully');
      assert.match(best.text, /^name \| emitter \| status \| gpu \| native_embed \| multi_window$/m,
        'opurom-platform registry header missing');
      assert.equal(best.rows.length, 14, `expected 14 rows, got ${best.rows.length}:\n${best.text.slice(0, 600)}`);
      assert.equal(new Set(best.rows.map((row) => row.split(' | ')[0])).size, 14, 'registry names are not unique');
      return `${best.args.join(' ') || '(no args)'}: 14 unique rows`;
    }],
  ];

  const results = [];
  for (const [name, fn] of checks) {
    try {
      const detail = fn();
      results.push({ name, status: 'PASS', detail });
    } catch (error) {
      const status = error instanceof SkipError ? 'SKIP' : 'FAIL';
      results.push({ name, status, detail: status === 'SKIP' ? error.message.split('\n')[0] : error.message });
    }
  }
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  for (const result of results) {
    const detail = result.detail.replaceAll('\n', '\n         ');
    log(`  [${result.status}] ${result.name}${detail ? ` — ${detail}` : ''}`);
  }
  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  log(`e2e: ${results.length - failed - skipped} passed, ${failed} failed, ${skipped} skipped`);
  return { results, exitCode: failed ? 1 : 0 };
}
