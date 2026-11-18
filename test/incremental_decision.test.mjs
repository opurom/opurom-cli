// Observable incremental build decision tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923-1016
//   (PerformanceMeasurement carries skipped=true for skipped targets)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (dirty files invalidate dependent targets)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import {
  decideIncremental, formatIncrementalDecision, incrementalDecisionJson, INCREMENTAL_DECISION_SCHEMA,
} from '../lib/incremental_decision.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('dirty inputs run all steps; clean inputs propose skipping every step', () => {
  const steps = ['compile', 'lower'];
  const dirty = decideIncremental({ dirty: ['src/main.opu'], steps });
  assert.equal(dirty.schema, INCREMENTAL_DECISION_SCHEMA);
  assert.equal(dirty.status, 'OBSERVED');
  assert.equal(dirty.enforcement, 'none');
  assert.deepEqual(dirty.dirty, ['src/main.opu']);
  assert.deepEqual(dirty.skipped, []);
  assert.deepEqual(dirty.steps.map((row) => row.action), ['run', 'run']);
  assert.deepEqual(dirty.steps.map((row) => row.executed), [true, true]);

  const clean = decideIncremental({ dirty: [], steps });
  assert.deepEqual(clean.steps.map((row) => row.action), ['would-skip', 'would-skip']);
  assert.deepEqual(clean.skipped, ['compile', 'lower']);
  assert.equal(clean.summary.skipped, 2);
  assert.match(formatIncrementalDecision(clean), /skipped \(proposed\): compile, lower/);
  assert.match(formatIncrementalDecision(clean), /enforcement: none/);
});

test('decision input is normalized and validated', () => {
  const result = decideIncremental({ dirty: ['b', 'a', 'a'], steps: ['compile'] });
  assert.deepEqual(result.dirty, ['a', 'b']);
  assert.throws(() => decideIncremental({ dirty: 'x', steps: [] }), /must be arrays/);
});

test('real incremental builds emit a stable decision report without skipping work', () => {
  const base = tmpDir('incremental-decision-');
  try {
    const out = path.join(base, 'out');
    const src = path.resolve('../opurom-examples/golden/counter.opu');
    const args = [CLI, 'build', '--src', src, '--target', 'web-dom', '--out', out, '--incremental'];
    const first = run(process.execPath, args, { timeout: 120000 });
    assert.equal(first.status, 0, first.stderr);
    const reportFile = path.join(out, '.opurom-incremental', 'latest.json');
    const firstReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(firstReport.schema, INCREMENTAL_DECISION_SCHEMA);
    assert.equal(firstReport.dirty.length, 1);
    assert.deepEqual(firstReport.executedSteps, firstReport.steps.map((row) => row.step));

    const second = run(process.execPath, args, { timeout: 120000 });
    assert.equal(second.status, 0, second.stderr);
    const secondReport = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
    assert.equal(secondReport.dirty.length, 0);
    assert.equal(secondReport.steps.find((row) => row.step === 'compile').action, 'would-skip');
    assert.equal(secondReport.executedSteps.length, secondReport.steps.length);
    assert.ok(secondReport.executedSteps.every((step, index) => step === secondReport.steps[index].step));
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('fixed source-change sequence yields byte-identical report fields', () => {
  const base = tmpDir('incremental-sequence-');
  try {
    const source = path.join(base, 'main.opu');
    const outA = path.join(base, 'out-a');
    const outB = path.join(base, 'out-b');
    const program = (label) => `app Demo {
  Column(gap: 8) {
    Text("${label}")
  }
}
`;
    // Same fixed sequence applied to two isolated output directories.
    const sequence = [program('a'), program('b'), program('b'), program('c')];
    const runSequence = (out) => {
      fs.rmSync(out, { recursive: true, force: true });
      const args = [
        CLI, 'build', '--src', source, '--target', 'web-dom', '--out', out, '--incremental',
      ];
      for (const text of sequence) {
        fs.writeFileSync(source, text);
        const result = run(process.execPath, args, { timeout: 120000 });
        assert.equal(result.status, 0, result.stderr);
      }
      return fs.readFileSync(path.join(out, '.opurom-incremental', 'latest.json'), 'utf8');
    };
    const a = runSequence(outA);
    const b = runSequence(outB);
    const stableFields = ['dirty', 'skipped', 'steps', 'summary', 'executedSteps'];
    const stable = (text) => {
      const report = JSON.parse(text);
      return JSON.stringify(stableFields.map((field) => report[field]));
    };
    assert.equal(stable(a), stable(b), 'same fixed sequence must produce byte-identical decision fields');
    assert.equal(runSequence(outA), a, 'same output path and sequence must produce byte-identical reports');
    const report = JSON.parse(a);
    assert.deepEqual(Object.keys(report), [
      'schema', 'status', 'enforcement', 'dirty', 'skipped', 'steps', 'summary',
      'src', 'target', 'out', 'executedSteps',
    ]);
    assert.ok(!/at\b|time|timestamp|mtime|duration|elapsed/i.test(a),
      'report must not contain wall-clock or duration fields');
    assert.deepEqual(report.dirty, [source]);
    assert.deepEqual(report.skipped, []);
    assert.ok(report.executedSteps.every((step, index) => step === report.steps[index].step));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('unchanged source reports all steps skipped in deterministic order', () => {
  const base = tmpDir('incremental-clean-');
  try {
    const source = path.join(base, 'main.opu');
    fs.writeFileSync(source, 'app Demo { Column { Text("unchanged") } }\n');
    const out = path.join(base, 'out');
    const args = [CLI, 'build', '--src', source, '--target', 'web-dom', '--out', out, '--incremental'];
    for (let i = 0; i < 2; i++) {
      const result = run(process.execPath, args, { timeout: 120000 });
      assert.equal(result.status, 0, result.stderr);
    }
    const report = JSON.parse(fs.readFileSync(path.join(out, '.opurom-incremental', 'latest.json'), 'utf8'));
    assert.deepEqual(report.dirty, []);
    assert.deepEqual(report.skipped, report.steps.map((row) => row.step));
    assert.equal(report.summary.skipped, report.steps.length);
    assert.equal(report.steps.every((row) => row.executed), true);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('non-deterministic fields are rejected from the report serializer', () => {
  const decision = decideIncremental({ dirty: [], steps: ['compile'] });
  assert.throws(
    () => incrementalDecisionJson(decision, { generatedAt: new Date().toISOString() }),
    /non-deterministic incremental report field: generatedAt/,
  );
});

test('multi-input dirty lists stay deterministic across import changes', () => {
  const base = tmpDir('incremental-multi-');
  try {
    const app = path.join(base, 'app');
    fs.mkdirSync(path.join(app, 'models'), { recursive: true });
    fs.mkdirSync(path.join(app, 'theme'), { recursive: true });
    const program = (label) => [
      'import "models/a.opu"',
      'import "models/b.opu"',
      '',
      'app A {',
      `  Column { Text("${label}") }`,
      '  theme {',
      '    tokens {',
      '      import "theme/tokens.json"',
      '    }',
      '  }',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(app, 'main.opu'), program('a'));
    fs.writeFileSync(path.join(app, 'models', 'a.opu'), 'state a = 1\n');
    fs.writeFileSync(path.join(app, 'models', 'b.opu'), 'state b = 2\n');
    fs.writeFileSync(path.join(app, 'theme', 'tokens.json'), JSON.stringify({ 'md-accent': '#111111' }));
    const out = path.join(base, 'out');
    const args = [
      CLI, 'build', '--project', app, '--target', 'web-dom', '--out', out, '--incremental',
    ];
    const decisionFile = path.join(out, '.opurom-incremental', 'latest.json');
    const build = () => {
      const result = run(process.execPath, args, { timeout: 120000 });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    };

    let report = build();
    assert.deepEqual(report.dirty, [
      path.join(app, 'main.opu'),
      path.join(app, 'models', 'a.opu'),
      path.join(app, 'models', 'b.opu'),
      path.join(app, 'theme', 'tokens.json'),
    ]);
    assert.deepEqual(report.skipped, []);
    report = build();
    assert.deepEqual(report.dirty, []);
    assert.deepEqual(report.skipped, report.steps.map((row) => row.step));
    assert.ok(report.steps.every((row) => row.executed));

    fs.writeFileSync(path.join(app, 'models', 'b.opu'), 'state b = 3\n');
    report = build();
    assert.deepEqual(report.dirty, [path.join(app, 'models', 'b.opu')]);
    assert.deepEqual(report.skipped, []);

    fs.writeFileSync(path.join(app, 'theme', 'tokens.json'), JSON.stringify({ 'md-accent': '#222222' }));
    report = build();
    assert.deepEqual(report.dirty, [path.join(app, 'theme', 'tokens.json')]);
    assert.deepEqual(report.skipped, []);

    fs.writeFileSync(path.join(app, 'models', 'b.opu'), 'state b = 3\n');
    fs.writeFileSync(path.join(app, 'theme', 'tokens.json'), JSON.stringify({ 'md-accent': '#222222' }));
    report = build();
    assert.deepEqual(report.dirty, []);
    assert.deepEqual(report.skipped, report.steps.map((row) => row.step));
    assert.ok(report.steps.every((row) => row.executed));
    assert.ok(fs.existsSync(path.join(out, 'index.html')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
