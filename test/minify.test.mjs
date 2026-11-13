import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { build, formatMeasuredBytes } from '../lib/build.mjs';
import { tmpDir } from '../lib/paths.mjs';
import {
  finalizeMinifiedBuild, formatSizeReport, minifyJs, parseTargetsOutput, sizeBytes, sizeReport,
} from '../lib/minify.mjs';

const FIXTURES = new URL('./fixtures/emit/', import.meta.url);
// Real outputs of the current emitters (opurom-spec/counter.opu on this host),
// captured as fixtures so these tests need no sibling Rust repo.
const TARGET_FIXTURES = [
  'web-app.js.fixture', 'wechat-index.js.fixture', 'alipay-index.js.fixture', 'qq-index.js.fixture',
  'douyin-index.js.fixture', 'baidu-index.js.fixture', 'kuaishou-index.js.fixture', 'wasm-host.js.fixture',
];

const CHECK_DIR = tmpDir('r6-check-');

function nodeCheck(source, name) {
  const file = path.join(CHECK_DIR, `${name.replace(/[^a-z0-9-]/gi, '_')}.js`);
  fs.writeFileSync(file, source);
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  return file;
}

function compilerStub(binDir, logFile) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, 'opuromc'), `#!/bin/sh
printf '%s\\n' "$*" >> '${logFile}'
case "$1" in
  compile) printf '%s\\n' '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}' > "$4" ;;
  optimize) cp "$2" "$4" ;;
  targets)
    printf '%s\\n' 'native	Cargo.toml, src/main.rs'
    printf '%s\\n' 'web	index.html, app.js, ir.json'
    printf '%s\\n' 'wechat	app.json, index.wxml, index.wxss, index.js'
    ;;
  target)
    mkdir -p "$6"
    cp "$2" "$6/ir.json"
    printf '%s\\n' '<html><head></head></html>' > "$6/index.html"
    printf '%s\\n' '// generated header' 'const state = {"count":0};' '' 'function render() {' '  return 1;' '}' '' 'render();' > "$6/app.js"
    ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  return path.join(binDir, 'opuromc');
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

test('minifyJs removes comments/whitespace, keeps every literal verbatim', () => {
  assert.equal(minifyJs('// hdr\nconst x = 1; // trail\n'), 'const x = 1;');
  // A URL inside a string must never be touched by comment stripping.
  assert.equal(minifyJs('const u = "https://a.example/x//y?z=1";\n'), 'const u = "https://a.example/x//y?z=1";');
  assert.equal(minifyJs("const u = 'http://b.example//c';\n"), "const u = 'http://b.example//c';");
  assert.equal(minifyJs('const t = `a ${b + 1} c`;\n'), 'const t = `a ${b + 1} c`;');
  assert.equal(minifyJs('const t = `x${`y${z}`}w`;\n'), 'const t = `x${`y${z}`}w`;');
  assert.equal(minifyJs('const t = `${ {a:1}.a }`;\n'), 'const t = `${ {a:1}.a }`;');
  assert.equal(minifyJs('const s = "${not interpolation}";\n'), 'const s = "${not interpolation}";');
  assert.equal(minifyJs('const r = /a\\/b[/]c/g;\n'), 'const r = /a\\/b[/]c/g;');
  assert.equal(minifyJs('const r = /[\x27"\x60]/;\n'), 'const r = /[\x27"\x60]/;');
  assert.equal(minifyJs('el.innerHTML = "<script src=\'a.js\'></script>";\n'), 'el.innerHTML = "<script src=\'a.js\'></script>";');
  // Division is not a regex: spaces inside operands must survive exactly.
  assert.equal(minifyJs('const q = a / b / c;\n'), 'const q = a / b / c;');
  assert.equal(minifyJs('q = a.b / c.d;\n'), 'q = a.b / c.d;');
  assert.equal(minifyJs('y = (a+b) / c;\n'), 'y = (a+b) / c;');
  // Regex literals in every operand position.
  assert.equal(minifyJs('x = /re/.test(s);\n'), 'x = /re/.test(s);');
  assert.equal(minifyJs('if (x) /re/.test(s);\n'), 'if (x) /re/.test(s);');
  assert.equal(minifyJs('function f(){return /x/.test(s)?1:2;}\n'), 'function f(){return /x/.test(s)?1:2;}');
  assert.equal(minifyJs('a++/b/g;\n'), 'a++/b/g;');
  // A block comment separates tokens; it must collapse to one space, not nothing.
  assert.equal(minifyJs('a/*c*/b\n'), 'a b');
  assert.equal(minifyJs('a/*c*/=b\n'), 'a =b');
  // Line structure that ASI depends on is preserved verbatim.
  assert.equal(minifyJs('function f(){return\n1}\n'), 'function f(){return\n1}');
  assert.equal(minifyJs('a = 1\n// c\nb = 2'), 'a = 1\nb = 2');
  assert.equal(minifyJs('return // c\n1'), 'return\n1');
  // A block comment containing a line break counts as a line break for ASI.
  assert.equal(minifyJs('a/*\n*/b'), 'a\nb');
  // Unterminated literals fail loudly instead of corrupting output.
  assert.throws(() => minifyJs('const s = "oops;'), /unterminated string/);
  assert.throws(() => minifyJs('const t = `oops;'), /unterminated template/);
  assert.throws(() => minifyJs('const r = /oops;\n'), /unterminated regular expression/);
  assert.throws(() => minifyJs('/* never closed'), /unterminated block comment/);
});

test('every emitted target fixture stays valid node --check JS after minify', () => {
  for (const name of TARGET_FIXTURES) {
    const source = fs.readFileSync(new URL(name, FIXTURES), 'utf8');
    nodeCheck(source, name); // the captured emitter output itself is valid JS
    const minified = minifyJs(source);
    assert.ok(minified.length < source.length, `${name} did not shrink: ${source.length} -> ${minified.length}`);
    assert.ok(!minified.includes('// generated'), `${name} kept its header comment`);
    nodeCheck(minified, `min-${name}`); // minified output parses
    assert.ok(minified.length > 0, `${name} minified to nothing`);
  }
});

test('minified golden web app behaves identically in a DOM harness', () => {
  const source = fs.readFileSync(new URL('web-app.js.fixture', FIXTURES), 'utf8');
  const minified = minifyJs(source);
  assert.ok(minified.length < source.length);

  const run = (code) => {
    const calls = [];
    const record = (name, args) => calls.push([name, ...args]);
    const ctx = new Proxy({}, {
      get: (target, prop) => (...args) => record(String(prop), args),
      set: (target, prop, value) => { record(`set:${String(prop)}`, [value]); return true; },
    });
    const handlers = {};
    const canvas = {
      width: 800,
      height: 600,
      getContext: () => ctx,
      addEventListener: (type, fn) => { handlers[type] = fn; },
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
    };
    const sandbox = { document: { getElementById: () => canvas } };
    vm.runInNewContext(code, sandbox, { filename: `${code === source ? 'orig' : 'min'}.js` });
    const initial = [...calls];
    // Click the "+" button: x in 78..116, y in 76..108.
    handlers.click({ clientX: 90, clientY: 90 });
    return { initial, afterClick: calls.slice(initial.length) };
  };

  const original = run(source);
  const shrunk = run(minified);
  assert.ok(original.initial.length > 0, 'golden app rendered nothing');
  assert.deepEqual(shrunk.initial, original.initial, 'minified app changed the initial render');
  assert.deepEqual(shrunk.afterClick, original.afterClick, 'minified app changed the click response');
  const texts = original.afterClick.filter(([name]) => name === 'fillText').map((call) => call[1]);
  assert.ok(texts.some((text) => String(text).includes('Count: 1')), `click did not increment: ${texts}`);
});

test('size report math is measured from real statSync bytes on a fixture tree', () => {
  const dir = tmpDir('r6-size-');
  try {
    fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(dir, 'b.html'), 'y'.repeat(500));
    const before = sizeBytes(dir);
    assert.equal(before.get('a.js'), 1000);
    assert.equal(before.get('b.html'), 500);

    fs.writeFileSync(path.join(dir, 'a.js'), 'x'.repeat(600));
    fs.rmSync(path.join(dir, 'b.html'));
    const after = sizeBytes(dir);
    const report = formatSizeReport({
      dir, target: 'web', before, after, removed: [{ name: 'b.html', bytes: 500 }], jsFiles: ['a.js'],
    });
    assert.match(report, /\| a\.js \| 1000 B \| 600 B \| 40\.0% \|/);
    assert.match(report, /\| b\.html \| 500 B \| 0 B \| 100\.0% \|/);
    assert.match(report, /\| total \| 1500 B \| 600 B \| 60\.0% \|/);
    assert.match(report, /measured reduction: 60\.0% \(before 1500 B -> after 600 B\)/);
    assert.match(report, /removed unused generated assets: b\.html \(500 B\)/);
    // The numbers must be exactly statSync-derived, not rounded paraphrases.
    assert.equal(before.get('a.js') + before.get('b.html'), fs.statSync(path.join(dir, 'a.js')).size + 400 + 500);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('finalize minifies, removes stale emitter assets, and size repeats the measurement', async () => {
  const base = tmpDir('r6-finalize-');
  try {
    const logFile = path.join(base, 'opuromc.log');
    const opuromc = compilerStub(path.join(base, 'bin'), logFile);
    const out = path.join(base, 'out');
    fs.mkdirSync(out);
    // Stale wechat output from a previous build into the same directory.
    fs.writeFileSync(path.join(out, 'app.json'), '{"pages":[]}\n');
    fs.writeFileSync(path.join(out, 'index.js'), '// stale\nPage({});\n');
    fs.writeFileSync(path.join(out, 'notes.txt'), 'keep me\n');
    // Generic names a user may own must never be deleted as "unused".
    fs.writeFileSync(path.join(out, 'README.md'), '# my notes\n');
    fs.writeFileSync(path.join(out, 'Cargo.toml'), '[package]\nname = "mine"\n');
    const staleIndexJs = fs.statSync(path.join(out, 'index.js')).size;
    const rawApp = fs.readFileSync(new URL('web-app.js.fixture', FIXTURES), 'utf8');
    fs.writeFileSync(path.join(out, 'app.js'), rawApp);
    fs.writeFileSync(path.join(out, 'index.html'), '<html></html>\n');
    fs.writeFileSync(path.join(out, 'ir.json'), '{}\n');

    const lines = [];
    const result = finalizeMinifiedBuild({ out, target: 'web', opuromc, log: (line) => lines.push(String(line)) });
    assert.deepEqual(
      result.removed.map((entry) => `${entry.name}:${entry.bytes}`),
      [`app.json:13`, `index.js:${staleIndexJs}`],
      'exact stale assets must be reported',
    );
    assert.equal(fs.existsSync(path.join(out, 'app.json')), false);
    assert.equal(fs.existsSync(path.join(out, 'index.js')), false);
    assert.equal(fs.readFileSync(path.join(out, 'notes.txt'), 'utf8'), 'keep me\n', 'non-emitter file was removed');
    assert.equal(fs.existsSync(path.join(out, 'README.md')), true, 'a user README.md was deleted');
    assert.equal(fs.existsSync(path.join(out, 'Cargo.toml')), true, 'a user Cargo.toml was deleted');
    assert.deepEqual(result.jsFiles, ['app.js']);
    assert.ok(result.after.get('app.js') < result.before.get('app.js'));
    assert.ok(lines.some((line) => line.startsWith('removed unused asset: app.json')));

    // `opurom size` re-stats the tree and must reproduce the same measured table.
    let report = '';
    const fromCommand = sizeReport({ dir: out, log: (line) => { report += `${line}\n`; } });
    assert.equal(fromCommand, report.trimEnd());
    const beforeTotal = [...result.before.values()].reduce((sum, n) => sum + n, 0);
    const afterTotal = [...result.after.values()].reduce((sum, n) => sum + n, 0);
    assert.match(report, new RegExp(`before ${beforeTotal} B -> after ${afterTotal} B`));
    assert.match(report, /\| app\.js \| 1438 B \| \d+ B \| \d+\.\d% \|/);
    assert.match(report, new RegExp(`removed unused generated assets: app\\.json \\(13 B\\), index\\.js \\(${staleIndexJs} B\\)`));
    // The baseline manifest records the real statSync sizes of the pre-build tree.
    const manifest = JSON.parse(fs.readFileSync(path.join(out, '.opurom-size.json'), 'utf8'));
    assert.equal(manifest.version, 1);
    assert.equal(manifest.target, 'web');
    assert.equal(manifest.files['app.js'], 1438);
    assert.equal(manifest.files['notes.txt'], 8);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('default build bytes are identical without --minify; --minify changes only JS', async () => {
  const base = tmpDir('r6-default-');
  try {
    const logFile = path.join(base, 'opuromc.log');
    const binDir = path.join(base, 'bin');
    const src = path.join(base, 'main.opu');
    fs.writeFileSync(src, 'app Counter { state count = 0 }\n');
    const lines = [];
    await withStubPath(binDir, async () => {
      compilerStub(binDir, logFile);
      const plain = build({ src, target: 'web', out: path.join(base, 'plain'), root: base, quiet: true });
      assert.equal('minification' in plain, false);
      assert.equal(fs.existsSync(path.join(plain.out, '.opurom-size.json')), false);

      const appJs = fs.readFileSync(path.join(plain.out, 'app.js'), 'utf8');
      assert.equal(appJs, [
        '// generated header', 'const state = {"count":0};', '', 'function render() {', '  return 1;', '}', '', 'render();', '',
      ].join('\n'), 'default build altered emitter bytes');

      const minified = build({
        src, target: 'web', out: path.join(base, 'min'), root: base, minify: true,
        log: (line) => lines.push(String(line)),
      });
      assert.ok(minified.minification, '--minify must report a minification result');
      assert.deepEqual(minified.minification.jsFiles, ['app.js']);
      const shrunk = fs.readFileSync(path.join(minified.out, 'app.js'), 'utf8');
      assert.ok(shrunk.length < appJs.length);
      assert.equal(shrunk.includes('// generated header'), false);
      assert.equal(shrunk, 'const state = {"count":0};\nfunction render() {\nreturn 1;\n}\nrender();');
      nodeCheck(shrunk, 'stub-min.js');
      assert.ok(lines.some((line) => line.startsWith('OPUROM size')), 'no measured summary printed');

      // --optimize composes with --minify: both flags flow through one build.
      const both = build({
        src, target: 'web', out: path.join(base, 'both'), root: base, quiet: true,
        optimize: true, minify: true, log: () => {},
      });
      assert.ok(both.optimization, '--optimize missing alongside --minify');
      assert.ok(both.minification, '--minify missing alongside --optimize');
      const logged = fs.readFileSync(logFile, 'utf8').trim().split('\n');
      const optimizeLine = logged.find((line) => line.startsWith('optimize '));
      const targetLine = logged.filter((line) => line.startsWith('target ')).at(-1);
      assert.ok(logged.indexOf(optimizeLine) < logged.lastIndexOf(targetLine), 'optimize did not run before the emitter');
      assert.equal(both.optimization.inputBytes, Buffer.byteLength('{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}\n'));
      assert.equal(both.optimization.outputBytes, both.optimization.inputBytes);
      assert.equal(formatMeasuredBytes(both.optimization.inputBytes, both.optimization.outputBytes),
        `optimizer: input=${both.optimization.inputBytes} B, output=${both.optimization.outputBytes} B (measured from files)`);
      assert.equal(fs.readFileSync(path.join(both.out, 'ir.json'), 'utf8'),
        '{"ir":"0.1","app":"Counter","state":[],"tree":{},"theme":{}}\n', 'optimize fell back despite stub support');
    });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('parseTargetsOutput reads the real `opuromc targets` shape', () => {
  const map = parseTargetsOutput([
    'native\tCargo.toml, src/main.rs',
    'web\tindex.html, app.js, ir.json',
    'wechat\tapp.json, index.wxml, index.wxss, index.js',
    '',
  ].join('\n'));
  assert.deepEqual(map.get('web'), ['index.html', 'app.js', 'ir.json']);
  assert.deepEqual(map.get('native'), ['Cargo.toml', 'src/main.rs']);
  assert.equal(map.size, 3);
  assert.equal(parseTargetsOutput('').size, 0);
});
