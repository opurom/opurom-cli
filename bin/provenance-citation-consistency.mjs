#!/usr/bin/env node
// Machine-readable gate for provenance-citation consistency across Opurom's
// own gate sources and README. It extracts every Flutter file:line citation
// from the repository and verifies it is covered by the authoritative
// registry in bin/flutter-provenance-contract.mjs, preventing stale anchors
// from surviving in hand-written prose.
//
// Exit 0 only when every extracted citation resolves to a registered range.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = path.join(ROOT, 'bin', 'flutter-provenance-contract.mjs');
const GUARDED_FILES = Object.freeze([
  'bin/performance-phase-contract.mjs',
  'bin/test-scheduling-contract.mjs',
  'bin/golden-failure-contract.mjs',
  'bin/gesture-timing-contract.mjs',
  'bin/fuzz-input-corpus-contract.mjs',
  'bin/stability-resource-contract.mjs',
  'bin/report-archive-integrity-contract.mjs',
  'bin/flutter-provenance-contract.mjs',
  'test/performance_phase_contract_gate.test.mjs',
  'test/test_scheduling_contract_gate.test.mjs',
  'test/golden_failure_contract_gate.test.mjs',
  'test/gesture_timing_contract_gate.test.mjs',
  'test/fuzz_input_corpus_contract_gate.test.mjs',
  'test/stability_resource_contract_gate.test.mjs',
  'test/report_archive_integrity_contract_gate.test.mjs',
  'test/flutter_provenance_contract_gate.test.mjs',
]);
const FILES = GUARDED_FILES.map((relative) => path.join(ROOT, relative));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile() && /\.(?:mjs|md)$/.test(entry.name)) out.push(file);
  }
  return out;
}

function registeredRanges() {
  const source = readFileSync(REGISTRY, 'utf8');
  const ranges = [];
  const pattern = /file:\s*'([^']+)',\s*from:\s*(\d+),\s*to:\s*(\d+)/g;
  for (const match of source.matchAll(pattern)) {
    ranges.push({ file: match[1], from: Number(match[2]), to: Number(match[3]) });
  }
  assert.ok(ranges.length >= 28, `provenance registry has too few anchors: ${ranges.length}`);
  return ranges;
}

const ALIASES = Object.freeze({
  'binding.dart': 'packages/flutter_test/lib/src/binding.dart',
  'goldens.dart': 'packages/flutter_test/lib/src/goldens.dart',
  '_goldens_io.dart': 'packages/flutter_test/lib/src/_goldens_io.dart',
  'matchers.dart': 'packages/flutter_test/lib/src/matchers.dart',
  'constants.dart': 'packages/flutter/lib/src/gestures/constants.dart',
  'task_result.dart': 'dev/devicelab/lib/framework/task_result.dart',
  'metrics_center.dart': 'dev/devicelab/lib/framework/metrics_center.dart',
  'macrobenchmarks/util.dart': 'dev/benchmarks/macrobenchmarks/test_driver/util.dart',
  'frame_timings.h': 'engine/src/flutter/flow/frame_timings.h',
});

// Matches full paths and the short aliases used in README/prose. A single
// line or range is accepted; comma/slash chains are split by the caller.
const CITATION = /(?<file>(?:packages|dev|engine)\/[A-Za-z0-9_./-]+\.(?:dart|h)|(?<![\w/])(?:binding|goldens|_goldens_io|matchers|constants|task_result|metrics_center|frame_timings)\.dart|(?<![\w/])_goldens_io\.dart|(?<![\w/])macrobenchmarks\/util\.dart):(?<numbers>\d+(?:[-\/]\d+)*(?:,\d+(?:[-\/]\d+)*)*)/g;

function resolveFile(raw) {
  if (raw.startsWith('packages/') || raw.startsWith('dev/') || raw.startsWith('engine/')) return raw;
  return ALIASES[raw] ?? null;
}

function parseNumbers(text) {
  return text.split(/[,\/]/).flatMap((part) => {
    const [start, end] = part.split('-').map(Number);
    return [{ from: start, to: end ?? start }];
  });
}

const ranges = registeredRanges();
const findings = [];
const covered = new Set();
for (const file of FILES) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(CITATION)) {
    const resolved = resolveFile(match.groups.file);
    if (!resolved) continue;
    for (const { from, to } of parseNumbers(match.groups.numbers)) {
      const registered = ranges.some((range) => range.file === resolved && from >= range.from && to <= range.to);
      const key = `${resolved}:${from}-${to}`;
      if (registered) covered.add(key);
      else findings.push({ file: path.relative(ROOT, file), citation: `${resolved}:${from}-${to}` });
    }
  }
}

const failed = findings.length > 0;
const report = {
  schema: 'opurom.provenance-citation-consistency/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    registry: 'bin/flutter-provenance-contract.mjs',
  },
  summary: {
    total: findings.length + covered.size,
    pass: covered.size,
    fail: findings.length,
    registeredAnchors: ranges.length,
  },
  findings,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
