// Flutter config/multi-env parity tests. Source anchors in lib/config.mjs header.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import {
  BUILD_MODES, applyConfigOptions, buildEnvironmentArgs, buildInfoFor, configCommand,
  createSettings, environmentProcessEnv, formatDefines, formatSettings, globalSettings,
  globalSettingsPath, parseBuildMode, parseCliDefines, parseEnvFile, projectSettingsPath,
  readDefineFile, resolveEnvironment,
} from '../lib/config.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

function isolatedEnv(base = tmpDir('config-test-')) {
  return { ...process.env, OPUR_CONFIG: path.join(base, 'config') };
}

function cli(args, { cwd = process.cwd(), env = process.env } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, env, encoding: 'utf8' });
}

test('settings store writes indented JSON, removes keys and clears invalid files', () => {
  const base = tmpDir('settings-');
  try {
    const file = path.join(base, 'nested', 'settings.json');
    const settings = createSettings(file);
    assert.deepEqual(settings.keys(), []);
    settings.setValue('android-sdk', '/opt/sdk');
    settings.setValue('build-dir', 'out/');
    assert.equal(fs.readFileSync(file, 'utf8'), `${JSON.stringify({
      'android-sdk': '/opt/sdk', 'build-dir': 'out/',
    }, null, 2)}\n`);
    settings.removeValue('android-sdk');
    assert.deepEqual(settings.all(), { 'build-dir': 'out/' });
    settings.clear();
    assert.deepEqual(settings.all(), {});

    fs.writeFileSync(file, '{not json');
    const recovered = createSettings(file);
    assert.deepEqual(recovered.all(), {});
    assert.equal(fs.existsSync(file), false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('config command applies empty-value removals and machine output', () => {
  const base = tmpDir('config-command-');
  const env = isolatedEnv(base);
  try {
    const writes = [];
    const first = configCommand({
      options: { 'android-sdk': '/opt/sdk', 'build-dir': 'out/' },
      env, cwd: base, log: (line) => writes.push(line),
    });
    assert.equal(first.code, 0);
    assert.deepEqual(writes, [
      'Setting "android-sdk" value to "/opt/sdk".',
      'Setting "build-dir" value to "out/".',
      'You may need to restart any open editors for them to read new settings.',
    ]);
    const listed = [];
    configCommand({ list: true, env, cwd: base, log: (line) => listed.push(line) });
    assert.equal(listed[0], 'All Settings:\n  android-sdk: /opt/sdk\n  build-dir: out/');

    const machine = [];
    configCommand({ machine: true, env, cwd: base, log: (line) => machine.push(line) });
    assert.deepEqual(JSON.parse(machine.join('\n')), {
      'android-sdk': '/opt/sdk', 'build-dir': 'out/',
    });

    const removed = [];
    configCommand({ options: { 'android-sdk': '' }, env, cwd: base, log: (line) => removed.push(line) });
    assert.deepEqual(removed, [
      'Removing "android-sdk" value.',
      'You may need to restart any open editors for them to read new settings.',
    ]);
    assert.equal(globalSettings(env).getValue('android-sdk'), undefined);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('config CLI writes to XDG-compatible path and project override file', () => {
  const base = tmpDir('config-cli-');
  const env = { ...process.env, OPUR_CONFIG: path.join(base, 'xdg') };
  try {
    const project = path.join(base, 'demo');
    fs.mkdirSync(project, { recursive: true });
    const set = cli(['config', '--android-sdk', '/opt/sdk', '--build-dir', 'out/'], { cwd: project, env });
    assert.equal(set.status, 0, set.stderr);
    assert.match(set.stdout, /Setting "android-sdk" value to "\/opt\/sdk"\./);
    assert.equal(globalSettings(env).getValue('build-dir'), 'out/');
    assert.equal(globalSettingsPath({ env }), path.join(base, 'xdg', 'settings.json'));

    fs.mkdirSync(path.join(project, '.opurom'), { recursive: true });
    fs.writeFileSync(projectSettingsPath(project, { env }), JSON.stringify({ 'build-dir': 'project-out/' }));
    const list = cli(['config', '--list'], { cwd: project, env });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /Project Settings:/);
    assert.match(list.stdout, /build-dir: project-out\//);
    const machine = cli(['config', '--machine'], { cwd: project, env });
    assert.equal(JSON.parse(machine.stdout)['build-dir'], 'project-out/');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('parseEnvFile follows Flutter quoting and comment rules', () => {
  const values = parseEnvFile([
    '# comment',
    'API_URL=https://example.com/v1',
    'TOKEN="foo#bar=baz"',
    "QUOTED='hello world' # note",
    'BACK=`tick value`',
    'EMPTY=',
    'EQUALS=a=b',
    '  SPACED = spaced value  ',
  ].join('\n'), 'test.env');
  assert.deepEqual(values, {
    API_URL: 'https://example.com/v1',
    TOKEN: 'foo#bar=baz',
    QUOTED: 'hello world',
    BACK: 'tick value',
    EMPTY: '',
    EQUALS: 'a=b',
    SPACED: 'spaced value',
  });
  assert.throws(() => parseEnvFile('BAD LINE', 'bad.env'), /invalid env line/);
  assert.throws(() => parseEnvFile('X="""multi', 'bad.env'), /multiline env values/);
});

test('readDefineFile accepts JSON and .env, resolveEnvironment merges in Flutter order', () => {
  const base = tmpDir('env-order-');
  const env = isolatedEnv(base);
  const project = path.join(base, 'demo');
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, '.env'), 'API_URL=fallback\nLOCAL=from-dot-env\n');
    fs.writeFileSync(path.join(project, '.env.staging'), [
      'API_URL=from-staging',
      'DATABASE_URL=postgres://staging',
      'STAGING_ONLY=1',
    ].join('\n'));
    const explicit = path.join(project, 'extra.json');
    fs.writeFileSync(explicit, JSON.stringify({ API_URL: 'from-explicit', EXPLICIT: 'yes' }));

    globalSettings(env).setValue('environments', {
      staging: { API_URL: 'from-global', GLOBAL: 'yes' },
    });
    fs.writeFileSync(projectSettingsPath(project, { env }), JSON.stringify({
      environments: {
        staging: { API_URL: 'from-project', PROJECT: 'yes' },
      },
    }));

    const resolved = resolveEnvironment({
      cwd: project, envName: 'staging', env,
      defineFromFile: [explicit],
      dartDefine: ['API_URL=from-cli', 'CLI_ONLY=1'],
    });
    assert.deepEqual(resolved.defines, {
      LOCAL: 'from-dot-env',
      API_URL: 'from-cli',
      DATABASE_URL: 'postgres://staging',
      STAGING_ONLY: '1',
      EXPLICIT: 'yes',
      GLOBAL: 'yes',
      PROJECT: 'yes',
      CLI_ONLY: '1',
      Environment: 'staging',
    });
    assert.deepEqual(resolved.entries, formatDefines(resolved.defines));
    assert.deepEqual(buildEnvironmentArgs(resolved), [
      '--dart-define', 'API_URL=from-cli',
      '--dart-define', 'CLI_ONLY=1',
      '--dart-define', 'DATABASE_URL=postgres://staging',
      '--dart-define', 'EXPLICIT=yes',
      '--dart-define', 'Environment=staging',
      '--dart-define', 'GLOBAL=yes',
      '--dart-define', 'LOCAL=from-dot-env',
      '--dart-define', 'PROJECT=yes',
      '--dart-define', 'STAGING_ONLY=1',
    ]);
    const runtime = environmentProcessEnv(resolved, { PATH: '/usr/bin' });
    assert.equal(runtime.OPR_ENV, 'staging');
    assert.equal(runtime.OPR_DEFINE_API_URL, 'from-cli');
    assert.equal(runtime.PATH, '/usr/bin');
    assert.deepEqual(readDefineFile(explicit), { API_URL: 'from-explicit', EXPLICIT: 'yes' });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('--dart-define parsing rejects malformed entries and keeps equals in values', () => {
  assert.deepEqual(parseCliDefines(['A=1', 'B=x=y', 'C=']), { A: '1', B: 'x=y', C: '' });
  assert.throws(() => parseCliDefines(['NO_EQUALS']), /expected KEY=VALUE/);
  assert.throws(() => parseCliDefines(['=value']), /expected KEY=VALUE/);
});

test('build modes match Flutter BuildMode cliName and reserve defines', () => {
  assert.deepEqual(BUILD_MODES, ['debug', 'profile', 'release']);
  assert.equal(parseBuildMode(undefined), 'release');
  assert.equal(parseBuildMode(true), 'release');
  assert.equal(parseBuildMode('release'), 'release');
  assert.throws(() => parseBuildMode('jit-release'), /invalid --mode/);
  const info = buildInfoFor({
    mode: 'profile', target: 'web-dom',
    environment: { name: 'staging', defines: { API_URL: 'x', Environment: 'staging' } },
  });
  assert.equal(info.isProfile, true);
  assert.equal(info.isRelease, false);
  assert.deepEqual(info.entries, [
    'API_URL=x', 'BuildMode=profile', 'Environment=staging', 'TargetFile=web-dom',
  ]);
  for (const key of ['BuildMode', 'TargetPlatform', 'TargetFile', 'DartDefines']) {
    assert.throws(() => buildInfoFor({ environment: { defines: { [key]: 'reserved' } } }),
      /reserved --dart-define key/);
  }
});

test('check CLI forwards build defines and rejects invalid mode', () => {
  const base = tmpDir('check-define-');
  const env = isolatedEnv(base);
  const project = path.join(base, 'demo');
  try {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'main.opu'), 'app Test\n');
    const invalid = cli(['check', 'main.opu', '--mode', 'fast'], { cwd: project, env });
    assert.notEqual(invalid.status, 0);
    assert.match(invalid.stderr, /invalid --mode/);
    const badDefine = cli(['check', 'main.opu', '--dart-define', 'NOPE'], { cwd: project, env });
    assert.notEqual(badDefine.status, 0);
    assert.match(badDefine.stderr, /expected KEY=VALUE/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('build resolves --project main.opu from the given project directory', () => {
  const base = tmpDir('build-project-');
  try {
    const project = path.join(base, 'demo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'main.opu'), 'app Demo\n');
    const missing = cli(['build', '--project', path.join(base, 'absent'), '--target', 'web', '--out', path.join(base, 'out')]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr + missing.stdout, /project main\.opu not found/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
