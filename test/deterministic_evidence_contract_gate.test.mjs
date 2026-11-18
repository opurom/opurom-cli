// Tests for the deterministic evidence field gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'deterministic-evidence-contract.mjs');

function runGate(cwd = ROOT) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

test('all contract gates emit deterministic evidence fields', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.deterministic-evidence-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.summary.total, 12);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('a timestamp in gate evidence fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-evidence-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const source = readFileSync(GATE, 'utf8')
      .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
        `const ROOT = ${JSON.stringify(dir)};`)
      .replace("const GATES = Object.freeze([", "const GATES = Object.freeze([\n  'evidence-drift',")
      .replace("function stableFields(value, trail = '') {", `function stableFields(value, trail = '') {
  if (value && value.generatedAt) return ['generatedAt'];`);
    writeFileSync(path.join(bin, 'deterministic-evidence-contract.mjs'), source);
    writeFileSync(path.join(dir, 'bin', 'evidence-drift.mjs'),
      "console.log(JSON.stringify({ schema: 'x/v1', status: 'PASS', evidence: { generatedAt: 'now' } }));\n");
    const run = spawnSync(process.execPath, [path.join(bin, 'deterministic-evidence-contract.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL' && /nondeterministic/.test(row.error ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
