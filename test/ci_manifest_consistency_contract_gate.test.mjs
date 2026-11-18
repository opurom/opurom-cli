// Tests for the CI manifest consistency contract gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'ci-manifest-consistency-contract.mjs');

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

test('the CI manifest gate emits a passing machine-readable report', () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.ci-manifest-consistency-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.deepEqual(run.json.evidence.matrix, run.json.evidence.manifestChecks);
  assert.equal(run.json.summary.total, 5);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the CI manifest gate fails closed when a manifest check is missing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-ci-manifest-gate-'));
  try {
    const bin = path.join(dir, 'bin');
    const github = path.join(dir, '.github');
    mkdirSync(bin, { recursive: true });
    mkdirSync(path.join(github, 'workflows'), { recursive: true });
    mkdirSync(path.join(github, 'scripts'), { recursive: true });
    writeFileSync(path.join(bin, 'ci-manifest-consistency-contract.mjs'),
      readFileSync(GATE, 'utf8'));
    writeFileSync(path.join(github, 'workflows', 'ci.yml'),
      readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'));
    writeFileSync(path.join(github, 'scripts', 'ci-check.mjs'),
      readFileSync(path.join(ROOT, '.github', 'scripts', 'ci-check.mjs'), 'utf8'));
    const manifest = JSON.parse(readFileSync(path.join(ROOT, '.github', 'opurom.json'), 'utf8'));
    manifest.checks.push('missing-from-workflow');
    writeFileSync(path.join(github, 'opurom.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    const run = spawnSync(process.execPath, [path.join(bin, 'ci-manifest-consistency-contract.mjs')], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NODE_V8_COVERAGE: '' },
    });
    assert.equal(run.status, 1);
    const json = JSON.parse(run.stdout);
    assert.equal(json.status, 'FAIL');
    assert.ok(json.summary.fail >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
