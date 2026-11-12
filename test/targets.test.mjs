import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, planBuild } from '../lib/build.mjs';
import { digestOf, dirtyOf, platformRows } from '../lib/e2e.mjs';
import { TARGETS, targetsFromBuiltins, validateTarget } from '../lib/targets.mjs';
import { goldenFile } from '../lib/paths.mjs';

test('targetsFromBuiltins reads the 8 emitters from the IR format', () => {
  const names = targetsFromBuiltins(goldenFile('the IR format'));
  assert.equal(names.length, 8);
  assert.deepEqual(names, [...TARGETS]);
  for (const name of names) assert.doesNotThrow(() => validateTarget(name));
});

test('targetsFromBuiltins falls back to the built-in list when contract is absent', () => {
  assert.deepEqual(targetsFromBuiltins('/definitely/not/here/the IR format'), [...TARGETS]);
});

test('planBuild compiles, lowers, and adds cargo only for native', () => {
  const base = { src: '/a/main.opu', ir: '/tmp/ir.json', out: '/a/dist/web', opuromc: '/bin/opuromc', cargo: '/bin/cargo' };
  assert.deepEqual(planBuild({ ...base, target: 'web' }), [
    { label: 'compile', cmd: '/bin/opuromc', args: ['compile', '/a/main.opu', '-o', '/tmp/ir.json'] },
    { label: 'lower', cmd: '/bin/opuromc', args: ['target', '/tmp/ir.json', '--target', 'web', '-o', '/a/dist/web'] },
  ]);
  const native = planBuild({ ...base, target: 'native' });
  assert.equal(native.length, 3);
  assert.deepEqual(native[2], { label: 'cargo', cmd: '/bin/cargo', args: ['build', '--release'], cwd: '/a/dist/web' });
});

test('build rejects bad target and missing source before invoking any tool', () => {
  assert.throws(() => build({ src: '/definitely/missing.opu', target: 'wasm', out: 'tmp/x' }), /unknown target/);
  assert.throws(() => build({ src: '/definitely/missing.opu', target: 'web', out: 'tmp/x' }), /source not found/);
});

test('e2e output parsers find digest, dirty count and data rows', () => {
  assert.equal(digestOf('frame digest sha256: AABBCCDD11223344\n'), 'aabbccdd11223344');
  assert.equal(digestOf('nothing here\n'), null);
  assert.equal(dirtyOf('dirty rects: 3\n'), 3);
  assert.equal(dirtyOf('nothing here\n'), null);
  const rows = ['name | emitter | status', 'a | one', 'b | two', ''].join('\n');
  assert.equal(platformRows(rows).length, 2);
});

test('a temporary contract copy still parses (no sibling repos needed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-examples-copy-'));
  try {
    fs.copyFileSync(goldenFile('the IR format'), path.join(dir, 'the IR format'));
    assert.deepEqual(targetsFromBuiltins(path.join(dir, 'the IR format')), [...TARGETS]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
