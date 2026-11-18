// Tests for the machine-readable provenance citation consistency gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'provenance-citation-consistency.mjs');

function runGate(cwd = ROOT) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  assert.equal(run.error, undefined);
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

test('module-eight citations resolve through the authoritative registry', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.provenance-citation-consistency/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.summary.registeredAnchors >= 28);
  assert.deepEqual(run.json.findings, []);
});

test('an unregistered citation fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-citation-gate-'));
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  try {
    writeFileSync(path.join(bin, 'flutter-provenance-contract.mjs'),
      readFileSync(path.join(ROOT, 'bin', 'flutter-provenance-contract.mjs'), 'utf8'));
    const gateSource = readFileSync(GATE, 'utf8')
      .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
        `const ROOT = ${JSON.stringify(dir)};`)
      .replace("const FILES = GUARDED_FILES.map((relative) => path.join(ROOT, relative));", "const FILES = [path.join(ROOT, 'bin/citation-drift.mjs')];");
    writeFileSync(path.join(bin, 'provenance-citation-consistency.mjs'), gateSource);
    writeFileSync(path.join(bin, 'citation-drift.mjs'),
      '// packages/flutter_test/lib/src/goldens.dart:9999-10000\n');
    const second = spawnSync(process.execPath, [path.join(bin, 'provenance-citation-consistency.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(second.status, 1);
    const json = JSON.parse(second.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.findings.some((finding) => /9999-10000/.test(finding.citation)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
