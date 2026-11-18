// Plugin marketplace tests. Flutter authority:
// - pubspec_parse-1.6.0/lib/src/pubspec.dart:14-80
// - pubspec_parse-1.6.0/lib/src/dependency.dart:10-78
// - pubspec_parse-1.6.0/lib/src/pubspec.dart (via pub_semver) caret semantics
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import {
  compareVersions, formatPluginReport, parseRange, parseVersion, readPluginIndex,
  resolvePlugins, satisfies, validatePluginManifest, PLUGIN_INDEX_SCHEMA, PLUGIN_REPORT_SCHEMA,
} from '../lib/plugin_market.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('SemVer validation, ordering and caret ranges follow Pub rules', () => {
  assert.deepEqual(parseVersion('1.2.3'), { raw: '1.2.3', core: [1, 2, 3], prerelease: [] });
  assert.equal(parseVersion('01.2.3'), null);
  assert.equal(compareVersions('1.2.3', '1.2.10'), -1);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(satisfies('1.9.0', '^1.2.3'), true);
  assert.equal(satisfies('2.0.0', '^1.2.3'), false);
  assert.equal(satisfies('0.2.0', '^0.1.0'), false);
  assert.equal(satisfies('1.0.0-rc.1', '^1.0.0'), false);
  assert.equal(satisfies('1.0.0', 'any'), true);
  assert.equal(parseRange('>=1.0.0 <2.0.0').comparators.length, 2);
  assert.equal(parseRange('???'), null);
});

test('manifest schema validates names, versions and dependency sources', () => {
  assert.equal(validatePluginManifest({
    name: 'demo', version: '1.0.0', dependencies: { ui: '^1.0.0' },
  }).status, 'PASS');
  const invalid = validatePluginManifest({ name: 'Bad-Name', version: '1', dependencies: { ui: 42 } });
  assert.equal(invalid.status, 'FAIL');
  assert.ok(invalid.errors.some((e) => /name must match/.test(e)));
  assert.ok(invalid.errors.some((e) => /version must be/.test(e)));
  assert.ok(invalid.errors.some((e) => /invalid version constraint/.test(e)));
});

test('offline index picks highest satisfying version and reports conflicts', () => {
  const base = tmpDir('plugin-index-');
  try {
    const indexFile = path.join(base, 'index.json');
    fs.writeFileSync(indexFile, JSON.stringify({
      schema: PLUGIN_INDEX_SCHEMA,
      packages: [
        { name: 'ui', version: '1.0.0' },
        { name: 'ui', version: '1.4.0' },
        { name: 'ui', version: '2.0.0' },
        { name: 'net', version: '0.3.0' },
      ],
    }));
    const index = readPluginIndex(indexFile);
    assert.equal(index.schema, PLUGIN_INDEX_SCHEMA);
    assert.equal(index.errors.length, 0);
    const resolved = resolvePlugins({
      manifest: { name: 'demo', version: '1.0.0', dependencies: { ui: '^1.0.0' } },
      index,
    });
    assert.equal(resolved.status, 'PASS');
    assert.equal(resolved.rows[0].selected, '1.4.0');
    assert.match(formatPluginReport(resolved), /PASS ui \^1\.0\.0 -> 1\.4\.0/);

    const conflict = resolvePlugins({
      manifest: { name: 'demo', version: '1.0.0', dependencies: { ui: '^3.0.0' } },
      index,
    });
    assert.equal(conflict.status, 'FAIL');
    assert.match(conflict.errors[0], /no version satisfies/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('plugin check CLI writes JSON and exits 1 on conflict', () => {
  const base = tmpDir('plugin-cli-');
  try {
    const manifest = path.join(base, 'opurom.json');
    const index = path.join(base, 'index.json');
    const out = path.join(base, 'report.json');
    fs.writeFileSync(manifest, JSON.stringify({
      name: 'demo', version: '1.0.0', dependencies: { ui: '^1.0.0' },
    }));
    fs.writeFileSync(index, JSON.stringify({
      packages: [{ name: 'ui', version: '1.2.0' }, { name: 'ui', version: '1.5.0' }],
    }));
    const good = run(process.execPath, [CLI, 'plugin', 'check', manifest, '--index', index, '--out', out]);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).schema, PLUGIN_REPORT_SCHEMA);
    fs.writeFileSync(manifest, JSON.stringify({
      name: 'demo', version: '1.0.0', dependencies: { ui: '^9.0.0' },
    }));
    const bad = run(process.execPath, [CLI, 'plugin', 'check', manifest, '--index', index]);
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).status, 'FAIL');
    const missing = run(process.execPath, [CLI, 'plugin', 'check', manifest]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /--index/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('readPluginIndex rejects malformed index files', () => {
  const base = tmpDir('plugin-bad-');
  try {
    const file = path.join(base, 'index.json');
    fs.writeFileSync(file, '{not json');
    assert.throws(() => readPluginIndex(file), /cannot read plugin index/);
    fs.writeFileSync(file, '{}');
    assert.throws(() => readPluginIndex(file), /packages array/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
