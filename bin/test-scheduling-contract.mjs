#!/usr/bin/env node
// Machine-readable gate for Opurom's automated test scheduling contract.
//
// Quality-gate layer only: it verifies the published runner contract and the
// CI harness bound; it does not modify the runner implementation.
// Flutter authority (3.50.0, flutter-golden
// ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_test/lib/src/binding.dart:1326-1329 — automated `flutter
//   test` default timeout is 10 minutes.
// - packages/flutter_test/lib/src/binding.dart:2345-2347 — live/debug tooling
//   may opt into an unlimited timeout.
// - packages/flutter_test/lib/src/binding.dart:1070/2295 — automated vs live
//   binding selection; a non-run script must never be reported as a pass.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'opurom.mjs');
const IR = path.join(ROOT, '..', 'opurom-examples', 'golden', 'counter.opuir.json');
const checks = [];

function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

check('the CI harness pins the Flutter automated 10-minute bound', () => {
  const text = readFileSync(path.join(ROOT, 'test', 'test_scheduling_gate.test.mjs'), 'utf8');
  assert.match(text, /timeout: 10 \* 60 \* 1000/);
});

check('fail-fast reports zero passes and a nonzero exit when a queued script fails', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schedule-contract-'));
  try {
    const bad = path.join(dir, 'a-bad.wtest.json');
    const good = path.join(dir, 'b-good.wtest.json');
    writeFileSync(bad, JSON.stringify({
      ir: IR, width: 320, height: 240,
      steps: [{ unknown: 1 }], expect: {},
    }));
    writeFileSync(good, JSON.stringify({
      ir: IR, width: 320, height: 240,
      steps: [{ tap: 4 }], expect: { state: { count: 1 } },
    }));
    // The published CLI widget flag accepts one file or a directory, so the
    // directory form is the contract under test for queued scripts.
    const run = spawnSync(process.execPath, [CLI, 'test', '--widget', dir, '--fail-fast', '--verbose'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 1, output);
    assert.match(output, /interaction tests: 0 passed, 1 failed, 1 skipped/);
    assert.equal((output.match(/not run \(--fail-fast\)/g) ?? []).length, 0,
      'SKIP rows must not be described as passes');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check('without fail-fast every queued script runs and is counted once', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schedule-contract-all-'));
  try {
    const files = [1, 2].map((count) => {
      const file = path.join(dir, `b-${count}.wtest.json`);
      writeFileSync(file, JSON.stringify({
        ir: IR, width: 320, height: 240,
        steps: Array.from({ length: count }, () => ({ tap: 4 })),
        expect: { state: { count } },
      }));
      return file;
    });
    const run = spawnSync(process.execPath, [CLI, 'test', '--widget', dir, '--verbose'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
    });
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.equal(run.status, 0, output);
    assert.equal((output.match(/^PASS\s/gm) ?? []).length, 2);
    assert.match(output, /interaction tests: 2 passed, 0 failed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.test-scheduling-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    channel: 'flutter-3.50-candidate.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: [
      'packages/flutter_test/lib/src/binding.dart:1326-1329',
      'packages/flutter_test/lib/src/binding.dart:2345-2347',
      'packages/flutter_test/lib/src/binding.dart:1070/2295',
    ],
  },
  contract: {
    automatedTimeoutMs: 10 * 60 * 1000,
    liveDebugTimeout: 'unlimited (debugger-attached tooling only)',
    runner: 'opurom-cli/lib/widget_test.mjs:155-182',
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
