import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_MANIFEST, MANIFEST_ARTIFACTS, artifactManifestPath, assertFullArtifacts,
  collectArtifacts, directoryStats, formatBytes, isFullStackIr,
  planFullBuild, removeTempDir, summarizeArtifacts, syncMigrationFiles, typesFromIr,
  verifyArtifactManifest, wasmTapNodeId, writeArtifactManifest, writeSharedTypes,
} from '../lib/fullstack.mjs';
import { buildFull } from '../lib/build.mjs';
import { BUILD_TARGETS, validateBuildTarget } from '../lib/targets.mjs';
import { CLI_ROOT, tmpDir } from '../lib/paths.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('validateBuildTarget accepts emitters plus full and wasm', () => {
  assert.deepEqual([...BUILD_TARGETS].sort(), ['alipay', 'baidu', 'douyin', 'full', 'kuaishou', 'native', 'qq', 'wasm', 'web', 'wechat']);
  assert.equal(validateBuildTarget('full'), 'full');
  assert.equal(validateBuildTarget('wasm'), 'wasm');
  assert.throws(() => validateBuildTarget('wasm32'), /unknown target/);
});

test('planFullBuild chains compile, both frontends, server and migrations', () => {
  const steps = planFullBuild({
    src: '/a/main.opu',
    ir: '/out/app.opuir.json',
    out: '/out',
    root: '/ws',
    opuromc: '/bin/opuromc',
    serverc: '/bin/opurom-serverc',
    migrate: '/bin/opurom-migrate',
  });
  assert.deepEqual(steps.map((step) => step.label), [
    'compile', 'frontend-web', 'frontend-native', 'server', 'migrations',
  ]);
  assert.deepEqual(steps[0].args, ['compile', '/a/main.opu', '-o', '/out/app.opuir.json']);
  assert.deepEqual(steps[1].args, ['target', '/out/app.opuir.json', '--target', 'web', '-o', '/out/web']);
  assert.deepEqual(steps[2].args, ['target', '/out/app.opuir.json', '--target', 'native', '-o', '/out/native']);
  assert.deepEqual(steps[3].args, ['/out/app.opuir.json', '-o', '/out/server', '--dep-root', '/ws']);
  assert.equal(steps[3].cmd, '/bin/opurom-serverc');
  assert.deepEqual(steps[4].args, ['/out/app.opuir.json', '-o', '/out']);
  assert.equal(steps[4].cmd, '/bin/opurom-migrate');
});

test('planFullBuild can skip the compile step for an existing IR', () => {
  const steps = planFullBuild({
    ir: '/out/app.opuir.json', out: '/out', root: '/ws',
    opuromc: '/bin/opuromc', serverc: '/bin/s', migrate: '/bin/m',
  });
  assert.equal(steps.some((step) => step.label === 'compile'), false);
});

test('typesFromIr keeps the IR models as the only type source', () => {
  const ir = {
    ir: '0.1',
    app: 'TodoApp',
    models: [{ name: 'Todo', fields: [{ name: 'id', type: 'int', primary: true, default: null }] }],
    api: [{ path: '/todos', model: 'Todo', handlers: ['list', 'create'] }],
  };
  assert.equal(typesFromIr(ir).models.length, 1);
  assert.equal(typesFromIr(ir).api[0].path, '/todos');
  assert.equal(isFullStackIr(ir), true);
  assert.equal(isFullStackIr({ models: [], api: [] }), false);
  assert.equal(isFullStackIr({}), false);
});

test('writeSharedTypes writes one JSON file both sides can read', () => {
  const dir = tmpDir('shared-test-');
  try {
    const file = writeSharedTypes({ ir: '0.1', app: 'TodoApp', models: [{ name: 'Todo', fields: [] }], api: [] }, dir);
    assert.equal(file, path.join(dir, 'shared', 'types.json'));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(parsed.app, 'TodoApp');
    assert.equal(parsed.models[0].name, 'Todo');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertFullArtifacts names the missing pieces', () => {
  const dir = tmpDir('assert-test-');
  try {
    assert.throws(() => assertFullArtifacts(dir), /full build incomplete/);
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'index.html'), '');
    fs.mkdirSync(path.join(dir, 'native'));
    fs.writeFileSync(path.join(dir, 'native', 'Cargo.toml'), '');
    fs.mkdirSync(path.join(dir, 'server'));
    fs.writeFileSync(path.join(dir, 'server', 'Cargo.toml'), '');
    fs.mkdirSync(path.join(dir, 'migrations'));
    fs.mkdirSync(path.join(dir, 'shared'));
    fs.writeFileSync(path.join(dir, 'shared', 'types.json'), '{}');
    fs.writeFileSync(path.join(dir, 'app.opuir.json'), '{}');
    assert.doesNotThrow(() => assertFullArtifacts(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact summary reports real file counts and byte sizes', () => {
  const dir = tmpDir('stats-test-');
  try {
    fs.mkdirSync(path.join(dir, 'web'));
    fs.writeFileSync(path.join(dir, 'web', 'a.js'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(dir, 'web', 'b.js'), 'y'.repeat(10));
    const stats = directoryStats(path.join(dir, 'web'));
    assert.equal(stats.files, 2);
    assert.equal(stats.bytes, 2058);
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KiB');
    const summary = summarizeArtifacts(collectArtifacts(dir, ['web']));
    assert.match(summary, /web: 2 files, 2\.0 KiB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('removeTempDir refuses paths outside the CLI temp directory', () => {
  assert.throws(() => removeTempDir('/tmp'), /refusing to remove non-temp path/);
  assert.throws(() => removeTempDir(CLI_ROOT), /refusing to remove non-temp path/);
  const dir = tmpDir('rm-test-');
  assert.equal(removeTempDir(dir), path.resolve(dir));
  assert.equal(fs.existsSync(dir), false);
});

test('wasmTapNodeId finds the node that increments an int state', () => {
  const ir = {
    tree: {
      id: 0,
      kind: 'Column',
      children: [
        { id: 1, kind: 'Text', children: [], events: {} },
        { id: 2, kind: 'Button', children: [], events: { tap: { op: 'add', target: 'count', value: 1 } } },
      ],
    },
  };
  assert.equal(wasmTapNodeId(ir), 2);
  assert.equal(wasmTapNodeId({ tree: { id: 0, children: [] } }), null);
});

test('syncMigrationFiles puts the SQL next to the generated crate', () => {
  const dir = tmpDir('sync-test-');
  try {
    fs.mkdirSync(path.join(dir, 'migrations'));
    fs.writeFileSync(path.join(dir, 'migrations', '001_create_todo.sql'), 'CREATE TABLE Todo(id INT);');
    fs.mkdirSync(path.join(dir, 'server'));
    const files = syncMigrationFiles(dir);
    assert.deepEqual(files, ['001_create_todo.sql']);
    assert.ok(fs.existsSync(path.join(dir, 'server', 'migrations', '001_create_todo.sql')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fullOutputFixture(dir) {
  fs.mkdirSync(path.join(dir, 'web'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web', 'index.html'), '<html>ok</html>\n');
  fs.mkdirSync(path.join(dir, 'native'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'native', 'Cargo.toml'), '[package]\n');
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'Cargo.toml'), '[package]\n');
  fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'migrations', '001_create_todo.sql'), 'CREATE TABLE Todo(id INT);\n');
  fs.mkdirSync(path.join(dir, 'shared'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'shared', 'types.json'), '{}\n');
  fs.writeFileSync(path.join(dir, 'app.opuir.json'), '{}\n');
}

test('artifact manifest lists every expected artifact with measured sizes', () => {
  const dir = tmpDir('manifest-test-');
  try {
    fullOutputFixture(dir);
    const { file, manifest } = writeArtifactManifest(dir);
    assert.equal(file, path.join(dir, ARTIFACT_MANIFEST));
    assert.equal(file, artifactManifestPath(dir));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.target, 'full');
    assert.deepEqual(manifest.artifacts.map((entry) => entry.path), [...MANIFEST_ARTIFACTS]);
    const paths = manifest.files.map((entry) => entry.path);
    assert.deepEqual(paths, [...paths].sort());
    for (const name of [
      'web/index.html', 'server/Cargo.toml', 'migrations/001_create_todo.sql',
      'shared/types.json', 'app.opuir.json',
    ]) {
      const entry = manifest.files.find((item) => item.path === name);
      const bytes = fs.readFileSync(path.join(dir, name));
      assert.ok(entry, `manifest omits ${name}`);
      assert.equal(entry.bytes, bytes.length);
      assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'));
    }
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), manifest);
    assert.deepEqual(verifyArtifactManifest(dir), manifest);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact manifest check names missing artifacts and files', () => {
  const dir = tmpDir('manifest-missing-');
  try {
    fullOutputFixture(dir);
    writeArtifactManifest(dir);
    fs.rmSync(path.join(dir, 'web', 'index.html'));
    assert.throws(() => verifyArtifactManifest(dir),
      /artifact manifest check failed.*missing file web\/index\.html/);
    fs.rmSync(path.join(dir, 'shared'), { recursive: true, force: true });
    assert.throws(() => verifyArtifactManifest(dir), /missing artifact shared/);
    fs.rmSync(artifactManifestPath(dir));
    assert.throws(() => verifyArtifactManifest(dir), /artifact manifest not found/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact manifest check detects tampering that preserves the byte count', () => {
  const dir = tmpDir('manifest-tamper-');
  try {
    fullOutputFixture(dir);
    const { manifest } = writeArtifactManifest(dir);
    const file = path.join(dir, 'shared', 'types.json');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, '[]\n');
    assert.equal(fs.statSync(file).size,
      manifest.files.find((entry) => entry.path === 'shared/types.json').bytes);
    assert.throws(() => verifyArtifactManifest(dir), /tampered file shared\/types\.json/);
    fs.writeFileSync(file, original);
    assert.doesNotThrow(() => verifyArtifactManifest(dir));
    fs.writeFileSync(artifactManifestPath(dir), '{ not json');
    assert.throws(() => verifyArtifactManifest(dir), /corrupt artifact manifest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact manifest check rejects tampered manifest entries', () => {
  const dir = tmpDir('manifest-guard-');
  try {
    fullOutputFixture(dir);
    const file = artifactManifestPath(dir);
    const { manifest } = writeArtifactManifest(dir);
    manifest.files[0].path = '../outside';
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyArtifactManifest(dir), /file path escapes output directory/);
    manifest.files[0].path = 'web/index.html';
    manifest.artifacts.shift();
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => verifyArtifactManifest(dir), /missing artifact web in manifest/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function stubBinary(root, repo, name, body) {
  const dir = path.join(root, repo, 'target', 'release');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

test('build --target full emits the manifest and the CLI verifies it', () => {
  const root = tmpDir('full-manifest-');
  try {
    stubBinary(root, 'opurom-lang', 'opuromc', `case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1","app":"TodoApp","models":[{"name":"Todo","fields":[]}],"api":[{"path":"/todos"}],"tree":{}}' > "$4" ;;
  target)
    mkdir -p "$6"
    if [ "$4" = web ]; then printf '%s\\n' '<html>ok</html>' > "$6/index.html"; fi
    if [ "$4" = native ]; then printf '%s\\n' '[package]' > "$6/Cargo.toml"; fi
    ;;
  *) exit 2 ;;
esac`);
    stubBinary(root, 'opurom-server', 'opurom-serverc', `mkdir -p "$3"
printf '%s\\n' '[package]' > "$3/Cargo.toml"
printf '%s\\n' 'fn main() {}' > "$3/main.rs"`);
    stubBinary(root, 'opurom-db', 'opurom-migrate', `mkdir -p "$3/migrations"
printf '%s\\n' 'CREATE TABLE Todo(id INT);' > "$3/migrations/001_create_todo.sql"`);
    const src = path.join(root, 'main.opu');
    fs.writeFileSync(src, 'app TodoApp { }\n');
    const out = path.join(root, 'out');
    buildFull({ src, out, root, quiet: true, log: () => {} });
    const file = artifactManifestPath(out);
    assert.ok(fs.existsSync(file), 'build --target full did not emit a manifest');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(manifest.artifacts.map((entry) => entry.path), [...MANIFEST_ARTIFACTS]);
    assert.equal(verifyArtifactManifest(out).target, 'full');
    const clean = spawnSync(process.execPath, [CLI, 'verify', '--out', out], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /manifest ok:/);
    fs.writeFileSync(path.join(out, 'web', 'index.html'), '<html>bad</html>\n');
    const tampered = spawnSync(process.execPath, [CLI, 'verify', '--out', out], { encoding: 'utf8' });
    assert.notEqual(tampered.status, 0);
    assert.match(`${tampered.stdout}${tampered.stderr}`,
      /artifact manifest check failed.*tampered file web\/index\.html/);
    fs.rmSync(path.join(out, 'shared', 'types.json'));
    const missing = spawnSync(process.execPath, [CLI, 'verify', '--out', out], { encoding: 'utf8' });
    assert.notEqual(missing.status, 0);
    assert.match(`${missing.stdout}${missing.stderr}`, /missing file shared\/types\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
