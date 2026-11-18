// Memory and stability gate for repeated interaction workloads.
//
// Flutter authority: long-run performance work in Flutter uses repeated real
// frames and compares resource samples instead of trusting a single run
// (dev/benchmarks/macrobenchmarks/test_driver/util.dart:38-70, 3.50.0 /
// ab2912035e). Opurom already exposes measured peak RSS through
// opurom-cli/lib/process-metrics.mjs:214-234 and aggregateResources
// (:256-278). This gate drives many real renderer processes through the
// published CLI and checks that neither memory nor output drifts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { aggregateResources, measureRendererResources } from '../lib/process-metrics.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = workspaceRoot(CLI_ROOT);
const IR = path.join(ROOT, 'opurom-examples', 'golden', 'counter.opuir.json');
const CORE = path.join(ROOT, 'opurom-core', 'target', 'debug', 'opurom-core');

function renderer() {
  for (const profile of ['debug', 'release']) {
    for (const name of ['opurom-render', 'opurom_render']) {
      const file = path.join(ROOT, 'opurom-render', 'target', profile, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function core() {
  return existsSync(CORE) ? CORE : null;
}

test('repeated renders keep a bounded memory profile', () => {
  const exe = renderer();
  assert.ok(exe, 'opurom-render binary is required for the stability gate');
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-stability-render-'));
  const out = path.join(dir, 'frame.ppm');
  const runs = [];
  for (let i = 0; i < 12; i += 1) {
    const measured = measureRendererResources({ renderBin: exe, args: [IR, '160', '120', out] });
    assert.equal(measured.result.status, 0, `render ${i} failed`);
    runs.push(measured.resource);
  }
  const aggregate = aggregateResources(runs);
  assert.ok(aggregate.memory.peakRssKb !== null,
    `no measured RSS: ${aggregate.memory.reason}`);
  // A deterministic 160x120 frame must not need hundreds of megabytes. The
  // threshold is a stability ceiling, not a performance claim.
  assert.ok(aggregate.memory.peakRssKb < 512 * 1024,
    `peak RSS ${aggregate.memory.peakRssKb} kB is unbounded`);
});

test('a long interaction replay leaves no error and a stable final state', () => {
  const exe = core();
  assert.ok(exe, 'opurom-core binary is required for the stability gate');
  const commands = [];
  for (let i = 0; i < 200; i += 1) commands.push('tap 4');
  commands.push('state', 'quit');
  const result = spawnSync(exe, [IR], { input: `${commands.join('\n')}\n`, encoding: 'utf8' });
  assert.equal(result.status, 0, `replay failed: ${result.stderr || result.stdout}`);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  assert.ok(!/error:/i.test(output), `replay emitted an error: ${output.slice(-500)}`);
  const states = output.split(/\r?\n/).filter((line) => line.startsWith('state '));
  const final = JSON.parse(states.at(-1).slice('state '.length, states.at(-1).lastIndexOf(' version ')));
  const count = final.find((entry) => entry.name === 'count');
  assert.ok(count, 'counter state missing after replay');
  assert.equal(count.value, 200, 'replayed taps must all be applied exactly once');
});

test('repeated renderer processes produce byte-identical frames', () => {
  const exe = renderer();
  assert.ok(exe, 'opurom-render binary is required for the stability gate');
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-stability-digest-'));
  const frames = [];
  for (let i = 0; i < 8; i += 1) {
    const out = path.join(dir, `frame-${i}.ppm`);
    const run = spawnSync(exe, [IR, '320', '240', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, `render ${i} failed: ${run.stderr || run.stdout}`);
    frames.push(readFileSync(out));
  }
  assert.ok(frames.every((frame) => frame.equals(frames[0])),
    'deterministic rendering drifted across repeated processes');
});
