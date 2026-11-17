import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// Fake-door guard for the opt-in performance benchmark. A plain `node --test`
// (what CI runs) must print the explicit N/A marker, pass cleanly, and not
// hide behind a skip. Without this assertion a silent skip could creep back.
const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SUITE = path.join(CLI_ROOT, 'test', 'bench_suite.test.mjs');
const MARKER = /N\/A - performance benchmark, run locally \(OPUROM_BENCH_LOCAL=1\)/;

test('the plain benchmark run reports N/A, not a silent skip', () => {
  const env = { ...process.env, OPUROM_BENCH_LOCAL: '' };
  // A nested `node --test` inherits NODE_TEST_CONTEXT from the outer runner,
  // which makes Node skip the child's files. Clear it for a clean CI-like run.
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', SUITE], {
    cwd: CLI_ROOT,
    encoding: 'utf8',
    env,
  });
  assert.equal(run.status, 0, `benchmark suite failed: ${run.stderr}`);
  const text = run.stdout + run.stderr;
  assert.match(text, MARKER, 'no explicit N/A marker: benchmark would be a silent fake door');
  // GitHub CI runs the TAP reporter ('#'), a local run uses spec ('ℹ').
  assert.doesNotMatch(text, /[#ℹ] skipped [1-9]/, 'benchmark must not hide behind a skip');
  assert.match(text, /[#ℹ] fail 0/, 'N/A path must pass cleanly');
});
