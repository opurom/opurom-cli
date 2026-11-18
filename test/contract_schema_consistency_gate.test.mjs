// Tests for the cross-gate schema version consistency gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'contract-schema-consistency.mjs');

function runGate(cwd = ROOT) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '' },
  });
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

test('all module-eight contract schemas are stable v1 and registered', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.contract-schema-consistency/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.contract.requiredVersion, 'v1');
  assert.ok(run.json.contract.contractGates >= 12);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(Object.values(run.json.evidence).every((schema) => /\/v1$/.test(schema)));
});

test('a v2 schema drift fails closed', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-schema-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    const manifest = JSON.parse(readFileSync(path.join(ROOT, '.github', 'opurom.json'), 'utf8'));
    writeFileSync(path.join(dir, '.github-opurom.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const source = readFileSync(GATE, 'utf8')
      .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
        `const ROOT = ${JSON.stringify(ROOT)};`)
      .replace("const MANIFEST = path.join(ROOT, '.github', 'opurom.json');",
        `const MANIFEST = ${JSON.stringify(path.join(dir, '.github-opurom.json'))};`)
      .replace("function read(relative) {\n  return readFileSync(path.join(ROOT, relative), 'utf8');\n}",
        `function read(relative) {\n  const source = readFileSync(path.join(ROOT, relative), 'utf8');\n  return relative === 'bin/flutter-provenance-contract.mjs'\n    ? source.replace('opurom.flutter-provenance-contract/v1', 'opurom.flutter-provenance-contract/v2')\n    : source;\n}`);
    const file = path.join(bin, 'contract-schema-consistency.mjs');
    writeFileSync(file, source);
    const run = spawnSync(process.execPath, [file], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.ok(json.checks.some((row) => row.status === 'FAIL' && /v1/.test(row.error ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
