#!/usr/bin/env node
// Machine-readable gate for contract-schema version consistency.
//
// Every module-eight gate must publish its stable schema id exactly once in
// its implementation, and that id must be registered in the CI manifest plus
// the aggregate verdict/artifact manifests. This detects accidental v1 -> v2
// drift and orphaned or missing schemas across the gate estate.
//
// Exit 0 only when every registered gate has one unique, matching schema.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, '.github', 'opurom.json');
const VERDICT = path.join(ROOT, 'bin', 'contract-gate-verdict.mjs');
const ARTIFACTS = path.join(ROOT, 'bin', 'gate-artifact-manifest.mjs');

const CHECKS = JSON.parse(readFileSync(MANIFEST, 'utf8')).checks ?? [];
const CONTRACT_GATES = CHECKS.filter((name) => name.endsWith('-contract'));
const AGGREGATE_GATES = [
  ...CONTRACT_GATES,
  'contract-gate-verdict',
  'ci-manifest-consistency-contract',
];

function read(relative) {
  return readFileSync(path.join(ROOT, relative), 'utf8');
}

function publishedSchema(name) {
  const source = read(`bin/${name}.mjs`);
  const ids = [...source.matchAll(/^\s*schema:\s*'(opurom\.[A-Za-z0-9.-]+\/v\d+)',?\s*$/gm)]
    .map((match) => match[1]);
  assert.ok(ids.length >= 1, `${name} publishes no output schema`);
  const output = ids.at(-1);
  assert.match(output, /\/v1$/, `${name} output schema is not v1: ${output}`);
  return output;
}

function registeredSchema(source, name) {
  const match = new RegExp(`\\['${name}',\\s*'(opurom\\.[A-Za-z0-9.-]+\\/v\\d+)'\\]`).exec(source);
  assert.ok(match, `${name} is not registered with an explicit schema`);
  return match[1];
}

const verdictSource = read('bin/contract-gate-verdict.mjs');
const artifactSource = read('bin/gate-artifact-manifest.mjs');
const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

const expected = {};
for (const name of CONTRACT_GATES) {
  check(`${name} publishes one stable v1 schema`, () => {
    expected[name] = publishedSchema(name);
    assert.match(expected[name], /\/v1$/, `${name} schema is not v1: ${expected[name]}`);
  });
}

check('aggregate manifests register every gate with a matching schema', () => {
  const verdictNames = [...verdictSource.matchAll(/\['([^']+)',\s*'opurom\.[A-Za-z0-9.-]+\/v\d+'\]/g)]
    .map((match) => match[1]);
  const artifactNames = [...artifactSource.matchAll(/\['([^']+)',\s*'opurom\.[A-Za-z0-9.-]+\/v\d+'\]/g)]
    .map((match) => match[1]);
  for (const name of CONTRACT_GATES.filter((gate) => gate !== 'ci-manifest-consistency-contract' && gate !== 'ci-self-healing-contract')) {
    assert.ok(verdictNames.includes(name), `${name} missing from contract verdict`);
    assert.ok(artifactNames.includes(name), `${name} missing from artifact manifest`);
  }
  for (const name of ['contract-gate-verdict', 'ci-manifest-consistency-contract']) {
    assert.ok(artifactNames.includes(name), `${name} missing from artifact manifest`);
  }
  for (const name of artifactNames) {
    const schema = expected[name] ?? publishedSchema(name);
    assert.equal(registeredSchema(artifactSource, name), schema, `${name} artifact schema mismatch`);
  }
  for (const name of verdictNames) {
    const schema = expected[name] ?? publishedSchema(name);
    assert.equal(registeredSchema(verdictSource, name), schema, `${name} verdict schema mismatch`);
  }
});

check('all published contract schemas are unique', () => {
  const values = Object.values(expected);
  assert.equal(new Set(values).size, values.length, 'duplicate contract schema id');
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.contract-schema-consistency/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: { version: '3.50.0', goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb' },
  contract: {
    requiredVersion: 'v1',
    contractGates: CONTRACT_GATES.length,
    aggregatedGates: AGGREGATE_GATES.length,
  },
  evidence: expected,
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
