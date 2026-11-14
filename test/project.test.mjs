import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build, projectMain } from '../lib/build.mjs';
import { init } from '../lib/init.mjs';
import { CLI_ROOT, tmpDir } from '../lib/paths.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

// The stub compiler checks every import against the filesystem, then emits the
// minimal IR and web output the real build pipeline expects.
const COMPILER = `#!/bin/sh
case "$1" in
  compile)
    src="$2"
    ir="$4"
    dir=$(dirname "$src")
    count=0
    for rel in $(sed -n 's/^import "\\([^"]*\\)".*/\\1/p' "$src"); do
      if [ ! -f "$dir/$rel" ]; then
        echo "cannot read imported module: $rel" >&2
        exit 1
      fi
      count=$((count + 1))
    done
    printf '{"ir":"0.1","app":"Project","src":"%s","imports":%s}\\n' "$src" "$count" > "$ir"
    ;;
  target)
    mkdir -p "$6"
    cp "$2" "$6/ir.json"
    printf '%s\\n' '<html>ok</html>' > "$6/index.html"
    printf '%s\\n' 'render();' > "$6/app.js"
    ;;
  *) exit 2 ;;
esac
`;

function stubWorkspace(root) {
  const dir = path.join(root, 'opurom-lang', 'target', 'debug');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'opuromc'), COMPILER, { mode: 0o755 });
}

// A CLI copy makes the sibling-binary lookup read the stub in this temp root.
function copiedCli(root) {
  const cli = path.join(root, 'opurom-cli');
  for (const dir of ['bin', 'lib', 'templates']) {
    fs.cpSync(path.join(CLI_ROOT, dir), path.join(cli, dir), { recursive: true });
  }
  return path.join(cli, 'bin', 'opurom.mjs');
}

test('projectMain resolves the app entry and names a missing one', () => {
  const base = tmpDir('project-main-');
  try {
    const project = path.join(base, 'app');
    fs.mkdirSync(project);
    assert.throws(() => projectMain(project), /project main\.opu not found:/);
    assert.throws(() => projectMain(true), /usage: --project <dir>/);
    fs.mkdirSync(path.join(project, 'main.opu'));
    assert.throws(() => projectMain(project), /project main\.opu not found:/);
    fs.rmdirSync(path.join(project, 'main.opu'));
    fs.writeFileSync(path.join(project, 'main.opu'), 'app A { }\n');
    assert.equal(projectMain(project), path.join(project, 'main.opu'));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('build --project reports a missing app entry through the CLI', () => {
  const base = tmpDir('project-cli-missing-');
  try {
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty);
    const result = spawnSync(process.execPath, [
      CLI, 'build', '--project', empty, '--target', 'web', '--out', path.join(base, 'out'),
    ], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}${result.stderr}`, /project main\.opu not found: .*main\.opu/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('a main.opu with imports enters the compile-and-lower pipeline', () => {
  const base = tmpDir('project-imports-');
  try {
    stubWorkspace(base);
    const project = path.join(base, 'app');
    fs.mkdirSync(path.join(project, 'models'), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'main.opu'),
      'import "models/a.opu"\nimport "models/b.opu"\n\napp A { state n = 0 }\n',
    );
    fs.writeFileSync(path.join(project, 'models', 'a.opu'), 'state a = 1\n');
    fs.writeFileSync(path.join(project, 'models', 'b.opu'), 'state b = 2\n');
    const out = path.join(base, 'out');
    const result = build({
      src: projectMain(project), target: 'web', out, root: base, quiet: true, log: () => {},
    });
    const ir = JSON.parse(fs.readFileSync(path.join(out, 'ir.json'), 'utf8'));
    assert.equal(ir.src, projectMain(project));
    assert.equal(ir.imports, 2);
    assert.ok(result.files.includes('index.html'));
    fs.rmSync(path.join(project, 'models', 'b.opu'));
    assert.throws(() => build({
      src: projectMain(project), target: 'web', out: path.join(base, 'out2'),
      root: base, quiet: true, log: () => {},
    }), /cannot read imported module: models\/b\.opu/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the project template scaffolds modules that build through --project', () => {
  const base = tmpDir('project-scaffold-');
  try {
    stubWorkspace(base);
    const cli = copiedCli(base);
    const project = path.join(base, 'app');
    const initialized = spawnSync(process.execPath, [
      cli, 'init', project, '--template', 'project',
    ], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /init ok:/);
    for (const rel of [
      'main.opu', 'models/todo.opu', 'views/dashboard.opu', 'README.md', 'opurom.json', '.gitignore',
    ]) {
      assert.ok(fs.existsSync(path.join(project, rel)), rel);
    }
    const config = JSON.parse(fs.readFileSync(path.join(project, 'opurom.json'), 'utf8'));
    assert.deepEqual(config.moduleRoots, ['models', 'views']);
    const main = fs.readFileSync(path.join(project, 'main.opu'), 'utf8');
    assert.match(main, /import "models\/todo\.opu"/);
    assert.match(main, /import "views\/dashboard\.opu"/);
    assert.match(fs.readFileSync(path.join(project, 'README.md'), 'utf8'), /--project/);

    const out = path.join(base, 'out');
    const built = spawnSync(process.execPath, [
      cli, 'build', '--project', project, '--target', 'web', '--out', out,
    ], { encoding: 'utf8' });
    assert.equal(built.status, 0, `${built.stdout}${built.stderr}`);
    assert.match(built.stdout, /build ok: .*main\.opu \[web\]/);
    const ir = JSON.parse(fs.readFileSync(path.join(out, 'ir.json'), 'utf8'));
    assert.equal(ir.src, path.join(project, 'main.opu'));
    assert.equal(ir.imports, 2);
    assert.ok(fs.existsSync(path.join(out, 'index.html')));

    const conflicted = spawnSync(process.execPath, [
      cli, 'build', '--project', project, '--src', path.join(project, 'main.opu'),
      '--target', 'web', '--out', path.join(base, 'unused'),
    ], { encoding: 'utf8' });
    assert.notEqual(conflicted.status, 0);
    assert.match(`${conflicted.stdout}${conflicted.stderr}`, /--src or --project, not both/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('the project template is registered alongside the single-file templates', () => {
  const base = tmpDir('project-register-');
  try {
    const project = init(path.join(base, 'demo'), { template: 'project' });
    assert.equal(fs.readFileSync(path.join(project, 'main.opu'), 'utf8'),
      fs.readFileSync(path.join(CLI_ROOT, 'templates', 'project', 'main.opu'), 'utf8'));
    assert.throws(() => init(path.join(base, 'other'), { template: 'unknown' }),
      /unknown template: unknown \(expected one of blank, counter, dashboard, fullstack, particles, project\)/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
