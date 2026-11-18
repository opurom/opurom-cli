// Tests for the machine-readable gate artifact manifest.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'bin', 'gate-artifact-manifest.mjs');

function runManifest(out) {
  const run = spawnSync(process.execPath, [MANIFEST], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, OPUROM_GATE_ARTIFACTS: out, NODE_V8_COVERAGE: '' },
  });
  assert.equal(run.error, undefined);
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

test('the artifact manifest archives every gate with a content hash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-artifact-manifest-'));
  try {
    const run = runManifest(dir);
    assert.equal(run.status, 0);
    assert.equal(run.json.schema, 'opurom.gate-artifact-manifest/v1');
    assert.equal(run.json.status, 'PASS');
    assert.equal(run.json.summary.total, 12);
    assert.equal(run.json.summary.fail, 0);
    for (const artifact of run.json.artifacts) {
      assert.equal(artifact.status, 'PASS');
      assert.equal(artifact.exitCode, 0);
      assert.ok(existsSync(artifact.file), `${artifact.name} was not archived`);
      assert.equal(readFileSync(artifact.file).length, artifact.bytes);
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a gate schema drift is recorded as a FAIL artifact', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-artifact-drift-'));
  try {
    const bin = path.join(dir, 'bin');
    const out = path.join(dir, 'artifacts');
    // Copy only the aggregator; point it at the real ROOT through a patched
    // constant and mutate one expected schema.
    const source = readFileSync(MANIFEST, 'utf8')
      .replace("const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');",
        `const ROOT = ${JSON.stringify(ROOT)};`)
      .replace("['performance-phase-contract', 'opurom.performance-phase-contract/v1']",
        "['performance-phase-contract', 'opurom.drifted-schema/v1']");
    const file = path.join(bin, 'gate-artifact-manifest.mjs');
    // bin directory is unused because ROOT is patched, but keep the copy layout.
    void file;
    const patched = path.join(dir, 'gate-artifact-manifest.mjs');
    mkdirSync(path.dirname(patched), { recursive: true });
    writeFileSync(patched, source);
    const run = spawnSync(process.execPath, [patched], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, OPUROM_GATE_ARTIFACTS: out, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
    assert.equal(json.artifacts[0].status, 'FAIL');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
