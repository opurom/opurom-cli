#!/usr/bin/env node
// Machine-readable gate for memory and stability resources.
//
// Quality-gate layer only: it drives published binaries and reads emitted
// frames; it does not change renderer or metrics implementations.
// Flutter authority (3.50.0, flutter-golden
// ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_test/lib/src/binding.dart:1326-1329 pins a bounded
//   automated test timeout (10 minutes).
// - dev/devicelab/lib/framework/metrics_center.dart:103-113 archives measured
//   resource samples as machine-readable metrics.
// - dev/benchmarks/macrobenchmarks/test_driver/util.dart:38-70 samples real
//   repeated frames instead of trusting one run.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { aggregateResources, measureRendererResources } from '../lib/process-metrics.mjs';
import { ensureSiblingBinary, workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = workspaceRoot(CLI_ROOT);
const IR = path.join(ROOT, 'opurom-examples', 'golden', 'counter.opuir.json');
const RSS_CEILING_KB = 512 * 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

function binary(repo, names) {
  const found = ensureSiblingBinary(repo, names, { root: ROOT, log: () => {} });
  assert.ok(!found.skip, `${repo} source is required for the stability gate: ${found.reason}`);
  assert.ok(found.path, `${repo} binary is required for the stability gate: ${found.reason}`);
  return found.path;
}

const dir = mkdtempSync(path.join(tmpdir(), 'opurom-stability-contract-'));
let peakRssKb = null;
let peakRssMb = null;
let frameDigest = null;
try {
  check('repeated renders keep a bounded measured RSS', () => {
    const exe = binary('opurom-render', ['opurom-render', 'opurom_render']);
    const out = path.join(dir, 'frame.ppm');
    const runs = [];
    for (let i = 0; i < 12; i += 1) {
      const measured = measureRendererResources({
        renderBin: exe,
        args: [IR, '160', '120', out],
        timeout: TEST_TIMEOUT_MS / 12,
      });
      assert.equal(measured.result.status, 0, `render ${i} failed`);
      runs.push(measured.resource);
    }
    const aggregate = aggregateResources(runs);
    assert.ok(aggregate.memory.peakRssKb !== null,
      `no measured RSS: ${aggregate.memory.reason}`);
    assert.ok(aggregate.memory.peakRssKb < RSS_CEILING_KB,
      `peak RSS ${aggregate.memory.peakRssKb} kB exceeds ${RSS_CEILING_KB} kB`);
    peakRssKb = aggregate.memory.peakRssKb;
    peakRssMb = aggregate.memory.peakRssMb;
  });

  check('a long interaction replay applies every event exactly once', () => {
    const exe = binary('opurom-core', ['opurom-core', 'opurom_core']);
    const commands = Array.from({ length: 200 }, () => 'tap 4');
    commands.push('state', 'quit');
    const run = spawnSync(exe, [IR], {
      input: `${commands.join('\n')}\n`,
      encoding: 'utf8',
      timeout: TEST_TIMEOUT_MS,
    });
    assert.equal(run.status, 0, `replay failed: ${run.stderr || run.stdout}`);
    const output = `${run.stdout || ''}${run.stderr || ''}`;
    assert.ok(!/error:/i.test(output), `replay emitted an error: ${output.slice(-500)}`);
    const states = output.split(/\r?\n/).filter((line) => line.startsWith('state '));
    const final = JSON.parse(states.at(-1).slice('state '.length, states.at(-1).lastIndexOf(' version ')));
    const count = final.find((entry) => entry.name === 'count');
    assert.ok(count, 'counter state missing after replay');
    assert.equal(count.value, 200);
  });

  check('renderer processes produce byte-identical frame digests', () => {
    const exe = binary('opurom-render', ['opurom-render', 'opurom_render']);
    const digests = [];
    for (let i = 0; i < 8; i += 1) {
      const out = path.join(dir, `frame-${i}.ppm`);
      const run = spawnSync(exe, [IR, '320', '240', out], {
        encoding: 'utf8',
        timeout: TEST_TIMEOUT_MS / 8,
      });
      assert.equal(run.status, 0, `render ${i} failed: ${run.stderr || run.stdout}`);
      digests.push(createHash('sha256').update(readFileSync(out)).digest('hex'));
    }
    assert.ok(digests.every((digest) => digest === digests[0]),
      'deterministic rendering drifted across repeated processes');
    frameDigest = digests[0];
  });
} finally {
  // Keep the OS-managed temp directory for postmortem when a check fails.
}

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.stability-resource-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: [
      'packages/flutter_test/lib/src/binding.dart:1326-1329',
      'dev/devicelab/lib/framework/metrics_center.dart:103-113',
      'dev/benchmarks/macrobenchmarks/test_driver/util.dart:38-70',
    ],
  },
  contract: {
    timeoutMs: TEST_TIMEOUT_MS,
    renderRuns: 12,
    replayEvents: 200,
    digestRuns: 8,
    peakRssCeilingKb: RSS_CEILING_KB,
  },
  evidence: { peakRssKb, peakRssMb, frameSha256: frameDigest },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
