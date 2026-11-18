#!/usr/bin/env node
// Machine-readable gate for the pinned Flutter gesture timing contract.
//
// Quality-gate layer only: it reads the published constants and the gesture
// authority source; it does not change the gesture engine.
// Flutter authority (3.50.0, flutter-golden
// ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter/lib/src/gestures/constants.dart:29/35/39/49/65/76/80/90/95
// - engine arena/long-press/multi-tap state anchors are pinned by
//   opurom-render/src/gestures.rs markers.
//
// Exit 0 only when all checks pass; every run prints one JSON document.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GESTURE_CONSTANTS } from '../lib/test_authority.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const EXPECTED = Object.freeze({
  longPressTimeoutMs: 500,
  doubleTapTimeoutMs: 300,
  doubleTapMinTimeMs: 40,
  touchSlopPx: 18,
  panSlopPx: 36,
  scaleSlopPx: 18,
});

const AUTHORITY_MARKERS = Object.freeze([
  'constants.dart:29', 'constants.dart:35', 'constants.dart:39',
  'constants.dart:49', 'constants.dart:65', 'constants.dart:76',
  'constants.dart:80', 'arena.dart:157', 'arena.dart:140',
  '`:211`', 'long_press.dart:641', '`:661`',
  'long_press.dart:668', '`:679`', 'multitap.dart:340-345', 'multitap.dart:355',
]);

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

check('published gesture thresholds match Flutter 3.50 constants', () => {
  for (const [key, value] of Object.entries(EXPECTED)) {
    assert.equal(GESTURE_CONSTANTS[key], value, `${key} drifted`);
  }
});

check('long-press, double-tap and touch-slop boundaries are distinct and ordered', () => {
  assert.ok(GESTURE_CONSTANTS.doubleTapMinTimeMs < GESTURE_CONSTANTS.doubleTapTimeoutMs);
  assert.ok(GESTURE_CONSTANTS.doubleTapTimeoutMs < GESTURE_CONSTANTS.longPressTimeoutMs);
  assert.ok(GESTURE_CONSTANTS.touchSlopPx <= GESTURE_CONSTANTS.panSlopPx);
  assert.ok(GESTURE_CONSTANTS.touchSlopPx <= GESTURE_CONSTANTS.scaleSlopPx);
});

check('gesture engine retains the pinned Flutter source markers', () => {
  const source = path.join(ROOT, '..', 'opurom-render', 'src', 'gestures.rs');
  assert.ok(existsSync(source), `gesture authority source is missing: ${source}`);
  const text = readFileSync(source, 'utf8');
  for (const marker of AUTHORITY_MARKERS) {
    assert.ok(text.includes(marker), `missing Flutter authority marker: ${marker}`);
  }
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.gesture-timing-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    channel: 'flutter-3.50-candidate.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
    authority: 'packages/flutter/lib/src/gestures/constants.dart:29/35/39/49/65/76/80/90/95',
  },
  contract: { thresholds: EXPECTED, authorityMarkers: AUTHORITY_MARKERS },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
