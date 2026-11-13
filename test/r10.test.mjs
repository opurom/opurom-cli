import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { SourceMap } from 'node:module';
import { fileURLToPath } from 'node:url';
import { flagEnabled, parseArgs } from '../lib/args.mjs';
import { build } from '../lib/build.mjs';
import { tmpDir } from '../lib/paths.mjs';
import { finalizeBuild, formatSizeReport, sizeBytes, sizeReport } from '../lib/r6.mjs';
import {
  analyzeReachability, buildSourceMap, formatTreeShakeTable, R10_TRANSFORMS, treeShakeJs,
} from '../lib/r10.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));
const FIXTURES = new URL('./fixtures/r6/', import.meta.url);
const TARGET_FIXTURES = [
  'web-app.js.fixture', 'wechat-index.js.fixture', 'alipay-index.js.fixture', 'qq-index.js.fixture',
  'douyin-index.js.fixture', 'baidu-index.js.fixture', 'kuaishou-index.js.fixture', 'wasm-host.js.fixture',
];
const CHECK_DIR = tmpDir('r10-check-');

const STUB_LINES = [
  '// generated header',
  'const state = {"count":0};',
  'function render() {',
  '  return state.count;',
  '}',
  'function unused() {',
  '  return 42;',
  '}',
  'const literal = "function unused() {} dead();";',
  'render();',
  '',
];
const STUB_JS = `${STUB_LINES.join('\n')}\n`;

const REACHABILITY_FIXTURE = [
  '"use strict";',
  'function used() { helper(); }',
  'function helper() { return 1; }',
  'function recursiveA(n) { return n > 0 ? recursiveB(n - 1) : 0; }',
  'function recursiveB(n) { return n > 0 ? recursiveA(n - 1) : recursiveB(0); }',
  'function unused() { return 2; }',
  'function shadowed() { const used = 1; return used; }',
  'function fromTemplate() { return 3; }',
  'const literal = "function unused() {} dead();";',
  'const regex = /function unused\\(\\) \\{\\}/;',
  'const keys = { unused: 1, helper: 2, shadowed: 3 };',
  'const template = `total: ${fromTemplate()}`;',
  'used();',
  'recursiveA(2);',
  '',
].join('\n');

function nodeCheck(source, name) {
  const file = path.join(CHECK_DIR, `${name.replace(/[^a-z0-9-]/gi, '_')}.js`);
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  return file;
}

function shQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function compilerStub(binDir, logFile) {
  fs.mkdirSync(binDir, { recursive: true });
  const emitArgs = STUB_LINES.map(shQuote).join(' ');
  fs.writeFileSync(path.join(binDir, 'opuromc'), `#!/bin/sh
printf '%s\\n' "$*" >> '${logFile}'
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4" ;;
  optimize) cp "$2" "$4" ;;
  targets)
    printf '%s\\n' 'native\tCargo.toml, src/main.rs'
    printf '%s\\n' 'web\tindex.html, app.js, ir.json'
    printf '%s\\n' 'wechat\tapp.json, index.wxml, index.wxss, index.js'
    ;;
  target)
    mkdir -p "$6"
    cp "$2" "$6/ir.json"
    printf '%s\\n' '<html><head></head></html>' > "$6/index.html"
    printf '%s\\n' ${emitArgs} > "$6/app.js"
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return path.join(binDir, 'opuromc');
}

function stubWorkspace() {
  const base = tmpDir('r10-stub-');
  const binDir = path.join(base, 'bin');
  const src = path.join(base, 'main.opu');
  fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
  return { base, binDir, src, opuromc: compilerStub(binDir, path.join(base, 'opuromc.log')) };
}

async function withStubPath(binDir, fn) {
  const oldPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ''}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = oldPath;
  }
}

test('R10 flags parse as booleans and are advertised in CLI help', () => {
  const { flags } = parseArgs(['build', '--tree-shake', '--sourcemap', '--minify', '--optimize=false']);
  assert.equal(flagEnabled(flags, 'tree-shake'), true);
  assert.equal(flagEnabled(flags, 'sourcemap'), true);
  assert.equal(flagEnabled(flags, 'minify'), true);
  assert.equal(flagEnabled(flags, 'optimize'), false);
  const disabled = parseArgs(['build', '--tree-shake=0', '--sourcemap=no']).flags;
  assert.equal(flagEnabled(disabled, 'tree-shake'), false);
  assert.equal(flagEnabled(disabled, 'sourcemap'), false);
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--tree-shake/);
  assert.match(help.stdout, /--sourcemap/);
});

test('reachability keeps used, recursive and template references, removes unused', () => {
  const analysis = analyzeReachability(REACHABILITY_FIXTURE);
  assert.deepEqual([...analysis.reachable].sort(), [
    'fromTemplate', 'helper', 'recursiveA', 'recursiveB', 'used',
  ]);
  assert.deepEqual(analysis.removed.map((declaration) => declaration.name), ['unused', 'shadowed']);

  const result = treeShakeJs(REACHABILITY_FIXTURE, 'app.js');
  nodeCheck(result.code, 'reachability');
  assert.deepEqual(result.removed.map((entry) => entry.name), ['unused', 'shadowed']);
  assert.ok(result.removed.every((entry) => entry.bytes > 0 && entry.file === 'app.js'));
  for (const name of ['used', 'helper', 'recursiveA', 'recursiveB', 'fromTemplate']) {
    assert.match(result.code, new RegExp(`function ${name}\\(`), `${name} declaration was removed`);
  }
  assert.doesNotMatch(result.code, /function unused\(\) \{ return 2; \}/);
  assert.doesNotMatch(result.code, /function shadowed\(\) \{/);
  assert.match(result.code, /const literal = "function unused\(\) \{\} dead\(\);";/, 'string lookalike changed');
  assert.match(result.code, /const regex = \/function unused/, 'regex lookalike changed');
  assert.match(result.code, /const keys = \{ unused: 1, helper: 2, shadowed: 3 \};/, 'object keys changed');
  assert.match(result.code, /const template = `total: \$\{fromTemplate\(\)\}`;/, 'template interpolation changed');
});

test('tree shaking keeps every real emitter fixture valid JS', () => {
  for (const name of TARGET_FIXTURES) {
    const source = fs.readFileSync(new URL(name, FIXTURES), 'utf8');
    const result = treeShakeJs(source, name);
    nodeCheck(result.code, `shake-${name}`);
  }
  const web = treeShakeJs(fs.readFileSync(new URL('web-app.js.fixture', FIXTURES), 'utf8'), 'app.js');
  assert.deepEqual(web.removed.map((entry) => entry.name), ['applyInput']);
  const wasm = treeShakeJs(fs.readFileSync(new URL('wasm-host.js.fixture', FIXTURES), 'utf8'), 'host.js');
  assert.deepEqual(wasm.removed.map((entry) => entry.name), ['applyInput']);
  assert.match(wasm.code, /function hitTest\(/, 'recursive hitTest was removed');
  assert.match(wasm.code, /function boot\(/, 'boot was removed');
});

test('source map v3 shape parses with node:module SourceMap', () => {
  const source = '// header\nfunction render() {\n  return 1;\n}\nrender();\n';
  const generated = 'function render() {\nreturn 1;\n}\nrender();\n';
  const map = buildSourceMap({ file: 'app.js', source, generated });
  assert.equal(map.version, 3);
  assert.equal(map.file, 'app.js');
  assert.deepEqual(map.sources, ['app.js']);
  assert.equal(map.sourcesContent[0], source);
  assert.ok(Array.isArray(map.names) && map.names.includes('render'));
  assert.equal(typeof map.mappings, 'string');
  assert.ok(map.mappings.includes(';'));
  assert.match(map.x_opurom_accuracy, /not line-exact or column-exact/);
  const parsed = new SourceMap(map);
  const first = parsed.findEntry(0, 0);
  assert.equal(first.generatedLine, 0);
  assert.equal(first.generatedColumn, 0);
  assert.equal(first.originalSource, 'app.js');
  assert.equal(first.originalLine, 1);
  const call = parsed.findEntry(3, 0);
  assert.equal(call.originalLine, 4);
  assert.equal(call.name, 'render');
});

test('all 16 optimize/minify/tree-shake/sourcemap combinations compose', async () => {
  const { base, binDir, src } = stubWorkspace();
  try {
    await withStubPath(binDir, async () => {
      let index = 0;
      for (const optimize of [false, true]) {
        for (const minify of [false, true]) {
          for (const treeShake of [false, true]) {
            for (const sourcemap of [false, true]) {
              const out = path.join(base, `out-${index++}`);
              const result = build({
                src, target: 'web', out, root: base, quiet: true, log: () => {},
                optimize, minify, treeShake, sourcemap,
              });
              const appFile = path.join(out, 'app.js');
              execFileSync(process.execPath, ['--check', appFile], { stdio: 'pipe' });
              const code = fs.readFileSync(appFile, 'utf8');
              const any = minify || treeShake || sourcemap;
              assert.equal('optimization' in result, optimize);
              assert.equal('minification' in result, any);
              assert.equal(minify, !code.includes('// generated header'));
              assert.equal(treeShake, !/function unused\(\) \{\s*return 42;\s*\}/.test(code));
              assert.match(code, /const literal = "function unused\(\) \{\} dead\(\);";/);
              assert.equal(sourcemap, code.includes('//# sourceMappingURL=app.js.map'));

              const mapFile = path.join(out, 'app.js.map');
              assert.equal(fs.existsSync(mapFile), sourcemap);
              if (sourcemap) {
                const map = JSON.parse(fs.readFileSync(mapFile, 'utf8'));
                assert.equal(map.version, 3);
                assert.equal(map.file, 'app.js');
                assert.ok(map.sources.length && Array.isArray(map.names) && typeof map.mappings === 'string');
                assert.ok(new SourceMap(map).findEntry(0, 0));
                assert.equal(result.minification.sourceMaps[0].bytes, fs.statSync(mapFile).size);
              }
              if (treeShake) {
                assert.deepEqual(result.minification.removedFunctions.map((entry) => entry.name), ['unused']);
              }
              if (any) {
                assert.equal(result.minification.after.get('app.js'), fs.statSync(appFile).size);
                const beforeTotal = [...result.minification.before.values()].reduce((sum, n) => sum + n, 0);
                const afterTotal = [...result.minification.after.values()].reduce((sum, n) => sum + n, 0);
                assert.match(result.minification.report,
                  new RegExp(`before ${beforeTotal} B -> after ${afterTotal} B`));
                assert.equal(sizeReport({ dir: out, log: () => {} }), result.minification.report);
              }
            }
          }
        }
      }
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('default build stays byte-identical and creates no R10 artifacts', async () => {
  const { base, binDir, src } = stubWorkspace();
  try {
    await withStubPath(binDir, async () => {
      const first = build({ src, target: 'web', out: path.join(base, 'default-a'), root: base, quiet: true });
      const second = build({ src, target: 'web', out: path.join(base, 'default-b'), root: base, quiet: true });
      assert.equal('minification' in first, false);
      assert.equal('optimization' in first, false);
      for (const name of ['app.js', 'index.html', 'ir.json']) {
        assert.equal(
          fs.readFileSync(path.join(first.out, name), 'utf8'),
          fs.readFileSync(path.join(second.out, name), 'utf8'),
          `${name} changed between default builds`,
        );
      }
      assert.equal(fs.readFileSync(path.join(first.out, 'app.js'), 'utf8'), STUB_JS);
      assert.equal(fs.existsSync(path.join(first.out, '.opurom-size.json')), false);
      assert.equal(fs.existsSync(path.join(first.out, 'app.js.map')), false);
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('tree shake reports exact functions/assets and size repeats the measurement', async () => {
  const { base, opuromc } = stubWorkspace();
  try {
    const out = path.join(base, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, 'app.js'), STUB_JS);
    fs.writeFileSync(path.join(out, 'index.html'), '<html></html>\n');
    fs.writeFileSync(path.join(out, 'ir.json'), '{}\n');
    fs.writeFileSync(path.join(out, 'app.json'), '{"pages":[]}\n');
    fs.writeFileSync(path.join(out, 'index.js'), '// stale\nPage({});\n');
    fs.writeFileSync(path.join(out, 'notes.txt'), 'keep me\n');
    const staleIndexBytes = fs.statSync(path.join(out, 'index.js')).size;
    const lines = [];
    const result = finalizeBuild({
      out, target: 'web', opuromc, minify: false, treeShake: true, sourcemap: false,
      transforms: R10_TRANSFORMS, log: (line) => lines.push(String(line)),
    });
    assert.deepEqual(result.removed.map((entry) => `${entry.name}:${entry.bytes}`), [
      'app.json:13', `index.js:${staleIndexBytes}`,
    ]);
    assert.equal(fs.existsSync(path.join(out, 'app.json')), false);
    assert.equal(fs.existsSync(path.join(out, 'index.js')), false);
    assert.deepEqual(result.removedFunctions.map((entry) => entry.name), ['unused']);
    assert.equal(result.treeShakeBefore.get('app.js'), Buffer.byteLength(STUB_JS));
    assert.equal(result.treeShakeAfter.get('app.js'), fs.statSync(path.join(out, 'app.js')).size);
    assert.match(result.report, /tree shake removed functions: app\.js: unused \(\d+ B\)/);
    assert.match(result.report, /tree shake removed generated assets: app\.json \(13 B\), index\.js \(\d+ B\)/);
    assert.match(result.report, /processed js files: app\.js/);
    assert.ok(lines.some((line) => line.startsWith('tree shake: removed app.js: unused')));
    assert.ok(lines.some((line) => line.startsWith('removed unused asset: app.json')));
    assert.equal(sizeReport({ dir: out, log: () => {} }), result.report);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('size report and tree-shake table math come from statSync maps', () => {
  const dir = tmpDir('r10-size-');
  try {
    const appFile = path.join(dir, 'app.js');
    const mapFile = path.join(dir, 'app.js.map');
    fs.writeFileSync(appFile, 'x'.repeat(1000));
    fs.writeFileSync(mapFile, 'm'.repeat(200));
    const before = sizeBytes(dir);
    assert.equal(before.get('app.js'), 1000);
    assert.equal(before.get('app.js.map'), 200);
    fs.writeFileSync(appFile, 'x'.repeat(800));
    const after = sizeBytes(dir);
    assert.equal(after.get('app.js'), fs.statSync(appFile).size);
    assert.equal(after.get('app.js.map'), fs.statSync(mapFile).size);

    const shakeBefore = new Map([['app.js', before.get('app.js')]]);
    const shakeAfter = new Map([['app.js', after.get('app.js')]]);
    const table = formatTreeShakeTable({ before: shakeBefore, after: shakeAfter });
    assert.match(table, /\| app\.js \| 1000 B \| 800 B \| 20\.0% \|/);
    assert.match(table, /measured tree-shake reduction: 20\.0% \(before 1000 B -> after 800 B\)/);

    const report = formatSizeReport({
      dir, target: 'web', before, after,
      flags: { minify: false, treeShake: true, sourcemap: true },
      removedFunctions: [{ file: 'app.js', name: 'unused', bytes: 200 }],
      sourceMaps: [{ file: 'app.js', map: 'app.js.map', bytes: after.get('app.js.map') }],
      treeShakeTable: table,
      jsFiles: ['app.js'], jsLabel: 'processed js files',
    });
    assert.match(report, /\| total \| 1200 B \| 1000 B \| 16\.7% \|/);
    assert.match(report, /tree shake removed functions: app\.js: unused \(200 B\)/);
    assert.match(report, /source maps: app\.js -> app\.js\.map \(200 B\)/);
    assert.match(report, /source map accuracy: generated line starts.*not line-exact or column-exact/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
