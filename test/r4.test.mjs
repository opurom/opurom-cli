import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import {
  formatInspectTable, formatProfileReport, inspect, parseFrameCount, percentile, profileStats,
} from '../lib/r4.mjs';

const FIXTURE_URL = new URL('./fixtures/inspect.opuir.json', import.meta.url);
const A11Y = [
  { id: 0, role: 'none', label: '', bounds: [0, 0, 800, 600], hidden: false },
  { id: 1, role: 'heading', label: 'Count: 0', bounds: [16, 16, 768, 28], hidden: false },
  { id: 2, role: 'button', label: '+', bounds: [16, 52, 80, 40], hidden: false },
];

const STUB = `#!/bin/sh
set -e
printf 'P6\\n1 1\\n255\\n' > "$4"
cat > "$6" <<'JSON'
[
  {"id":0,"role":"none","label":"","bounds":[0,0,800,600],"hidden":false},
  {"id":1,"role":"heading","label":"Count: 0","bounds":[16,16,768,28],"hidden":false},
  {"id":2,"role":"button","label":"+","bounds":[16,52,80,40],"hidden":false}
]
JSON
printf 'digest=0123456789abcdef\\n'
printf 'dirty=1\\n'
`;

test('percentiles interpolate known arrays and profile stats derive fps', () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.ok(Math.abs(percentile([1, 2, 3, 4, 5], 95) - 4.8) < 1e-12);
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.ok(Math.abs(percentile([10, 20, 30, 40], 95) - 38.5) < 1e-12);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, Number.NaN], 50), null);
  const stats = profileStats([10, 20, 30, 40]);
  assert.equal(stats.count, 4);
  assert.equal(stats.p50, 25);
  assert.ok(Math.abs(stats.p95 - 38.5) < 1e-12);
  assert.equal(stats.min, 10);
  assert.equal(stats.max, 40);
  assert.equal(stats.totalMs, 100);
  assert.equal(stats.fps, 40);
  assert.equal(profileStats([]), null);
});

test('frame count defaults to 30 and rejects values outside 1..600', () => {
  assert.equal(parseFrameCount(), 30);
  assert.equal(parseFrameCount('1'), 1);
  assert.equal(parseFrameCount('600'), 600);
  assert.equal(parseFrameCount(30), 30);
  for (const value of ['0', '-1', '601', '3.5', 'nope', true, Number.NaN, Infinity]) {
    assert.throws(() => parseFrameCount(value), /invalid --frames: .* \(expected 1\.\.600\)/);
  }
});

test('profile reports measured values or honest n/a reasons', () => {
  const measured = formatProfileReport({
    src: '/a/main.opu', frames: 4, stats: profileStats([10, 20, 30, 40]), reason: null,
  });
  assert.match(measured, /p50: 25 ms/);
  assert.match(measured, /achieved fps: 40 \(4 frames \/ 100 ms of measured frame time\)/);
  assert.match(measured, /software-raster timings on this host, NOT a device\/competitor benchmark/);
  const unavailable = formatProfileReport({
    src: '/a/main.opu', frames: 30, stats: null, reason: 'opurom-render not found',
  });
  for (const label of ['p50', 'p95', 'min', 'max', 'achieved fps']) {
    assert.match(unavailable, new RegExp(`${label}: n/a \\(opurom-render not found\\)`));
  }
  assert.match(unavailable, /frames: 0 measured \/ 30 requested/);
});

test('layer tree formatting is deterministic for the fixture IR', () => {
  const ir = JSON.parse(fs.readFileSync(FIXTURE_URL, 'utf8'));
  assert.equal(formatInspectTable(ir, A11Y, 1), [
    'Layer tree (id kind bounds dirty)     | A11y tree (id role label bounds hidden)',
    '------------------------------------- | ---------------------------------------',
    '0 Column [0,0,800,600] dirty=1 rect   | 0 none "" [0,0,800,600] hidden=false',
    '  1 Text [16,16,768,28] dirty=1 rect  |   1 heading "Count: 0" [16,16,768,28] hidden=false',
    '  2 Button [16,52,80,40] dirty=1 rect |   2 button "+" [16,52,80,40] hidden=false',
  ].join('\n'));
  assert.match(formatInspectTable(ir, A11Y, null), /dirty=n\/a \(renderer printed no dirty count\)/);
});

test('inspect renders the a11y tree without modifying the input IR bytes', () => {
  const base = tmpDir('r4-inspect-');
  try {
    const irFile = path.join(base, 'inspect.opuir.json');
    const renderer = path.join(base, 'opurom-render');
    fs.copyFileSync(FIXTURE_URL, irFile);
    fs.writeFileSync(renderer, STUB, { mode: 0o755 });
    const before = fs.readFileSync(irFile);
    const lines = [];
    const code = inspect({ ir: irFile, root: base, renderer, log: (line) => lines.push(String(line)) });
    const after = fs.readFileSync(irFile);
    assert.equal(code, 0);
    assert.ok(before.equals(after));
    const output = lines.join('\n');
    assert.match(output, /OPUROM inspect \(read-only; IR bytes unchanged\)/);
    assert.match(output, /dirty-rect status: 1 rect \(frame-wide\)/);
    assert.match(output, /0 Column \[0,0,800,600\] dirty=1 rect/);
    assert.match(output, /2 button "\+" \[16,52,80,40\] hidden=false/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
