import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs, parsePort, requireFlags } from '../lib/args.mjs';
import { TARGETS, validateTarget } from '../lib/targets.mjs';

test('parseArgs handles long flags, equals form, short alias and positionals', () => {
  const { flags, positionals } = parseArgs([
    'build', '--src', 'src/main.opu', '--target=web', '-o', 'dist/web', '--verbose', '--', '--literal',
  ]);
  assert.deepEqual(positionals, ['build', '--literal']);
  assert.equal(flags.src, 'src/main.opu');
  assert.equal(flags.target, 'web');
  assert.equal(flags.out, 'dist/web');
  assert.equal(flags.verbose, true);
});

test('parseArgs keeps a boolean flag before another flag', () => {
  const { flags, positionals } = parseArgs(['--watch', '--port', '5178']);
  assert.equal(flags.watch, true);
  assert.equal(flags.port, '5178');
  assert.deepEqual(positionals, []);
});

test('requireFlags rejects missing and boolean-only values', () => {
  assert.deepEqual(requireFlags({ src: 'a.opu', target: 'web', out: 'dist' }, ['src', 'target', 'out']), {
    src: 'a.opu', target: 'web', out: 'dist',
  });
  assert.throws(() => requireFlags({ src: 'a.opu' }, ['src', 'target']), /--target/);
  assert.throws(() => requireFlags({ src: true }, ['src']), /--src/);
});

test('parsePort validates range and default', () => {
  assert.equal(parsePort(undefined), 5178);
  assert.equal(parsePort('3000'), 3000);
  assert.throws(() => parsePort('nope'), /invalid --port/);
  assert.throws(() => parsePort('0'), /invalid --port/);
  assert.throws(() => parsePort('70000'), /invalid --port/);
});

test('validateTarget accepts only the 8 IR emitters', () => {
  assert.equal(TARGETS.length, 8);
  for (const name of TARGETS) assert.equal(validateTarget(name), name);
  assert.throws(() => validateTarget('wasm'), /unknown target/);
});
