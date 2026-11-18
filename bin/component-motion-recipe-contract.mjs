#!/usr/bin/env node
// Machine-readable gate for Semantic Component Recipe and MotionSpec on the
// default product path. It reads authoritative lowering sources and verifies
// that the product default loads every recipe and motion event while the
// explicit compat path keeps its historical static fallback.
//
// Flutter authority: 3.50.0 / ab2912035e160d9cad6306df307576da6128ebdb.
// Motion duration/easing tokens are registered in bin/flutter-provenance-contract.mjs
// from Flutter 3.50.0 packages/flutter/lib/src/material/motion.dart:28/60/192.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER_ROOT = path.resolve(ROOT, '..', 'opurom-render');
const RENDER_REF = 'origin/render/visual-gate-contract';
const RECIPES = [
  'AppBar', 'Card', 'Button', 'IconButton', 'Input', 'Switch',
  'Slider', 'ListItem', 'Tabs', 'Dialog', 'Badge', 'Progress',
];
const EVENTS = [
  'routeEnter', 'routeExit', 'stateChange', 'listEnter',
  'press', 'dialog', 'switch', 'progress',
];

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, status: 'PASS' });
  } catch (error) {
    checks.push({ name, status: 'FAIL', error: error.message });
  }
}

function renderSource(relative) {
  const run = spawnSync('git', ['show', `${RENDER_REF}:${relative}`], {
    cwd: RENDER_ROOT,
    encoding: 'utf8',
    timeout: 30 * 1000,
  });
  if (run.status === 0) return run.stdout;
  const fetched = spawnSync('git', ['fetch', 'origin', RENDER_REF.replace('origin/', ''), '--quiet'], {
    cwd: RENDER_ROOT,
    encoding: 'utf8',
    timeout: 5 * 60 * 1000,
  });
  const retry = spawnSync('git', ['show', `${RENDER_REF}:${relative}`], {
    cwd: RENDER_ROOT,
    encoding: 'utf8',
    timeout: 30 * 1000,
  });
  assert.equal(retry.status, 0,
    `missing authoritative source ${RENDER_REF}:${relative} (fetch status ${fetched.status})`);
  return retry.stdout;
}

let quality;
let recipes;
let motion;
let painter;
let lib;
let cliQuality;
check('render sources are present', () => {
  quality = renderSource('src/quality.rs');
  recipes = renderSource('src/recipes.rs');
  motion = renderSource('src/motion.rs');
  painter = renderSource('src/target_painter.rs');
  lib = renderSource('src/lib.rs');
  cliQuality = readFileSync(path.join(ROOT, 'lib', 'quality.mjs'), 'utf8');
});

check('product is the rendered default and compat is explicit', () => {
  assert.match(quality, /Some\(Self::Compat\)\s*if\s+edge_aa\s*\|\|\s*proportional_metrics\s*=>\s*Self::Product/);
  assert.match(quality, /None\s*=>\s*Self::Product/);
  assert.match(quality, /Some\(Self::Product\)\s*=>\s*Self::Product/);
});

check('all twelve semantic recipes are default product components', () => {
  assert.ok(lib.includes('pub mod recipes;'), 'render library exports recipes');
  assert.ok(lib.includes('pub use recipes::{'), 'render library re-exports recipes');
  const block = /pub enum RecipeKind \{([\s\S]*?)\n\}/.exec(recipes);
  assert.ok(block, 'RecipeKind enum is missing');
  for (const recipe of RECIPES) {
    assert.match(block[1], new RegExp(`\\b${recipe}\\b`), `${recipe} is not a semantic recipe`);
  }
  const parseBlock = /pub fn parse\(text: &str\) -> Option<Self> \{([\s\S]*?)\n    \}/.exec(recipes);
  assert.ok(parseBlock, 'RecipeKind::parse is missing');
  for (const recipe of RECIPES) {
    assert.match(parseBlock[1], new RegExp(`"${recipe}"\\s*=>\\s*Some\\(Self::${recipe}\\)`),
      `${recipe} is not parseable`);
  }
});

check('default product lowering loads every semantic recipe', () => {
  assert.ok(painter.includes('use crate::recipes::RecipeKind;'), 'painter does not import recipes');
  const resolve = /pub fn resolve\(profile: QualityProfile, painter: TargetPainter\) -> Self \{([\s\S]*?)\n    \}/.exec(painter);
  assert.ok(resolve, 'PainterRequirements::resolve is missing');
  for (const recipe of RECIPES) {
    assert.match(resolve[1], new RegExp(`RecipeKind::${recipe}\\b`), `${recipe} is not lowered`);
  }
  assert.match(resolve[1], /recipe_kinds\[index\]\s*=\s*profile\s*==\s*QualityProfile::Product\s*&&\s*painter\.product_capable\(\)/);
  assert.match(painter, /pub fn all_recipes_required\(&self\) -> bool \{\s*self\.recipe_kinds\.iter\(\)\.all\(\|required\| \*required\)\s*\}/);
  const productTest = /fn product_dom_requirements_lower_every_recipe\(\) \{([\s\S]*?)\n    \}/.exec(painter);
  assert.ok(productTest, 'product recipe test is missing');
  assert.match(productTest[1], /assert!\(req\.all_recipes_required\(\)\);/);
});

check('MotionSpec is semantic, clock-driven and product-default', () => {
  assert.ok(lib.includes('pub mod motion;'), 'render library does not export motion');
  assert.ok(lib.includes('pub use motion::{MotionEvent, MotionSpec};'), 'render library does not re-export MotionSpec');
  assert.ok(painter.includes('use crate::motion::MotionSpec;'), 'painter does not import MotionSpec');
  const eventBlock = /pub enum MotionEvent \{([\s\S]*?)\n\}/.exec(motion);
  assert.ok(eventBlock, 'MotionEvent enum is missing');
  for (const event of EVENTS) {
    assert.match(eventBlock[1], new RegExp(`\\b${event[0].toUpperCase()}${event.slice(1)}\\b`), `${event} is not a semantic event`);
  }
  assert.match(motion, /pub const fn from_profile\(profile: QualityProfile, reduced_motion: bool\) -> Self \{([\s\S]*?)\n    \}/);
  assert.match(motion, /enabled:\s*matches!\(profile,\s*QualityProfile::Product\)\s*&&\s*!reduced_motion/);
  assert.match(motion, /resolved_duration_ms[\s\S]*?if self\.enabled \{[\s\S]*?duration_ms\(\)[\s\S]*?0/);
  assert.doesNotMatch(motion, /Instant|SystemTime|currentTimeMillis|performance\.now/);
});

check('compat keeps the static non-regression fallback', () => {
  assert.match(motion, /fn compat_motion_is_static\(\) \{([\s\S]*?)\n    \}/);
  assert.match(motion, /MotionSpec::from_profile\(QualityProfile::Compat, false\)/);
  assert.match(motion, /assert!\(!spec\.enabled\)/);
  assert.match(motion, /assert_eq!\(spec\.resolved_duration_ms\(event\), 0\)/);
  const compatTest = /fn compat_requirements_keep_the_historical_fallback\(\) \{([\s\S]*?)\n    \}/.exec(painter);
  assert.ok(compatTest, 'compat requirement test is missing');
  assert.match(compatTest[1], /assert!\(!req\.all_recipes_required\(\)\);/);
  assert.match(compatTest[1], /assert!\(!req\.motion\.enabled\);/);
  assert.match(quality, /Compat[\s\S]*?historical golden byte stream/);
});

check('CLI product default and explicit compat reach the same lowering policy', () => {
  assert.match(cliQuality, /const quality = explicit\(flags\.quality\) \? String\(flags\.quality\) : 'product'/);
  assert.match(cliQuality, /QUALITY_PROFILES = Object\.freeze\(\['product', 'compat'\]\)/);
  assert.match(cliQuality, /degraded:\s*quality === 'compat'[\s\S]*?legacyGolden/);
  assert.match(cliQuality, /OPR_QUALITY_PROFILE\s*=\s*options\.profile/);
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.component-motion-recipe-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
  },
  contract: {
    defaultProfile: 'product',
    explicitDowngrade: 'compat',
    recipeKinds: RECIPES,
    motionEvents: EVENTS,
    loweredAtCompileTime: true,
    runtimeIrInterpreter: false,
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
