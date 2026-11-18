// Integration gate for core page flows and typical business scenarios.
//
// Flutter authority: integration tests drive the real app through
// `IntegrationTestWidgetsFlutterBinding`
// (packages/integration_test/lib/integration_test.dart:45,156). The Opurom
// adaptation drives the real compiler, core runtime and renderer through the
// published CLI surface; the IR remains the only source of truth and no
// runtime interpreter is introduced.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilerPath } from '../lib/build.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');

function binary(repo, names) {
  for (const profile of ['debug', 'release']) {
    for (const name of names) {
      const file = path.join(ROOT, repo, 'target', profile, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function compile(source, out) {
  return run(compilerPath({ log: () => {} }), ['compile', source, '-o', out]);
}

function render(ir, width, height, out, extra = []) {
  const exe = binary('opurom-render', ['opurom-render', 'opurom_render']);
  assert.ok(exe, 'opurom-render binary is required for the integration gate');
  return run(exe, [ir, String(width), String(height), out, ...extra]);
}

function fixture(name) {
  const file = path.join(ROOT, 'opurom-examples', `${name}.opu`);
  assert.ok(existsSync(file), `missing example source: ${file}`);
  return file;
}

test('counter page compiles, renders and reports a stable digest', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-integration-counter-'));
  const ir = path.join(dir, 'counter.opuir.json');
  const ppm = path.join(dir, 'frame.ppm');
  const compiled = compile(fixture('counter'), ir);
  assert.equal(compiled.status, 0, `compile failed: ${compiled.output}`);
  const first = render(ir, 320, 240, ppm);
  assert.equal(first.status, 0, `render failed: ${first.output}`);
  const a = readFileSync(ppm);
  const second = render(ir, 320, 240, ppm);
  assert.equal(second.status, 0, `second render failed: ${second.output}`);
  assert.deepEqual(readFileSync(ppm), a, 'the same IR must render identical bytes');
});

test('form page enters a subscribed state and changes the rendered frame', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-integration-form-'));
  const ir = path.join(dir, 'form.opuir.json');
  const base = path.join(dir, 'base.ppm');
  const subscribed = path.join(dir, 'subscribed.ppm');
  const compiled = compile(fixture('form'), ir);
  assert.equal(compiled.status, 0, `compile failed: ${compiled.output}`);
  const first = render(ir, 560, 480, base);
  assert.equal(first.status, 0, `base render failed: ${first.output}`);
  const second = render(ir, 560, 480, subscribed, ['--state', 'subscribed=true']);
  assert.equal(second.status, 0, `state render failed: ${second.output}`);
  assert.notDeepEqual(readFileSync(subscribed), readFileSync(base),
    'a business state change must change the rendered frame');
});

test('the declarative widget suite drives real state transitions', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-integration-widget-'));
  const script = path.join(dir, 'todo.wtest.json');
  writeFileSync(script, JSON.stringify({
    src: fixture('todo'),
    width: 320,
    height: 240,
    steps: [{ tap: 4 }],
    expect: {},
  }));
  const result = run(process.execPath, [CLI, 'test', '--widget', script]);
  assert.equal(result.status, 0, `widget test failed: ${result.output}`);
  assert.match(result.output, /1 passed, 0 failed/);
});

test('the example registry runs a filtered real app suite', () => {
  const result = run(process.execPath, [CLI, 'test', '--examples', '--filter', 'counter', '--jobs', '1']);
  assert.equal(result.status, 0, `example suite failed: ${result.output}`);
  assert.match(result.output, /tests passed: 3, failed: 0/);
});
