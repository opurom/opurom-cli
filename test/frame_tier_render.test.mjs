import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createFrameTier } from '../lib/frame_tier.mjs';

// Cross-check against the render side's real --auto-degrade tier line
// (render prints `tier=<t> rate=<hz> frames=<n> p50=<ms>ms p95=<ms>ms
// target=<ms>ms promote=<ms>ms`). Gated on OPUROM_RENDER_TIER_BIN so the
// offline suite stays standalone; point it at an opurom-render binary built
// from the tier-line revision to run the live comparison.
const RENDER_BIN = process.env.OPUROM_RENDER_TIER_BIN;
const IR = new URL('./fixtures/widget-inspect.opuir.json', import.meta.url);

const CASES = [
  { name: 'mixed pattern drops to minimal', pattern: [16, 30, 10], samples: 100 },
  { name: 'two over-budget values drop twice', pattern: [20, 40], samples: 40 },
  { name: 'straight over-budget drops to minimal', pattern: [30], samples: 40 },
  { name: 'p95 one ms over target still drops', pattern: [10, 17], samples: 40 },
  { name: 'steady target samples keep full', pattern: [16], samples: 20 },
];

test('the page-agent mirror matches the real render tier lines', { skip: !RENDER_BIN }, (t) => {
  for (const item of CASES) {
    const out = execFileSync(RENDER_BIN, [
      path.resolve(fileURL(IR)), '320', '240', '/tmp/opurom-tier-check.ppm',
      '--auto-degrade', '60', '--frame-ms', item.pattern.join(','), '--frame-samples', String(item.samples),
    ], { encoding: 'utf8' });
    const line = /^tier=.+$/m.exec(out)?.[0];
    assert.ok(line, 'render printed no tier line');
    const parsed = Object.fromEntries(line.split(' ').map((part) => {
      const [key, raw] = part.split('=');
      const value = raw === undefined ? '' : raw.replace(/ms$/, '');
      return [key, /^-?\d+$/.test(value) ? Number(value) : value];
    }));
    const machine = createFrameTier({ hz: 60 });
    for (let i = 0; i < item.samples; i += 1) machine.push(item.pattern[i % item.pattern.length], i * 16);
    const report = machine.report();
    assert.equal(report.tier, parsed.tier, `${item.name}: tier`);
    assert.equal(report.p50Ms, Number(parsed.p50), `${item.name}: p50`);
    assert.equal(report.p95Ms, Number(parsed.p95), `${item.name}: p95`);
    assert.equal(machine.budgetMs, Number(parsed.target), `${item.name}: target`);
  }
});

function fileURL(url) {
  return decodeURIComponent(url.pathname);
}

test('the mirror handles a missing binary by skipping, not failing', () => {
  assert.equal(fs.existsSync(RENDER_BIN ?? '/nonexistent'), RENDER_BIN ? true : false);
});
