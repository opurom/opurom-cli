#!/usr/bin/env node
// Machine-readable evidence archive for every module-eight contract gate.
//
// Runs each gate, writes its JSON output to a deterministic archive directory
// and emits one manifest with byte sizes and sha256 digests. This gate is
// read-only with respect to implementations and untracked output paths.
//
// Exit 0 only when every gate reports PASS with the expected schema.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.OPUROM_GATE_ARTIFACTS ?? path.join('artifacts', 'gate-contracts'));
const GATES = Object.freeze([
  ['performance-phase-contract', 'opurom.performance-phase-contract/v1'],
  ['test-scheduling-contract', 'opurom.test-scheduling-contract/v1'],
  ['golden-failure-contract', 'opurom.golden-failure-contract/v1'],
  ['gesture-timing-contract', 'opurom.gesture-timing-contract/v1'],
  ['cross-target-artifact-contract', 'opurom.cross-target-artifact-contract/v1'],
  ['fuzz-input-corpus-contract', 'opurom.fuzz-input-corpus-contract/v1'],
  ['stability-resource-contract', 'opurom.stability-resource-contract/v1'],
  ['report-archive-integrity-contract', 'opurom.report-archive-integrity-contract/v1'],
  ['contract-gate-verdict', 'opurom.contract-gate-verdict/v1'],
  ['ci-manifest-consistency-contract', 'opurom.ci-manifest-consistency-contract/v1'],
  ['flutter-provenance-contract', 'opurom.flutter-provenance-contract/v1'],
  ['provenance-citation-consistency', 'opurom.provenance-citation-consistency/v1'],
  ['contract-schema-consistency', 'opurom.contract-schema-consistency/v1'],
]);

mkdirSync(OUT, { recursive: true });
const artifacts = GATES.map(([name, schema]) => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', `${name}.mjs`)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  let json = null;
  let parseError = null;
  try {
    json = JSON.parse(run.stdout);
  } catch (error) {
    parseError = error.message;
  }
  const healthy = run.status === 0 && !run.error && !parseError
    && json?.schema === schema && json?.status === 'PASS';
  const bytes = Buffer.from(run.stdout || '');
  const file = path.join(OUT, `${name}.json`);
  writeFileSync(file, bytes);
  const archived = readFileSync(file);
  return {
    name,
    schema,
    file,
    bytes: archived.length,
    sha256: createHash('sha256').update(archived).digest('hex'),
    status: healthy ? 'PASS' : 'FAIL',
    exitCode: run.status,
    error: parseError ?? run.error?.message ?? (healthy ? null : (json?.status ?? 'gate did not report PASS')),
  };
});

const failed = artifacts.filter((artifact) => artifact.status === 'FAIL').length;
const manifest = {
  schema: 'opurom.gate-artifact-manifest/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    provenance: 'inherited from archived gate documents',
  },
  outputDirectory: OUT,
  summary: { total: artifacts.length, pass: artifacts.length - failed, fail: failed },
  artifacts,
};
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
