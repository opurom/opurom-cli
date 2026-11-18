// Tests for the machine-readable stability resource contract gate.
// Flutter authority: 3.50.0 / ab2912035e,
// packages/flutter_test/lib/src/binding.dart:1326-1329,
// dev/devicelab/lib/framework/metrics_center.dart:103-113,
// dev/benchmarks/macrobenchmarks/test_driver/util.dart:38-70.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'stability-resource-contract.mjs');

function runGate(cwd = ROOT) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  assert.equal(run.error, undefined);
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch (error) {
    assert.fail(`gate stdout is not JSON: ${run.stdout}\n${run.stderr}\n${error.message}`);
  }
  return { status: run.status, json };
}

test('the stability resource gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.stability-resource-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.contract.timeoutMs, 600000);
  assert.equal(run.json.contract.renderRuns, 12);
  assert.equal(run.json.contract.replayEvents, 200);
  assert.equal(run.json.contract.digestRuns, 8);
  assert.ok(Number.isFinite(run.json.evidence.peakRssKb));
  assert.match(run.json.evidence.frameSha256, /^[0-9a-f]{64}$/);
  assert.equal(run.json.summary.total, 3);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the stability gate fails closed when the RSS ceiling drifts', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-stability-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    const lib = path.join(dir, 'lib');
    const golden = path.join(dir, 'opurom-examples', 'golden');
    const fixture = path.join(dir, 'tmp');
    const coreTarget = path.join(dir, 'opurom-core', 'target', 'debug');
    const renderTarget = path.join(dir, 'opurom-render', 'target', 'debug');
    for (const target of [bin, lib, golden, fixture, coreTarget, renderTarget]) {
      // Directories are created explicitly below where ordering matters.
      if (target !== fixture) continue;
    }
    // The gate resolves relatives from its own location, so copy it beside
    // real lib dependencies and place fake sibling binaries under dir.
    const original = readFileSync(GATE, 'utf8')
      .replace("from '../lib/process-metrics.mjs'", `from ${JSON.stringify(path.join(ROOT, 'lib', 'process-metrics.mjs'))}`)
      .replace("from '../lib/paths.mjs'", `from ${JSON.stringify(path.join(ROOT, 'lib', 'paths.mjs'))}`)
      .replace('const RSS_CEILING_KB = 512 * 1024;', 'const RSS_CEILING_KB = 1;');
    writeFileSync(path.join(dir, 'stability-resource-contract.mjs'), original);
    mkdirSync(golden, { recursive: true });
    writeFileSync(path.join(golden, 'counter.opuir.json'),
      readFileSync(path.join(ROOT, '..', 'opurom-examples', 'golden', 'counter.opuir.json'), 'utf8'));
    const run = spawnSync(process.execPath, [path.join(dir, 'stability-resource-contract.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL' && /RSS/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
