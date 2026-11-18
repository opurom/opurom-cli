// Static quality gate tests. Flutter authority (3.50.0):
// - packages/flutter_tools/lib/src/commands/analyze.dart:25-105
// - packages/flutter_tools/lib/src/commands/analyze_base.dart:66-82,97-122
// - packages/flutter_tools/lib/src/commands/validate_project.dart:16-100
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir, discoverBinary } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import {
  analyze, analyzeMachine, analyzeSummary, analyzeSources, discoverSources, formatAnalyzeRows,
} from '../lib/analyze.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

const VALID_SOURCE = 'app Valid {\n  state count = 0\n  Text("count {count}")\n}\n';
const INVALID_SOURCE = 'app Broken {\n  state count =\n}\n';

function compiler() {
  return discoverBinary(['opuromc'], { repo: 'opurom-lang' });
}

test('discoverSources finds .opu files and skips build directories', () => {
  const base = tmpDir('analyze-discover-');
  try {
    fs.mkdirSync(path.join(base, 'src'), { recursive: true });
    fs.mkdirSync(path.join(base, 'dist'), { recursive: true });
    fs.mkdirSync(path.join(base, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(base, 'main.opu'), 'app Main\n');
    fs.writeFileSync(path.join(base, 'src', 'view.opu'), 'app View\n');
    fs.writeFileSync(path.join(base, 'dist', 'out.opu'), 'app Out\n');
    fs.writeFileSync(path.join(base, 'node_modules', 'dep.opu'), 'app Dep\n');
    fs.writeFileSync(path.join(base, 'notes.md'), '# notes\n');
    assert.deepEqual(discoverSources(base), [
      path.join(base, 'main.opu'),
      path.join(base, 'src', 'view.opu'),
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('analyze reports per-file status and one summary line', (t) => {
  if (!compiler()) {
    t.skip('opuromc unavailable: no executable in opurom-lang/target/{debug,release} or PATH');
    return;
  }
  const base = tmpDir('analyze-rows-');
  try {
    fs.writeFileSync(path.join(base, 'ok.opu'), VALID_SOURCE);
    fs.writeFileSync(path.join(base, 'bad.opu'), INVALID_SOURCE);
    const rows = analyzeSources({ files: [
      path.join(base, 'ok.opu'), path.join(base, 'bad.opu'),
    ] });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].ok, true);
    assert.equal(rows[1].ok, false);
    assert.match(rows[1].detail, /error:/);
    const text = formatAnalyzeRows(rows).join('\n');
    assert.match(text, /\[pass\] .*ok\.opu/);
    assert.match(text, /\[error\] .*bad\.opu/);
    assert.equal(analyzeSummary(rows, '0.1'), '1 issue found. analyzed 2 files (ran in 0.1s)');
    assert.equal(analyzeSummary([rows[0]], '0.1'), 'No issues found! analyzed 1 file (ran in 0.1s)');
    const machine = JSON.parse(analyzeMachine(rows, '0.1'));
    assert.equal(machine.schema, 'opurom.analyze/v1');
    assert.equal(machine.files, 2);
    assert.equal(machine.issues, 1);
    assert.deepEqual(machine.rows.map((row) => row.status), ['pass', 'error']);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('analyze CLI exits nonzero on a failing source and zero when clean', (t) => {
  if (!compiler()) {
    t.skip('opuromc unavailable: no executable in opurom-lang/target/{debug,release} or PATH');
    return;
  }
  const base = tmpDir('analyze-cli-');
  try {
    const project = path.join(base, 'demo');
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'main.opu'), VALID_SOURCE);
    const clean = run(process.execPath, [CLI, 'analyze', project]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /No issues found!/);

    fs.writeFileSync(path.join(project, 'broken.opu'), INVALID_SOURCE);
    const broken = run(process.execPath, [CLI, 'analyze', project]);
    assert.equal(broken.status, 1);
    assert.match(broken.stdout, /1 issue found/);

    const machine = run(process.execPath, [CLI, 'analyze', project, '--machine']);
    const parsed = JSON.parse(machine.stdout);
    assert.equal(parsed.schema, 'opurom.analyze/v1');
    assert.equal(parsed.issues, 1);

    const out = path.join(base, 'analysis.txt');
    const written = run(process.execPath, [CLI, 'analyze', project, '--write', out]);
    assert.equal(written.status, 1);
    assert.match(fs.readFileSync(out, 'utf8'), /\[error\] .*broken\.opu/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('analyze rejects an empty project and a missing path', () => {
  const base = tmpDir('analyze-empty-');
  try {
    const empty = path.join(base, 'empty');
    fs.mkdirSync(empty, { recursive: true });
    const missing = run(process.execPath, [CLI, 'analyze', path.join(base, 'absent')]);
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr + missing.stdout, /no such file or directory/);
    const noSources = run(process.execPath, [CLI, 'analyze', empty]);
    assert.notEqual(noSources.status, 0);
    assert.match(noSources.stderr + noSources.stdout, /no \.opu sources/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
