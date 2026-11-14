import assert from 'node:assert/strict';
import test from 'node:test';
import { build, planBuild } from '../lib/build.mjs';
import { digestOf, dirtyOf, platformRows } from '../lib/e2e.mjs';
import { TARGETS, targetsFromBuiltins, validateTarget } from '../lib/targets.mjs';

test('targetsFromBuiltins returns the 8 built-in emitters', () => {
  const names = targetsFromBuiltins();
  assert.equal(names.length, 8);
  assert.deepEqual(names, [...TARGETS]);
  for (const name of names) assert.doesNotThrow(() => validateTarget(name));
});

test('targetsFromBuiltins ignores any path argument and still returns the built-in list', () => {
  assert.deepEqual(targetsFromBuiltins('/definitely/not/here/anything.md'), [...TARGETS]);
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
