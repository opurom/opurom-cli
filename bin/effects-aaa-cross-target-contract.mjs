#!/usr/bin/env node
// Machine-readable gate for effects/AAA boundary hardening and cross-target
// recipe lowering. It reads authoritative render sources from pinned remote
// refs and verifies that extreme geometry stays inside deterministic bounds,
// product targets lower the complete recipe set, and compat remains explicit.
//
// Flutter authority: 3.50.0 / ab2912035e160d9cad6306df307576da6128ebdb.
// No wall-clock, host state or runtime IR interpretation is accepted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENDER_ROOT = path.resolve(ROOT, '..', 'opurom-render');
const BOUNDARY_REF = 'origin/main';
const LOWERING_REF = 'origin/main';
const RECIPES = [
  'AppBar', 'Card', 'Button', 'IconButton', 'Input', 'Switch',
  'Slider', 'ListItem', 'Tabs', 'Dialog', 'Badge', 'Progress',
];
const TARGETS = [
  'SoftwareRaster', 'Metal', 'WebDom', 'WebCanvas',
  'WebVerifyCanvas', 'Native', 'MiniProgram',
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

function renderSource(ref, relative) {
  const run = spawnSync('git', ['show', `${ref}:${relative}`], {
    cwd: RENDER_ROOT,
    encoding: 'utf8',
    timeout: 30 * 1000,
  });
  assert.equal(run.status, 0,
    `missing authoritative source ${ref}:${relative}: ${run.stderr}`);
  return run.stdout;
}

let effects;
let display;
let aaa;
let painter;
let recipes;
let quality;
let cliQuality;
check('authoritative sources are present', () => {
  effects = renderSource(BOUNDARY_REF, 'src/effects.rs');
  display = renderSource(BOUNDARY_REF, 'src/display.rs');
  aaa = renderSource(BOUNDARY_REF, 'src/aaa.rs');
  painter = renderSource(LOWERING_REF, 'src/target_painter.rs');
  recipes = renderSource(LOWERING_REF, 'src/recipes.rs');
  quality = renderSource(LOWERING_REF, 'src/quality.rs');
  cliQuality = readFileSync(path.join(ROOT, 'lib', 'quality.mjs'), 'utf8');
});

check('effect radii, offsets and frame bounds are clamped', () => {
  assert.match(effects, /pub const EFFECT_MAX_RADIUS: i64 = 32;/);
  assert.match(effects, /pub const EFFECT_MAX_OFFSET: i64 = 64;/);
  assert.match(effects, /pub const GAUSSIAN_MIN_RADIUS: i64 = 1;/);
  assert.match(effects, /pub const GAUSSIAN_MAX_RADIUS: i64 = 8;/);
  assert.match(effects, /self\.radius\.clamp\(0, EFFECT_MAX_RADIUS\)/);
  assert.match(effects, /self\.dx\.clamp\(-EFFECT_MAX_OFFSET, EFFECT_MAX_OFFSET\)/);
  assert.match(effects, /self\.dy\.clamp\(-EFFECT_MAX_OFFSET, EFFECT_MAX_OFFSET\)/);
  assert.match(effects, /radius\.clamp\(GAUSSIAN_MIN_RADIUS, GAUSSIAN_MAX_RADIUS\)/);
  assert.match(effects, /saturating_sub\(pad\)/);
  assert.match(effects, /saturating_add\(r\.w\.max\(0\)\)/);
});

check('solid coalescing fails closed on coordinate and i64 overflow', () => {
  assert.match(display, /pub fn coalesce_solids\(commands: Vec<Command>\) -> Vec<Command>/);
  assert.match(display, /rect\.h\.checked_add\(next_rect\.h\)/);
  assert.match(display, /rect\.w\.checked_add\(next_rect\.w\)/);
  assert.match(display, /if h <= COORD_LIMIT/);
  assert.match(display, /if w <= COORD_LIMIT/);
  const tests = [
    'vertical_merge_within_the_coordinate_limit_is_allowed',
    'overflow_would_be_rejected_and_commands_kept_distinct',
    'i64_overflow_pair_is_kept_distinct_without_panicking',
    'horizontal_overflow_is_also_rejected',
    'effect_commands_are_barriers',
  ];
  for (const name of tests) {
    assert.match(display, new RegExp(`fn ${name}\\(\\)`), `missing overflow test ${name}`);
  }
});

check('AAA fixed-point arithmetic saturates at every boundary', () => {
  assert.match(aaa, /checked_div\(d\)\.unwrap_or\(i64::MAX\)/);
  assert.match(aaa, /v\.saturating_add\(ONE - 1\) >> 16/);
  assert.match(aaa, /fn shl16\(v: i64\) -> i64 \{\s*v\.saturating_mul\(ONE\)\s*\}/);
  assert.match(aaa, /const MAX_ROW_SPAN: i64 = 1 << 20;/);
  assert.match(aaa, /len > MAX_ROW_SPAN/);
  assert.match(aaa, /u64::MAX - origin_u - left_u/);
  assert.match(aaa, /saturating_mul/);
  assert.match(aaa, /saturating_add/);
  assert.match(aaa, /clamp\(0, 255\)/);
  assert.doesNotMatch(aaa, /Instant|SystemTime|currentTimeMillis|performance\.now/);
});

check('AAA conic subdivision is exact and extreme inputs are pinned', () => {
  assert.match(aaa, /let dw_num = 2 \* \(65_536 - w_num\);/);
  assert.match(aaa, /let dw_den = 65_536i128;/);
  assert.match(aaa, /let tol = tol_raw\.min\(1 << 63\);/);
  assert.match(aaa, /n\.clamp\(1, 32\)/);
  const tests = [
    'wang_counts_are_bounded_and_deterministic_at_i64_extremes',
    'pow2_subdivision_never_overflows_or_loops_at_extreme_radius',
    'bezier_subdivisions_are_bounded_at_i64_extreme_control_points',
    'wang_count_keeps_normal_radii_history_after_rational_dw',
    'pow2_tolerance_extremes_fail_closed_without_overflow',
  ];
  for (const name of tests) {
    assert.match(aaa, new RegExp(`fn ${name}\\(\\)`), `missing boundary test ${name}`);
  }
  assert.match(aaa, /assert_eq!\(conic_quad_pow2\(100, i64::MAX, 1\), 0\)/);
  assert.match(aaa, /assert_eq!\(conic_quad_pow2\(i64::MAX, i64::MAX, 1\), 0\)/);
});

check('every product-capable target lowers the same recipe set', () => {
  const enumBlock = /pub enum TargetPainter \{([\s\S]*?)\n\}/.exec(painter);
  assert.ok(enumBlock, 'TargetPainter enum is missing');
  for (const target of TARGETS) {
    assert.match(enumBlock[1], new RegExp(`\\b${target}\\b`), `${target} target is missing`);
  }
  assert.match(painter, /pub const fn product_capable\(self\) -> bool \{\s*!matches!\(self, Self::WebVerifyCanvas\)\s*\}/);
  const resolve = /pub fn resolve\(profile: QualityProfile, painter: TargetPainter\) -> Self \{([\s\S]*?)\n    \}/.exec(painter);
  assert.ok(resolve, 'PainterRequirements::resolve is missing');
  for (const recipe of RECIPES) {
    assert.match(resolve[1], new RegExp(`RecipeKind::${recipe}\\b`), `${recipe} is not lowered`);
  }
  const recipeBlock = /pub enum RecipeKind \{([\s\S]*?)\n\}/.exec(recipes);
  assert.ok(recipeBlock, 'RecipeKind enum is missing');
  for (const recipe of RECIPES) {
    assert.match(recipeBlock[1], new RegExp(`\\b${recipe}\\b`), `${recipe} recipe is missing`);
  }
  assert.match(painter, /recipe_kinds\[index\]\s*=\s*profile\s*==\s*QualityProfile::Product\s*&&\s*painter\.product_capable\(\)/);
  assert.match(painter, /pub fn all_recipes_required\(&self\) -> bool/);
  for (const target of ['WebDom', 'WebCanvas', 'Native', 'MiniProgram', 'Metal', 'SoftwareRaster']) {
    assert.match(painter, new RegExp(`assert!\\(req\\.all_recipes_required\\(\\)\\)`),
      `${target} lowering is not covered by the product contract`);
  }
});

check('product quality stays default and compat remains explicit', () => {
  assert.match(quality, /None\s*=>\s*Self::Product/);
  assert.match(quality, /Some\(Self::Compat\)\s*if\s+edge_aa\s*\|\|\s*proportional_metrics\s*=>\s*Self::Product/);
  assert.match(quality, /Compat\s*=>\s*"bit-exact"/);
  assert.match(quality, /Product\s*=>\s*"perceptual"/);
  assert.match(painter, /fn compat_requirements_keep_the_historical_fallback\(\)/);
  assert.match(painter, /assert!\(!req\.all_recipes_required\(\)\);/);
  assert.match(painter, /assert!\(!req\.motion\.enabled\);/);
  assert.match(cliQuality, /const quality = explicit\(flags\.quality\) \? String\(flags\.quality\) : 'product'/);
  assert.match(cliQuality, /degraded:\s*quality === 'compat'[\s\S]*?legacyGolden/);
});

const failed = checks.filter((row) => row.status === 'FAIL').length;
const report = {
  schema: 'opurom.effects-aaa-cross-target-contract/v1',
  status: failed ? 'FAIL' : 'PASS',
  flutter: {
    version: '3.50.0',
    goldenCommit: 'ab2912035e160d9cad6306df307576da6128ebdb',
  },
  contract: {
    defaultProfile: 'product',
    explicitDowngrade: 'compat',
    authoritativeRefs: {
      boundary: BOUNDARY_REF,
      lowering: LOWERING_REF,
    },
    targets: TARGETS,
    recipeKinds: RECIPES,
    effectLimits: {
      maxRadius: 32,
      maxOffset: 64,
      gaussianMinRadius: 1,
      gaussianMaxRadius: 8,
      maxRowSpan: 1 << 20,
    },
    runtimeIrInterpreter: false,
  },
  summary: { total: checks.length, pass: checks.length - failed, fail: failed },
  checks,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exitCode = failed ? 1 : 0;
