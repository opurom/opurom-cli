// Tests for the machine-readable evidence bounds contract.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'evidence-bounds-contract.mjs');

function runGate(cwd = ROOT) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  return { status: run.status, json: JSON.parse(run.stdout) };
}

test('all gate evidence stays within fixed structural bounds', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.evidence-bounds-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.contract.maxBytes, 256 * 1024);
  assert.equal(run.json.contract.maxDepth, 12);
  assert.equal(run.json.summary.total, 13);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.gates.every((gate) => gate.status === 'PASS' && gate.bytes > 0));
});

test('an oversized artifact fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-bounds-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const source = readFileSync(GATE, 'utf8')
      .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
        `const ROOT = ${JSON.stringify(dir)};`)
      .replace('const MAX_BYTES = 256 * 1024;', 'const MAX_BYTES = 32;');
    writeFileSync(path.join(bin, 'evidence-bounds-contract.mjs'), source);
    writeFileSync(path.join(bin, 'performance-phase-contract.mjs'),
      "console.log(JSON.stringify({ schema: 'x/v1', status: 'PASS', checks: Array(100).fill({ name: 'x', status: 'PASS' }) }));\n");
    writeFileSync(path.join(bin, 'test-scheduling-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'golden-failure-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'gesture-timing-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'cross-target-artifact-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'fuzz-input-corpus-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'stability-resource-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'report-archive-integrity-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'flutter-provenance-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'provenance-citation-consistency.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'ci-self-healing-contract.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'contract-schema-consistency.mjs'), "console.log('{}');\n");
    writeFileSync(path.join(bin, 'deterministic-evidence-contract.mjs'), "console.log('{}');\n");
    const run = spawnSync(process.execPath, [path.join(bin, 'evidence-bounds-contract.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.gates[0].violations.some((item) => item.startsWith('bytes=')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
