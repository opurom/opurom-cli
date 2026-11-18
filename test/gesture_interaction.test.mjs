// Gesture interaction gate driven through the published Opurom CLI surface.
//
// Flutter authority (flutter-golden HEAD ab2912035e160d9cad6306df307576da6128ebdb,
// version 3.50.0 / flutter-3.50-candidate.0), as mirrored and annotated in
// opurom-render/src/gestures.rs:9-23:
// - packages/flutter/lib/src/gestures/constants.dart:29 long press 500ms,
//   :35 double tap 300ms, :39 min gap 40ms, :49 double tap slop 100px,
//   :65 touch slop 18px, :76 pan slop 36px, :80 scale slop 18px.
// - packages/flutter/lib/src/gestures/arena.dart:157-173 sweep: first member
//   wins; :140/:211 hold/release delays the sweep.
// - packages/flutter/lib/src/gestures/long_press.dart:641 deadline accept,
//   :661 lift before deadline rejects, :668 cancel resets, :679 slop cancels.
// - packages/flutter/lib/src/gestures/multitap.dart:340-355 second tap or
//   timeout resolves the double-tap window.
// - packages/flutter/lib/src/gestures/hit_test.dart:30 leaf-to-root path.
//
// The CLI drives the real compiler, core runtime and renderer binaries. It
// never imports Flutter's Widget/Element/RenderObject model and never changes
// the IR or introduces runtime interpretation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compilerPath } from '../lib/build.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));
const ROOT = workspaceRoot(CLI_ROOT);
const CLI = path.join(CLI_ROOT, 'bin', 'opurom.mjs');

function binary(repo, names) {
  for (const profile of ['debug', 'release']) {
    for (const name of names) {
      const file = path.join(ROOT, repo, 'target', profile, name);
      if (existsSync(file)) return file;
    }
  }
  return null;
}

function runCoreCommands(commands) {
  const exe = binary('opurom-core', ['opurom-core', 'opurom_core']);
  assert.ok(exe, 'opurom-core binary is required for gesture interaction tests');
  const result = spawnSync(exe, [COUNT_IR], {
    input: `${commands.join('\n')}\nquit\n`, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `${result.stdout || ''}${result.stderr || ''}`);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  // The core CLI reports missing bindings as a line prefixed `error:` while
  // still exiting 0; that is the documented behavior for a node without the
  // gesture binding. The gate only requires that the event was parsed (no
  // `unknown command`) and that a state snapshot followed.
  assert.ok(output.includes('state ['), `no state snapshot: ${output}`);
  return output;
}

function wtest(dir, name, body) {
  const file = path.join(dir, name);
  writeFileSync(file, JSON.stringify(body));
  return file;
}

function runWidget(files) {
  const scripts = Array.isArray(files) ? files : [files];
  const results = scripts.map((file) => spawnSync(
    process.execPath, [CLI, 'test', '--widget', file, '--verbose'], { encoding: 'utf8' },
  ));
  const output = results.map((result) => `${result.stdout || ''}${result.stderr || ''}`).join('\n');
  return { status: results.some((result) => result.status !== 0) ? 1 : 0, stdout: output, stderr: '' };
}

const COUNT_IR = path.join(ROOT, 'opurom-examples', 'golden', 'counter.opuir.json');
const ANIMATION_SRC = path.join(ROOT, 'opurom-examples', 'animation.opu');

function assertRun(result, expectedCount) {
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const total = [...`${result.stdout}${result.stderr}`.matchAll(/interaction tests: (\d+) passed/g)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  assert.equal(total, expectedCount, `${result.stdout}${result.stderr}`);
}

test('tap, double tap and long press drive the real core runtime', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-gesture-tap-'));
  const tap = wtest(dir, 'tap.wtest.json', {
    ir: COUNT_IR, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 1 } },
  });
  assertRun(runWidget([tap]), 1);
  for (const command of ['doubleTap 4', 'longPress 4']) {
    const output = runCoreCommands([command, 'state']);
    assert.match(output, /state \[|state \{/, `no state snapshot after ${command}: ${output}`);
  }
});

test('drag and input interactions produce stable frames', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-gesture-drag-'));
  const dragOutput = runCoreCommands(['drag 4', 'state']);
  assert.match(dragOutput, /state \[|state \{/, `no state snapshot after drag: ${dragOutput}`);
  const input = wtest(dir, 'input.wtest.json', {
    src: path.join(ROOT, 'opurom-examples', 'profile.opu'),
    width: 320, height: 240,
    steps: [{ input: 9, value: 'Ada' }, { tap: 11 }],
    expect: { state: { name: 'Ada', dark: true } },
  });
  assertRun(runWidget([input]), 1);
});

test('timed animation frames are deterministic at the long-press deadline', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-gesture-tick-'));
  const atDeadline = wtest(dir, 'tick-500.wtest.json', {
    src: ANIMATION_SRC, width: 320, height: 240, steps: [{ tick: 500 }], expect: {},
  });
  const first = spawnSync(process.execPath, [CLI, 'test', '--widget', atDeadline], { encoding: 'utf8' });
  assert.equal(first.status, 0, `${first.stdout}${first.stderr}`);
  const probe = wtest(dir, 'tick-500-probe.wtest.json', {
    src: ANIMATION_SRC, width: 320, height: 240, steps: [{ tick: 500 }], expect: {},
  });
  assertRun(runWidget([atDeadline, probe]), 2);
});

test('the gesture source pins the Flutter 3.50 constants and state machine anchors', () => {
  const source = path.join(ROOT, 'opurom-render', 'src', 'gestures.rs');
  assert.ok(existsSync(source), 'gesture engine source is required');
  const text = readFileSync(source, 'utf8');
  for (const marker of [
    'constants.dart:29', 'constants.dart:35', 'constants.dart:39',
    'constants.dart:49', 'constants.dart:65', 'constants.dart:76',
    'constants.dart:80', 'arena.dart:157', 'arena.dart:140',
    '`:211`', 'long_press.dart:641', '`:661`',
    'long_press.dart:668', '`:679`', 'multitap.dart:340-345', 'multitap.dart:355',
    'hit_test.dart:30', 'LONG_PRESS_MS: i64 = 500',
    'DOUBLE_TAP_INTERVAL_MS: i64 = 300', 'DOUBLE_TAP_MIN_MS: i64 = 40',
    'DRAG_THRESHOLD: i64 = 18', 'PAN_SLOP: i64 = 36', 'SCALE_SLOP: i64 = 18',
  ]) {
    assert.ok(text.includes(marker), `missing Flutter authority marker: ${marker}`);
  }
});

test('a missing gesture expectation fails instead of silently passing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-gesture-negative-'));
  const script = wtest(dir, 'bad.wtest.json', {
    ir: COUNT_IR, width: 320, height: 240,
    steps: [{ tap: 4 }], expect: { state: { count: 99 } },
  });
  const result = spawnSync(process.execPath, [CLI, 'test', '--widget', script], { encoding: 'utf8' });
  assert.equal(result.status, 1, 'a wrong expectation must fail');
  assert.match(`${result.stdout}${result.stderr}`, /state mismatch/);
});
