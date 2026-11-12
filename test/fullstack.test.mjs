import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assertFullArtifacts, collectArtifacts, directoryStats, formatBytes, isFullStackIr,
  planFullBuild, removeTempDir, summarizeArtifacts, syncMigrationFiles, typesFromIr, wasmTapNodeId,
  writeSharedTypes,
} from '../lib/fullstack.mjs';
import { BUILD_TARGETS, validateBuildTarget } from '../lib/targets.mjs';
import { CLI_ROOT, tmpDir } from '../lib/paths.mjs';

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
