import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CLI_ROOT, workspaceRoot } from '../lib/paths.mjs';
import { compilerPath } from '../lib/build.mjs';
import { discoverScripts, runWidgetScript, runWidgetTests } from '../lib/widget_test.mjs';

const goldenCounter = path.join(workspaceRoot(), 'opurom-examples', 'golden', 'counter.opuir.json');

function writeScript(dir, body) {
  const file = path.join(dir, 'case.wtest.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

test('a tap step mutates state and yields a stable digest', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-'));
  const script = writeScript(dir, {
    ir: goldenCounter,
    width: 320,
    height: 240,
    steps: [{ tap: 4 }, { tap: 4 }],
    expect: { state: { count: 2 } },
  });
  const first = runWidgetScript(script);
  assert.equal(first.status, 'PASS', first.failures.join('; '));
  assert.equal(first.state.count, 2);
  const second = runWidgetScript(script);
  assert.equal(second.digest, first.digest, 'digest must be deterministic');
});

test('a tick step advances an animated frame deterministically', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-'));
  // animation.opu has spring/ease panels, so the clock changes the frame.
  const src = path.join(workspaceRoot(), 'opurom-examples', 'animation.opu');
  const ir = path.join(dir, 'anim.opuir.json');
  const compiled = spawnSync(compilerPath(), ['compile', src, '-o', ir], { encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const at0 = runWidgetScript(writeScript(dir, {
    ir, width: 320, height: 240, steps: [{ tick: 0 }], expect: {},
  }));
  const at96 = runWidgetScript(writeScript(dir, {
    ir, width: 320, height: 240, steps: [{ tick: 96 }], expect: {},
  }));
  assert.notEqual(at96.digest, at0.digest, 'a tick should advance the animated frame');
  assert.equal(runWidgetScript(writeScript(dir, {
    ir, width: 320, height: 240, steps: [{ tick: 96 }], expect: {},
  })).digest, at96.digest, 'the ticked frame must be deterministic');
});

test('a wrong expectation fails without throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-'));
  const result = runWidgetScript(writeScript(dir, {
    ir: goldenCounter, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 99 } },
  }));
  assert.equal(result.status, 'FAIL');
  assert.match(result.failures[0], /state mismatch/);
});

test('runWidgetTests summarizes pass and fail counts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-'));
  const good = writeScript(dir, {
    ir: goldenCounter, width: 320, height: 240, steps: [{ tap: 4 }], expect: { state: { count: 1 } },
  });
  const { passed, failed, exitCode } = runWidgetTests([good], { log: () => {} });
  assert.deepEqual({ passed, failed, exitCode }, { passed: 1, failed: 0, exitCode: 0 });
});

test('discoverScripts finds .wtest.json recursively and nothing else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-'));
  fs.mkdirSync(path.join(dir, 'nested'));
  fs.writeFileSync(path.join(dir, 'a.wtest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'nested', 'b.wtest.json'), '{}');
  fs.writeFileSync(path.join(dir, 'ignore.json'), '{}');
  const found = discoverScripts(dir).map((file) => path.basename(file)).sort();
  assert.deepEqual(found, ['a.wtest.json', 'b.wtest.json']);
});
