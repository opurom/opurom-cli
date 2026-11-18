// Incremental output-cache tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923-1016
//   (per-node measurement records skipped work)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (outputs need content marks to make a stable decision)
// Opurom adaptation: output marks are observation-only. They never gate or
// mutate the build; they expose externally changed lower/postprocess files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/proc.mjs';
import {
  discoverOutputFiles, diffOutputMarks, OUTPUT_MARK_FILE, OUTPUT_MARK_VERSION,
  readOutputMarks, writeOutputMarks,
} from '../lib/incremental_outputs.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('output discovery skips metadata files and includes nested artifacts', () => {
  const base = tempDir('output-discover-');
  try {
    fs.mkdirSync(path.join(base, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(base, 'index.html'), 'x');
    fs.writeFileSync(path.join(base, 'assets', 'app.js'), 'y');
    fs.writeFileSync(path.join(base, OUTPUT_MARK_FILE), '{}');
    fs.writeFileSync(path.join(base, '.opurom-filecache.json'), '{}');
    fs.mkdirSync(path.join(base, '.opurom-incremental'), { recursive: true });
    fs.writeFileSync(path.join(base, '.opurom-incremental', 'latest.json'), '{}');
    assert.deepEqual(discoverOutputFiles(base), [
      path.join(base, 'assets', 'app.js'),
      path.join(base, 'index.html'),
    ]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('output marks hash content and detect external changes deterministically', () => {
  const base = tempDir('output-marks-');
  try {
    fs.writeFileSync(path.join(base, 'index.html'), 'a');
    const marks = writeOutputMarks(path.join(base, OUTPUT_MARK_FILE), discoverOutputFiles(base));
    assert.match(marks['index.html'], /^sha256:[0-9a-f]{64}$/);
    const previous = readOutputMarks(path.join(base, OUTPUT_MARK_FILE));
    assert.deepEqual(diffOutputMarks(discoverOutputFiles(base), previous, base), []);

    fs.writeFileSync(path.join(base, 'index.html'), 'b');
    assert.deepEqual(
      diffOutputMarks(discoverOutputFiles(base), previous, base),
      [path.join(base, 'index.html')],
    );

    fs.rmSync(path.join(base, 'index.html'));
    assert.deepEqual(
      diffOutputMarks(discoverOutputFiles(base), previous, base),
      [],
    );
    writeOutputMarks(path.join(base, OUTPUT_MARK_FILE), [], { previous });
    assert.deepEqual(readOutputMarks(path.join(base, OUTPUT_MARK_FILE)), {});
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('externally changed outputs dirty the next decision without skipping work', () => {
  const base = tempDir('output-decision-');
  try {
    const source = path.resolve('../opurom-examples/golden/counter.opu');
    const out = path.join(base, 'out');
    const args = [
      CLI, 'build', '--src', source, '--target', 'web-dom', '--out', out, '--incremental',
    ];
    const decisionFile = path.join(out, '.opurom-incremental', 'latest.json');
    const first = run(process.execPath, args, { timeout: 120000 });
    assert.equal(first.status, 0, first.stderr);
    const report = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    assert.deepEqual(report.dirty, [source]);
    assert.deepEqual(report.skipped, []);

    const second = run(process.execPath, args, { timeout: 120000 });
    assert.equal(second.status, 0, second.stderr);
    const clean = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    assert.deepEqual(clean.dirty, []);
    assert.deepEqual(clean.skipped, clean.steps.map((row) => row.step));
    assert.ok(clean.steps.every((row) => row.executed));

    const indexHtml = path.join(out, 'index.html');
    assert.ok(fs.existsSync(indexHtml), 'the high-spec web-dom build must emit index.html');
    const original = fs.readFileSync(indexHtml, 'utf8');
    fs.writeFileSync(indexHtml, `${original}\n<!-- externally edited -->\n`);
    const third = run(process.execPath, args, { timeout: 120000 });
    assert.equal(third.status, 0, third.stderr);
    const changed = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    assert.deepEqual(changed.dirty, [indexHtml]);
    assert.deepEqual(changed.skipped, []);
    assert.ok(changed.steps.every((row) => row.executed));
    assert.equal(changed.enforcement, 'none');

    const fourth = run(process.execPath, args, { timeout: 120000 });
    assert.equal(fourth.status, 0, fourth.stderr);
    const restored = JSON.parse(fs.readFileSync(decisionFile, 'utf8'));
    assert.deepEqual(restored.dirty, []);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('output marks leave default builds byte-identical', () => {
  const base = tempDir('output-default-');
  try {
    const source = path.resolve('../opurom-examples/golden/counter.opu');
    const plain = path.join(base, 'plain');
    const tracked = path.join(base, 'tracked');
    for (const out of [plain, tracked]) {
      const args = [CLI, 'build', '--src', source, '--target', 'web-dom', '--out', out];
      if (out === tracked) args.push('--incremental');
      const result = run(process.execPath, args, { timeout: 120000 });
      assert.equal(result.status, 0, result.stderr);
    }
    const plainFiles = fs.readdirSync(plain).filter((f) => !f.startsWith('.')).sort();
    const trackedFiles = fs.readdirSync(tracked).filter((f) => !f.startsWith('.')).sort();
    assert.deepEqual(trackedFiles, plainFiles);
    for (const file of plainFiles) {
      assert.equal(
        fs.readFileSync(path.join(tracked, file)).toString('base64'),
        fs.readFileSync(path.join(plain, file)).toString('base64'),
        `${file} must be byte-identical with and without --incremental`,
      );
    }
    assert.ok(fs.existsSync(path.join(tracked, OUTPUT_MARK_FILE)));
    assert.ok(!fs.existsSync(path.join(plain, OUTPUT_MARK_FILE)));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});


test('version and strategy transitions clear the prior output cache', () => {
  const base = tempDir('output-cache-lifecycle-');
  try {
    fs.writeFileSync(path.join(base, 'index.html'), 'a');
    const markFile = path.join(base, OUTPUT_MARK_FILE);
    const valid = (version, strategy, marks) => JSON.stringify({
      version, strategy, marks,
    }, null, 2);

    fs.writeFileSync(markFile, valid(OUTPUT_MARK_VERSION + 1, 'hash', { 'index.html': 'sha256:old' }));
    const oldVersion = readOutputMarks(markFile);
    assert.deepEqual(oldVersion, {});

    fs.writeFileSync(markFile, valid(OUTPUT_MARK_VERSION, 'timestamp', { 'index.html': 'mtime:old' }));
    const switched = readOutputMarks(markFile);
    assert.deepEqual(switched, {});

    const markFiles = writeOutputMarks(markFile, discoverOutputFiles(base));
    assert.deepEqual(Object.keys(markFiles), ['index.html']);
    assert.match(markFiles['index.html'], /^sha256:[0-9a-f]{64}$/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('missing outputs are reported dirty and leave no .tmp remainder', () => {
  const base = tempDir('output-cache-missing-');
  try {
    const markFile = path.join(base, OUTPUT_MARK_FILE);
    fs.writeFileSync(path.join(base, 'index.html'), 'a');
    const marks = writeOutputMarks(markFile, discoverOutputFiles(base));
    assert.deepEqual(marks, { 'index.html': marks['index.html'] });

    const previous = readOutputMarks(markFile);
    fs.rmSync(path.join(base, 'index.html'));
    assert.deepEqual(
      diffOutputMarks(discoverOutputFiles(base), previous, base),
      [],
    );
    writeOutputMarks(markFile, [], { previous });
    assert.deepEqual(readOutputMarks(markFile), {});

    fs.writeFileSync(path.join(base, 'index.html'), 'a');
    assert.deepEqual(
      diffOutputMarks(discoverOutputFiles(base), {}, base),
      [path.join(base, 'index.html')],
    );
    const restored = writeOutputMarks(markFile, discoverOutputFiles(base));
    assert.deepEqual(restored, { 'index.html': marks['index.html'] });
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('output cache persist replaces the file atomically and survives failure', () => {
  const base = tempDir('output-cache-atomic-');
  try {
    const markFile = path.join(base, OUTPUT_MARK_FILE);
    fs.writeFileSync(path.join(base, 'index.html'), 'a');
    const original = `${JSON.stringify({ version: -1, strategy: 'hash', marks: {} }, null, 2)}\n`;
    fs.writeFileSync(markFile, original);
    const expected = writeOutputMarks(markFile, discoverOutputFiles(base));
    fs.writeFileSync(markFile, original);

    const renameSync = fs.renameSync;
    const attempted = [];
    fs.renameSync = (from, to) => {
      attempted.push({ from, to });
      assert.equal(fs.readFileSync(to, 'utf8'), original, 'old cache must remain intact until rename');
      renameSync(from, `${from}.moved`);
      throw new Error('simulated rename failure');
    };
    let failure = null;
    try { writeOutputMarks(markFile, discoverOutputFiles(base)); }
    catch (error) { failure = error; }
    finally { fs.renameSync = renameSync; }

    assert.match(failure?.message ?? '', /simulated rename failure/);
    assert.equal(fs.readFileSync(markFile, 'utf8'), original, 'failed persist keeps the old cache');
    assert.equal(attempted.length, 1);
    assert.equal(fs.readdirSync(base).filter((name) => name.endsWith('.tmp')).length, 0);
    assert.ok(fs.existsSync(`${attempted[0].from}.moved`));

    writeOutputMarks(markFile, discoverOutputFiles(base));
    assert.deepEqual(readOutputMarks(markFile), expected);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('output cache replays produce stable bytes and observation-only decisions', () => {
  const base = tempDir('output-cache-replay-');
  try {
    const source = path.resolve('../opurom-examples/golden/counter.opu');
    const out = path.join(base, 'out');
    const args = [
      CLI, 'build', '--src', source, '--target', 'web-dom', '--out', out, '--incremental',
    ];
    const markFile = path.join(out, OUTPUT_MARK_FILE);
    const decisionFile = path.join(out, '.opurom-incremental', 'latest.json');
    const runBuild = () => {
      const result = run(process.execPath, args, { timeout: 120000 });
      assert.equal(result.status, 0, result.stderr);
    };
    runBuild();
    runBuild();
    const firstMarks = fs.readFileSync(markFile, 'utf8');
    const firstDecision = fs.readFileSync(decisionFile, 'utf8');

    for (let i = 0; i < 4; i++) runBuild();
    assert.equal(fs.readFileSync(markFile, 'utf8'), firstMarks);
    assert.equal(fs.readFileSync(decisionFile, 'utf8'), firstDecision);

    const decision = JSON.parse(firstDecision);
    assert.deepEqual(decision.dirty, []);
    assert.equal(decision.enforcement, 'none');
    assert.deepEqual(decision.skipped, decision.steps.map((row) => row.step));
    assert.ok(decision.steps.every((row) => row.executed));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
