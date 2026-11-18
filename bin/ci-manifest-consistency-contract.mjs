#!/usr/bin/env node
// Machine-readable gate for CI manifest consistency.
//
// Quality-gate layer only: it reads the CI manifests and verifies that every
// check name is registered in all three authoritative places. It does not
// edit the manifests. Flutter 3.50.0 / ab2912035e provenance is inherited from
// the gates under test.
//
// Exit 0 only when the three check sets are identical and every dispatcher
// name resolves to an executable check command.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'ci.yml');
const DISPATCHER = path.join(ROOT, '.github', 'scripts', 'ci-check.mjs');
const MANIFEST = path.join(ROOT, '.github', 'opurom.json');

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

const workflow = readFileSync(WORKFLOW, 'utf8');
const dispatcher = readFileSync(DISPATCHER, 'utf8');
const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
let matrix = [];
let dispatched = [];

check('workflow matrix declares an ordered check list', () => {
  const match = /check:\s*\[([^\]]+)\]/.exec(workflow);
  assert.ok(match, 'workflow matrix check list not found');
  matrix = match[1].split(',').map((entry) => entry.trim()).filter(Boolean);
  assert.ok(matrix.length >= 5, `too few workflow checks: ${matrix.length}`);
});

check('every manifest check is dispatched exactly once', () => {
  dispatched = [...dispatcher.matchAll(/name === '([^']+)'/g)].map((match) => match[1]);
  const duplicates = dispatched.filter((name, index) => dispatched.indexOf(name) !== index);
  assert.deepEqual(duplicates, [], `duplicate dispatcher branches: ${duplicates.join(', ')}`);
  for (const name of manifest.checks ?? []) {
    assert.equal(dispatched.filter((entry) => entry === name).length, 1,
      `${name} must have exactly one ci-check.mjs dispatcher branch`);
  }
});

check('workflow matrix, dispatcher and opurom.json declare identical check sets', () => {
  const manifestNames = [...(manifest.checks ?? [])];
  const unique = (list) => [...new Set(list)].sort();
  assert.deepEqual(unique(matrix), unique(manifestNames));
  assert.deepEqual(unique(dispatched), unique(manifestNames));
  assert.equal(matrix.length, unique(matrix).length, 'workflow matrix has duplicates');
  assert.equal(manifestNames.length, unique(manifestNames).length, 'opurom.json has duplicates');
});

check('every gate check has a runnable implementation', () => {
  for (const name of manifest.checks ?? []) {
    if (!name.endsWith('contract') && name !== 'contract-gate-verdict') continue;
    assert.ok(dispatcher.includes(`run('node', ['bin/${name}.mjs'])`),
      `${name} is not dispatched to a bin entry`);
  }
});

const CONTRACT_GATES = [
  ['performance-phase-contract', 'opurom.performance-phase-contract/v1'],
  ['test-scheduling-contract', 'opurom.test-scheduling-contract/v1'],
  ['golden-failure-contract', 'opurom.golden-failure-contract/v1'],
  ['gesture-timing-contract', 'opurom.gesture-timing-contract/v1'],
  ['cross-target-artifact-contract', 'opurom.cross-target-artifact-contract/v1'],
  ['fuzz-input-corpus-contract', 'opurom.fuzz-input-corpus-contract/v1'],
  ['stability-resource-contract', 'opurom.stability-resource-contract/v1'],
  ['report-archive-integrity-contract', 'opurom.report-archive-integrity-contract/v1'],
  ['flutter-provenance-contract', 'opurom.flutter-provenance-contract/v1'],
  ['provenance-citation-consistency', 'opurom.provenance-citation-consistency/v1'],
  ['contract-schema-consistency', 'opurom.contract-schema-consistency/v1'],
  ['deterministic-evidence-contract', 'opurom.deterministic-evidence-contract/v1'],
  ['ci-self-healing-contract', 'opurom.ci-self-healing-contract/v1'],
  ['component-motion-recipe-contract', 'opurom.component-motion-recipe-contract/v1'],
];
const ARTIFACT_GATES = [...CONTRACT_GATES.map(([name]) => name), 'contract-gate-verdict', 'ci-manifest-consistency-contract'];

check('verdict and artifact manifest contain every registered contract gate', () => {
  for (const [name, schema] of CONTRACT_GATES) {
    assert.ok(manifest.checks.includes(name), `${name} missing from manifest`);
    assert.ok(dispatcher.includes(`run('node', ['bin/${name}.mjs'])`), `${name} missing dispatcher`);
    assert.ok(workflow.includes(name), `${name} missing workflow matrix`);
    assert.ok(schema.startsWith('opurom.'), `${name} has invalid schema ${schema}`);
  }
  for (const name of ARTIFACT_GATES) {
    assert.ok(manifest.checks.includes(name), `${name} missing from artifact manifest scope`);
  }
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.ci-manifest-consistency-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: { version: '3.50.0', goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb' },
  sources: {
    workflow: '.github/workflows/ci.yml',
    dispatcher: '.github/scripts/ci-check.mjs',
    manifest: '.github/opurom.json',
  },
  evidence: { matrix, dispatched, manifestChecks: manifest.checks ?? [] },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
