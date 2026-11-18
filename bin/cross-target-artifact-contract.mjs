#!/usr/bin/env node
// Machine-readable gate for cross-target artifact determinism.
//
// Quality-gate layer only: it drives the published CLI and reads emitted
// artifacts; it does not change compiler emitters.
// Opurom authority (Flutter 3.50.0 / ab2912035e parity):
// - architecture red line: IR is the single source of truth; all emitters
//   lower the same IR without target-specific source mutation.
// - opurom-spec/FLUTTER_PARITY_MASTER.md:28-33 records that rule.
// - opurom-cli/lib/targets.mjs:5-16 declares the supported target set.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceRoot } from '../lib/paths.mjs';
import { TARGETS } from '../lib/targets.mjs';

const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');
const SOURCE = path.join(ROOT, 'opurom-examples', 'golden', 'counter.opu');

const EXPECTED_TARGETS = Object.freeze([
  'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
  'wasm', 'harmony',
]);
const EXPECTED_FILES = Object.freeze({
  web: ['app.js', 'index.html', 'ir.json'],
  wechat: ['app.js', 'app.json', 'pages/index/index.js', 'pages/index/index.wxml', 'pages/index/index.wxss'],
  alipay: ['app.js', 'app.json', 'pages/index/index.acss', 'pages/index/index.axml', 'pages/index/index.js'],
});

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

function build(target, out) {
  return spawnSync(process.execPath, [CLI, 'build', '--src', SOURCE, '--target', target, '--out', out], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
}

check('declared target set is complete and ordered', () => {
  assert.deepEqual(TARGETS, EXPECTED_TARGETS);
});

const digests = {};
const dir = mkdtempSync(path.join(tmpdir(), 'opurom-cross-target-contract-'));
try {
  const sourceBefore = readFileSync(SOURCE, 'utf8');
  const digests = {};
  for (const [target, files] of Object.entries(EXPECTED_FILES)) {
    check(`${target} emits a complete artifact set with stable bytes`, () => {
      const first = path.join(dir, `${target}-a`);
      const second = path.join(dir, `${target}-b`);
      const a = build(target, first);
      const b = build(target, second);
      assert.equal(a.status, 0, `${target} first build failed: ${a.stdout}${a.stderr}`);
      assert.equal(b.status, 0, `${target} second build failed: ${b.stdout}${b.stderr}`);
      for (const file of files) {
        const one = path.join(first, file);
        const two = path.join(second, file);
        assert.ok(existsSync(one), `${target} missing ${file}`);
        assert.deepEqual(readFileSync(one), readFileSync(two), `${target}/${file} drifted between runs`);
      }
      digests[target] = Object.fromEntries(files.map((file) => [file, {
        bytes: readFileSync(path.join(first, file)).length,
      }]));
    });
  }

  check('cross-target builds never mutate the source IR input', () => {
    assert.equal(readFileSync(SOURCE, 'utf8'), sourceBefore);
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.cross-target-artifact-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: [
      'opurom-spec/FLUTTER_PARITY_MASTER.md:28-33',
      'opurom-cli/lib/targets.mjs:5-16',
    ],
  },
  contract: {
    targets: EXPECTED_TARGETS,
    emittedArtifacts: EXPECTED_FILES,
    singleSourceOfTruth: true,
  },
  artifacts: digests,
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
