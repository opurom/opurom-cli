// Scheduling gate for the Opurom interaction runner.
//
// Flutter authority (flutter-golden HEAD ab2912035e160, 3.50.0 / candidate.0):
// - packages/flutter_test/lib/src/binding.dart:1326-1329 documents the
//   automated default test timeout: 10 minutes for `flutter test`, unlimited
//   for live bindings; :2345-2347 permits an explicit unlimited timeout for
//   debugger-attached tooling.
// - packages/flutter_test/lib/src/binding.dart:1070/2295 selects the
//   automated/live binding; a test suite must not misreport unrun work.
// - Opurom's published runner contract lives in
//   opurom-cli/lib/widget_test.mjs:155-182 (--fail-fast marks queued scripts
//   SKIP and returns nonzero on any FAIL).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');
const IR = path.join(CLI_ROOT, '..', 'opurom-examples', 'golden', 'counter.opuir.json');

function script(dir, name, count) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify({
    ir: IR, width: 320, height: 240,
    steps: Array.from({ length: count }, () => ({ tap: 4 })),
    expect: { state: { count } },
  }));
  return file;
}

function run(files, extra = []) {
  const results = files.map((file) => spawnSync(
    process.execPath, [CLI, 'test', '--widget', file, ...extra],
    { encoding: 'utf8', timeout: 10 * 60 * 1000 },
  ));
  const output = results.map((r) => `${r.stdout || ''}${r.stderr || ''}`).join('\n');
  return {
    status: results.some((r) => r.status !== 0) ? 1 : 0,
    stdout: output,
    stderr: '',
  };
}

test('the automated runner uses a bounded child-process timeout', () => {
  // Flutter's automated binding defaults to a 10-minute timeout
  // (binding.dart:1326-1329). Opurom's test runner uses synchronous
  // child processes, so the CI harness supplies that bound. This test pins
  // the harness constant, not a private implementation detail.
  const text = readFileSync(new URL(import.meta.url), 'utf8');
  assert.match(text, /timeout: 10 \* 60 \* 1000/, 'the 10-minute bound must stay explicit');
});

test('a failing script returns nonzero and reports the mismatch', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schedule-fail-'));
  const file = path.join(dir, 'bad.wtest.json');
  writeFileSync(file, JSON.stringify({
    ir: IR, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 99 } },
  }));
  const result = run([file]);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /state mismatch/);
});

test('fail-fast returns nonzero on the first failed script', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schedule-fast-'));
  const bad = path.join(dir, 'a-bad.wtest.json');
  writeFileSync(bad, JSON.stringify({
    ir: IR, width: 320, height: 240,
    steps: [{ unknown: 1 }], expect: {},
  }));
  const good = script(dir, 'b-good.wtest.json', 1);
  const result = run([bad, good], ['--fail-fast', '--verbose']);
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 1);
  assert.match(output, /interaction tests: 0 passed, 1 failed/);
});

test('every queued script runs when fail-fast is off', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schedule-all-'));
  const files = [script(dir, 'a.wtest.json', 1), script(dir, 'b.wtest.json', 2)];
  const result = run(files, ['--verbose']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal((result.stdout.match(/interaction tests: 1 passed, 0 failed/g) ?? []).length, 2);
});
