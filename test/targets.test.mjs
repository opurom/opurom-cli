import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { build, planBuild } from '../lib/build.mjs';
import { digestOf, dirtyOf, platformRows } from '../lib/e2e.mjs';
import { TARGETS, targetsFromSpec, validateTarget } from '../lib/targets.mjs';
import { specFile } from '../lib/paths.mjs';

test('targetsFromSpec reads the 8 emitters from IR_SCHEMA.md', () => {
  const names = targetsFromSpec(specFile('IR_SCHEMA.md'));
  assert.equal(names.length, 8);
  assert.deepEqual(names, [...TARGETS]);
  for (const name of names) assert.doesNotThrow(() => validateTarget(name));
});

test('targetsFromSpec falls back to the built-in list when spec is absent', () => {
  assert.deepEqual(targetsFromSpec('/definitely/not/here/IR_SCHEMA.md'), [...TARGETS]);
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

test('a temporary spec copy still parses (no sibling repos needed)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-spec-copy-'));
  try {
    fs.copyFileSync(specFile('IR_SCHEMA.md'), path.join(dir, 'IR_SCHEMA.md'));
    assert.deepEqual(targetsFromSpec(path.join(dir, 'IR_SCHEMA.md')), [...TARGETS]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
