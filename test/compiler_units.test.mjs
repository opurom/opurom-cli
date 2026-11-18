#!/usr/bin/env node
// Unit coverage for the compiler front end, driven through the real
// `opuromc` binary. The compiler crate is owned by another team, so these
// tests exercise its published surface (the `check` subcommand) instead of
// its internal modules, and they assert the diagnostic contract a caller
// depends on: every rejection names a line, a column and a remedy.
//
// Flutter authority: the language surface under test is the Opurom core
// language (state, nodes, model, api, theme); no Flutter object model is
// involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { compilerPath } from '../lib/build.mjs';

function workspace(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opurom-compiler-units-${tag}-`));
  return dir;
}

function write(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

function check(source) {
  const dir = workspace('case');
  const file = write(dir, 'app.opu', source);
  const run = spawnSync(compilerPath(), ['check', file], { encoding: 'utf8' });
  return {
    ok: run.status === 0,
    output: `${run.stdout || ''}${run.stderr || ''}`,
  };
}

test('a well-formed source checks clean', () => {
  const result = check('app App {\n  state count = 0\n  Text("{count}")\n}\n');
  assert.ok(result.ok, `expected a clean check: ${result.output}`);
});

test('a reserved v0.1 word reports line, column and remedy', () => {
  const result = check('app App {\n  fn main() {}\n}\n');
  assert.ok(!result.ok, 'fn must be rejected');
  assert.match(result.output, /2:3/, `line/column missing: ${result.output}`);
  assert.match(result.output, /not yet supported in 0\.1\.0/);
  assert.match(result.output, /remove 'fn'/);
});

test('a reserved v0.2 word names the supported surface', () => {
  const result = check('app App {\n  let x = 1\n}\n');
  assert.ok(!result.ok, 'let must be rejected');
  assert.match(result.output, /2:3/, `line/column missing: ${result.output}`);
  assert.match(result.output, /not yet supported in v0\.2/);
  assert.match(result.output, /state, nodes, model, api and theme/);
});

test('an unknown escape sequence is rejected inside the string', () => {
  const result = check('app App {\n  Text("a\\qb")\n}\n');
  assert.ok(!result.ok, 'unknown escape must be rejected');
  assert.match(result.output, /unknown escape sequence '\\q'/);
  assert.match(result.output, /strings support/);
});

test('an unterminated string reports the position of its opening quote', () => {
  const result = check('app App {\n  Text("open\n}\n');
  assert.ok(!result.ok, 'unterminated string must be rejected');
  assert.match(result.output, /2:8/, `start position missing: ${result.output}`);
  assert.match(result.output, /unterminated string literal/);
});

test('an integer literal beyond i64 is refused with the legal range', () => {
  const result = check('app App {\n  state big = 99999999999999999999\n}\n');
  assert.ok(!result.ok, 'out-of-range integer must be rejected');
  assert.match(result.output, /out of range/);
  assert.match(result.output, /9223372036854775807/);
});

test('a float literal is accepted where numbers are allowed', () => {
  const result = check('app App {\n  Text("scale", fontScale: 0.75)\n}\n');
  assert.ok(result.ok, `float prop must check: ${result.output}`);
});

test('a decimal state is rejected with the integer guidance', () => {
  const result = check('app App {\n  state ratio = 0.5\n}\n');
  assert.ok(!result.ok, 'a decimal state must be rejected');
  assert.match(result.output, /cannot be a decimal/);
  assert.match(result.output, /declare numbers as integers/);
});

test('an unexpected character is reported with the accepted source shape', () => {
  const result = check('app App {\n  state a = 1\n  state b = a @ 2\n}\n');
  assert.ok(!result.ok, 'an unknown character must be rejected');
  assert.match(result.output, /unexpected character '@'/);
  assert.match(result.output, /source uses letters, digits/);
});
