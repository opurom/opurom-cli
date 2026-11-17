import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/proc.mjs';
import { runChecks } from '../lib/e2e.mjs';
import { runPool } from '../lib/examples.mjs';
import { workspaceRoot } from '../lib/paths.mjs';
import { runWidgetScript, runWidgetTests } from '../lib/widget_test.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));
const goldenCounter = path.join(workspaceRoot(), 'opurom-examples', 'golden', 'counter.opuir.json');

function writeScript(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

test('--fail-fast stops the e2e suite at the first failure and exits 1', async () => {
  const ran = [];
  const checks = [
    ['first', () => { ran.push('first'); throw new Error('boom'); }],
    ['second', () => { ran.push('second'); return 'ok'; }],
    ['third', () => { ran.push('third'); return 'ok'; }],
  ];
  const { results, exitCode } = await runChecks(checks, { failFast: true });
  assert.deepEqual(ran, ['first'], 'no check runs after the first failure');
  assert.deepEqual(results.map((result) => result.status), ['FAIL', 'SKIP', 'SKIP']);
  assert.equal(exitCode, 1);

  const all = await runChecks(checks.slice(0, 2), { failFast: false });
  assert.equal(all.exitCode, 1);
  assert.deepEqual(all.results.map((result) => result.status), ['FAIL', 'PASS']);
});

test('--fail-fast stops queued example tests but lets the pool drain', async () => {
  const executed = [];
  let failed = false;
  await runPool([1, 2, 3, 4], 1, async (item) => {
    executed.push(item);
    if (!failed) failed = true;
  }, { shouldStop: () => failed });
  assert.deepEqual(executed, [1], 'with one job only the failing test runs');
});

test('--fail-fast stops widget scripts after the first failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-flags-'));
  const failing = writeScript(dir, 'a.wtest.json', {
    ir: goldenCounter, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 99 } },
  });
  const passing = writeScript(dir, 'b.wtest.json', {
    ir: goldenCounter, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 1 } },
  });
  const { results, exitCode, failed, skipped } = runWidgetTests([failing, passing], {
    log: () => {}, failFast: true,
  });
  assert.equal(exitCode, 1);
  assert.equal(failed, 1);
  assert.equal(skipped, 1);
  assert.deepEqual(results.map((result) => result.status), ['FAIL', 'SKIP']);
});

test('--update-goldens rewrites only changed digests and is idempotent', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-wtest-goldens-'));
  // A first run without an expectation reveals the real digest.
  const probe = runWidgetScript(writeScript(dir, 'probe.wtest.json', {
    ir: goldenCounter, width: 320, height: 240, steps: [{ tap: 4 }], expect: {},
  }), { log: () => {} });
  const stale = writeScript(dir, 'stale.wtest.json', {
    ir: goldenCounter, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 1 }, digest: '0'.repeat(16) },
  });
  const current = writeScript(dir, 'current.wtest.json', {
    ir: goldenCounter, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 1 }, digest: probe.digest },
  });
  const currentBefore = fs.readFileSync(current, 'utf8');

  const first = runWidgetTests([stale, current], { log: () => {}, updateGoldens: true });
  assert.equal(first.updated, 1);
  assert.equal(first.failed, 0);
  assert.deepEqual(first.results.map((result) => result.updated), [true, false]);
  const staleAfter = JSON.parse(fs.readFileSync(stale, 'utf8'));
  assert.equal(staleAfter.expect.digest, probe.digest, 'the changed digest is rewritten');
  assert.equal(staleAfter.expect.state.count, 1, 'other expectation fields survive');
  assert.equal(fs.readFileSync(current, 'utf8'), currentBefore, 'unchanged scripts are not written');

  const second = runWidgetTests([stale, current], { log: () => {}, updateGoldens: true });
  assert.equal(second.updated, 0, 'a second run has nothing left to update');
  assert.equal(fs.readFileSync(stale, 'utf8'), JSON.stringify(staleAfter, null, 2) + '\n');
});

test('--update-goldens without --widget is a usage error', () => {
  const result = run(process.execPath, [CLI, 'test', '--update-goldens'], { timeout: 20000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--update-goldens requires --widget/);
});
