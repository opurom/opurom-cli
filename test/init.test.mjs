import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { discoverBinary, tmpDir } from '../lib/paths.mjs';
import { TEMPLATES, init } from '../lib/init.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));
const INIT_SOURCE = new URL('../lib/init.mjs', import.meta.url);

function cli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
}

function snapshot(dir, root = dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...snapshot(full, root));
    else files.push([path.relative(root, full), fs.readFileSync(full).toString('base64')]);
  }
  return files;
}

function entryFor(project, template) {
  if (template === 'project') return path.join(project, 'main.opu');
  return path.join(project, 'src', template === 'particles' ? 'particles.opu' : 'main.opu');
}

test('init scaffolds a branded project and refuses to overwrite non-empty dirs', () => {
  const base = tmpDir('init-test-');
  const project = path.join(base, 'demo');
  try {
    assert.equal(init(project), project);
    assert.deepEqual(fs.readdirSync(project).sort(), [
      '.gitignore', 'README.md', 'favicon.ico', 'index.html', 'logo.png', 'opurom.json', 'src',
    ]);
    const config = JSON.parse(fs.readFileSync(path.join(project, 'opurom.json'), 'utf8'));
    assert.equal(config.name, 'demo');
    assert.equal(config.targets.length, 8);
    assert.match(fs.readFileSync(path.join(project, 'src', 'main.opu'), 'utf8'), /app Counter/);

    const png = fs.readFileSync(path.join(project, 'logo.png'));
    const ico = fs.readFileSync(path.join(project, 'favicon.ico'));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 128);
    assert.equal(png.readUInt32BE(20), 128);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 1);
    assert.equal(ico[6], 128);
    assert.equal(ico[7], 128);
    assert.equal(ico.readUInt32LE(14), png.length);
    assert.equal(ico.readUInt32LE(18), 22);
    assert.deepEqual(ico.subarray(22), png);
    assert.match(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), /logo\.png/);
    assert.match(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), /favicon\.ico/);
    assert.match(fs.readFileSync(path.join(project, 'index.html'), 'utf8'), /rel="icon"[^>]*favicon\.ico/);

    const source = fs.readFileSync(INIT_SOURCE, 'utf8');
    assert.match(source, /base64/);
    assert.doesNotMatch(source, /opurom-logo/);
    assert.throws(() => init(project), /refusing to overwrite non-empty directory/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the particles template scaffolds a seeded particle field that the default omits', () => {
  const base = tmpDir('init-particles-');
  const project = path.join(base, 'field');
  try {
    assert.deepEqual([...TEMPLATES], [
      'blank', 'counter', 'dashboard', 'fullstack', 'particles', 'project',
    ]);
    assert.equal(init(project, { template: 'particles' }), project);
    const source = fs.readFileSync(path.join(project, 'src', 'particles.opu'), 'utf8');
    assert.match(source, /app Particles/);
    assert.match(source, /particles: "count=64,seed=7/);
    assert.match(source, /animate: spring/);
    assert.doesNotMatch(source, /app Counter/);
    assert.throws(() => init(path.join(base, 'other'), { template: 'unknown' }),
      /unknown template: unknown/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('init --list prints the registered names deterministically', () => {
  const first = cli(['init', '--list']);
  const second = cli(['init', '--list']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(first.stdout, `${TEMPLATES.join('\n')}\n`);
  assert.equal(second.stdout, first.stdout);
});

test('invalid template names produce a clear CLI error', () => {
  const base = tmpDir('init-cli-errors-');
  try {
    const unknown = cli(['init', path.join(base, 'unknown'), '--template', 'unknown']);
    assert.notEqual(unknown.status, 0);
    assert.match(`${unknown.stdout}${unknown.stderr}`,
      new RegExp(`unknown template: unknown \\(expected one of ${TEMPLATES.join(', ')}\\)`));
    const missing = cli(['init', path.join(base, 'missing'), '--template']);
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /missing required option --template/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('every template writes distinct sources and brand references', () => {
  const base = tmpDir('init-templates-');
  try {
    const signatures = new Set();
    for (const name of TEMPLATES) {
      const project = init(path.join(base, name), { template: name });
      const sources = snapshot(project)
        .filter(([relative]) => relative.endsWith('.opu'))
        .map(([relative, bytes]) => `${relative}:${bytes}`)
        .join('\n');
      signatures.add(sources);
      for (const file of ['logo.png', 'favicon.ico', 'index.html']) {
        assert.ok(fs.existsSync(path.join(project, file)), `${name}: ${file}`);
      }
      const readme = fs.readFileSync(path.join(project, 'README.md'), 'utf8');
      assert.match(readme, /logo\.png/, name);
      assert.match(readme, /favicon\.ico/, name);
    }
    assert.equal(signatures.size, TEMPLATES.length);
    assert.match(fs.readFileSync(path.join(base, 'blank', 'src', 'main.opu'), 'utf8'), /app Blank/);
    assert.match(fs.readFileSync(path.join(base, 'dashboard', 'src', 'main.opu'), 'utf8'), /app Dashboard/);
    assert.match(fs.readFileSync(path.join(base, 'dashboard', 'src', 'main.opu'), 'utf8'), /theme/);
    assert.match(fs.readFileSync(path.join(base, 'fullstack', 'src', 'main.opu'), 'utf8'), /model Task/);
    assert.match(fs.readFileSync(path.join(base, 'fullstack', 'src', 'main.opu'), 'utf8'), /api "\/tasks"/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('init output is byte-identical across two runs for every template', () => {
  const base = tmpDir('init-determinism-');
  try {
    for (const name of TEMPLATES) {
      const firstParent = path.join(base, 'first', name);
      const secondParent = path.join(base, 'second', name);
      fs.mkdirSync(firstParent, { recursive: true });
      fs.mkdirSync(secondParent, { recursive: true });
      const first = init(path.join(firstParent, 'demo'), { template: name });
      const second = init(path.join(secondParent, 'demo'), { template: name });
      assert.deepEqual(snapshot(first), snapshot(second), name);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('every template entry passes a real opuromc check when the compiler is installed', (t) => {
  const compiler = discoverBinary(['opuromc'], { repo: 'opurom-lang' });
  if (!compiler) {
    t.skip('opuromc unavailable: no executable in opurom-lang/target/{debug,release} or PATH');
    return;
  }
  const base = tmpDir('init-compiler-');
  try {
    for (const name of TEMPLATES) {
      const project = init(path.join(base, name), { template: name });
      const result = spawnSync(compiler, ['check', entryFor(project, name)], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
