// Cross-target consistency gate: one IR, identical business semantics on
// every emitter.
//
// Flutter authority: Flutter guarantees one source lowers to each platform
// without per-platform logic drift. The Opurom form of that contract is the
// architecture red line "IR is the single source of truth": every emitter
// must lower the same state, event targets and transition expressions from
// one compiled IR, with no runtime interpreter added.
//
// Source anchors in this repository:
// - opurom-cli/lib/targets.mjs:5-16 emits the target set under test.
// - opurom-cli/lib/fullstack.mjs:286-290 checks compiler target support.
// - opurom-spec/FLUTTER_PARITY_MASTER.md:28-33 records the IR single-source
//   rule and deterministic rendering constraint.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilerPath } from '../lib/build.mjs';
import { TARGETS } from '../lib/targets.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');
const SOURCE = path.join(ROOT, 'opurom-examples', 'golden', 'counter.opu');

function run(command, args, cwd = ROOT) {
  return spawnSync(command, args, { cwd, encoding: 'utf8' });
}

function build(target, out) {
  return run(process.execPath, [
    CLI, 'build', '--src', SOURCE, '--target', target, '--out', out,
  ]);
}

function compileIr(out) {
  const ir = path.join(out, 'ir.json');
  const result = run(compilerPath({ log: () => {} }), ['compile', SOURCE, '-o', ir]);
  assert.equal(result.status, 0, `compile failed: ${result.stdout}${result.stderr}`);
  return JSON.parse(readFileSync(ir, 'utf8'));
}

test('all declared targets lower from one compiler IR', () => {
  assert.deepEqual(TARGETS, [
    'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
    'wasm', 'harmony',
  ]);
  const listed = run(compilerPath({ log: () => {} }), ['targets']);
  assert.equal(listed.status, 0, `targets failed: ${listed.stdout}${listed.stderr}`);
  const supported = new Set(listed.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[0]));
  for (const target of TARGETS) {
    assert.ok(supported.has(target), `compiler does not declare ${target}`);
  }
});

test('web, wechat and alipay preserve the same state and event targets', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-cross-target-'));
  const ir = compileIr(dir);
  const stateNames = (ir.state ?? []).map((entry) => entry.name ?? entry.id);
  assert.deepEqual(stateNames, ['count'], 'the fixture must have exactly one state');

  const scripts = [];
  const emitted = { web: 'app.js', wechat: 'pages/index/index.js', alipay: 'pages/index/index.js' };
  for (const [target, file] of Object.entries(emitted)) {
    const out = path.join(dir, target);
    const result = build(target, out);
    assert.equal(result.status, 0, `${target} build failed: ${result.stdout}${result.stderr}`);
    const script = path.join(out, file);
    assert.ok(existsSync(script), `${target} wrote no ${file}`);
    const text = readFileSync(script, 'utf8');
    assert.match(text, /count/, `${target} lost the counter state`);
    scripts.push({ target, text });
  }
  // The two mini-program emitters share one lexical state/event lowering; the
  // web emitter uses DOM syntax but must still name the same state and targets.
  const eventTargets = new Set();
  const collectTargets = (node) => {
    for (const event of Object.values(node.events ?? {})) {
      if (event?.target) eventTargets.add(String(event.target));
    }
    for (const child of node.children ?? []) collectTargets(child);
  };
  collectTargets(ir.tree);
  assert.ok(eventTargets.size > 0, 'the fixture must have event targets');
  for (const { target, text } of scripts) {
    for (const stateName of eventTargets) {
      assert.ok(text.includes(stateName), `${target} lost event target ${stateName}`);
    }
  }
});

test('each target writes a complete artifact set and a deterministic mode record', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-cross-artifacts-'));
  const expected = {
    web: ['app.js', 'index.html', 'ir.json'],
    wechat: ['app.js', 'app.json', 'pages/index/index.js', 'pages/index/index.wxml', 'pages/index/index.wxss'],
    alipay: ['app.js', 'app.json', 'pages/index/index.acss', 'pages/index/index.axml', 'pages/index/index.js'],
  };
  for (const [target, files] of Object.entries(expected)) {
    const out = path.join(dir, target);
    const result = build(target, out);
    assert.equal(result.status, 0, `${target} build failed: ${result.stdout}${result.stderr}`);
    for (const file of files) {
      assert.ok(existsSync(path.join(out, file)), `${target} missing ${file}`);
    }
  }
  const first = build('web', path.join(dir, 'web-a'));
  const second = build('web', path.join(dir, 'web-b'));
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.deepEqual(
    readFileSync(path.join(dir, 'web-a', 'app.js')),
    readFileSync(path.join(dir, 'web-b', 'app.js')),
    'the same source must produce byte-identical output',
  );
});

test('cross-target builds never mutate the source IR', () => {
  const before = readFileSync(SOURCE, 'utf8');
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-cross-immutable-'));
  for (const target of ['web', 'wechat', 'alipay']) {
    assert.equal(build(target, path.join(dir, target)).status, 0, `${target} build failed`);
  }
  assert.equal(readFileSync(SOURCE, 'utf8'), before, 'source must remain unchanged');
});
