#!/usr/bin/env node
// Machine-readable gate that bounds contract evidence size and structure.
//
// Evidence must stay auditable and cheap: every gate JSON needs a stable
// maximum byte size, nesting depth, array length and key count. Exceeding a
// bound is a hard FAIL rather than a slow CI artifact.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 256 * 1024;
const MAX_DEPTH = 12;
const MAX_ARRAY_ITEMS = 1024;
const MAX_KEYS_PER_OBJECT = 128;
const GATES = Object.freeze([
  'performance-phase-contract',
  'test-scheduling-contract',
  'golden-failure-contract',
  'gesture-timing-contract',
  'cross-target-artifact-contract',
  'fuzz-input-corpus-contract',
  'stability-resource-contract',
  'report-archive-integrity-contract',
  'flutter-provenance-contract',
  'provenance-citation-consistency',
  'ci-self-healing-contract',
  'contract-schema-consistency',
  'deterministic-evidence-contract',
]);

function measure(value, depth = 0) {
  if (depth > MAX_DEPTH) return { depth: depth + 1, arrays: 0, keys: 0 };
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS + 1).reduce((acc, item) => {
      const child = measure(item, depth + 1);
      return {
        depth: Math.max(acc.depth, child.depth),
        arrays: Math.max(acc.arrays, value.length),
        keys: Math.max(acc.keys, child.keys),
      };
    }, { depth: depth + 1, arrays: value.length, keys: 0 });
  }
  if (!value || typeof value !== 'object') return { depth: depth + 1, arrays: 0, keys: 0 };
  const entries = Object.entries(value);
  return entries.reduce((acc, [, child]) => {
    const nested = measure(child, depth + 1);
    return {
      depth: Math.max(acc.depth, nested.depth),
      arrays: Math.max(acc.arrays, nested.arrays),
      keys: Math.max(acc.keys, nested.keys),
    };
  }, { depth: depth + 1, arrays: 0, keys: entries.length });
}

const gates = GATES.map((name) => {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', `${name}.mjs`)], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 10 * 60 * 1000,
  });
  let json = null;
  try {
    json = JSON.parse(run.stdout);
  } catch {
    // Invalid JSON is handled by the schema gates; report a bounded failure.
  }
  const bytes = Buffer.byteLength(run.stdout);
  const shape = json ? measure(json) : { depth: 0, arrays: 0, keys: 0 };
  const violations = [];
  if (run.status !== 0) violations.push('nonzero exit');
  if (!json) violations.push('invalid JSON');
  if (bytes > MAX_BYTES) violations.push(`bytes=${bytes}`);
  if (shape.depth > MAX_DEPTH) violations.push(`depth=${shape.depth}`);
  if (shape.arrays > MAX_ARRAY_ITEMS) violations.push(`arrayItems=${shape.arrays}`);
  if (shape.keys > MAX_KEYS_PER_OBJECT) violations.push(`objectKeys=${shape.keys}`);
  return {
    name,
    status: violations.length ? 'FAIL' : 'PASS',
    bytes,
    depth: shape.depth,
    maxArrayItems: shape.arrays,
    maxObjectKeys: shape.keys,
    violations,
  };
});

const failed = gates.filter((gate) => gate.status === 'FAIL').length;
const report = {
  schema: 'opurom.evidence-bounds-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: { version: '3.50.0', goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb' },
  contract: {
    maxBytes: MAX_BYTES,
    maxDepth: MAX_DEPTH,
    maxArrayItems: MAX_ARRAY_ITEMS,
    maxObjectKeys: MAX_KEYS_PER_OBJECT,
  },
  summary: { total: gates.length, pass: gates.length - failed, fail: failed },
  gates,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
