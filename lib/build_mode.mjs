// Build-mode plan for the Opurom CLI. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/compile.dart:210-235 (buildModeOptions:
//   debug -> dart.vm.product=false, dart.vm.profile=false, --enable-asserts;
//   profile -> dart.vm.profile=true, dart.vm.product=false;
//   release -> dart.vm.profile=false, dart.vm.product=true)
// - packages/flutter_tools/lib/src/web/compiler_config.dart:112-135
//   (optimization level 1 for debug, 4 for profile/release; --minify default
//   only in release)
// - packages/flutter_tools/packages/flutter_tools_core/lib/src/build.dart:22-58
//   (BuildMode debug/profile/release, isRelease, isPrecompiled)
// Opurom adaptation: the mode drives the CLI-owned post-processing steps and
// the compile-time defines; the IR stays the single source of truth.

import fs from 'node:fs';
import path from 'node:path';

export const BUILD_MODES = Object.freeze(['debug', 'profile', 'release']);

export const MODE_DEFINES = Object.freeze({
  debug: Object.freeze(['dart.vm.product=false', 'dart.vm.profile=false']),
  profile: Object.freeze(['dart.vm.product=false', 'dart.vm.profile=true']),
  release: Object.freeze(['dart.vm.product=true', 'dart.vm.profile=false']),
});

// Flutter compile.dart:210-235 keeps asserts in debug only; profile and
// release drop the toString package URIs.
export const MODE_ASSERTS = Object.freeze({
  debug: true,
  profile: false,
  release: false,
});

// web/compiler_config.dart:119-134: optimization level 1 for debug, 4 for
// profile and release.
export const MODE_OPTIMIZATION_LEVEL = Object.freeze({
  debug: 1,
  profile: 4,
  release: 4,
});

export function parseMode(value) {
  if (value === undefined || value === null || value === '' || value === true) return 'debug';
  const mode = String(value);
  if (!BUILD_MODES.includes(mode)) {
    throw new Error(`invalid --mode: ${mode} (expected ${BUILD_MODES.join(', ')})`);
  }
  return mode;
}

// Explicit flags win over the mode default; an absent flag takes the mode
// default. Flutter applies the same "tool default unless overridden" rule
// for its per-mode compiler options.
export function modePlan(mode, flags = {}) {
  const buildMode = parseMode(mode);
  const given = (name) => flags[name] !== undefined && flags[name] !== false;
  const optimize = given('optimize') ? true : buildMode !== 'debug';
  const minify = given('minify') ? true : (given('noMinify') ? false : buildMode === 'release');
  const treeShake = given('treeShake') ? true : (given('noTreeShake') ? false : buildMode === 'release');
  const sourcemap = given('sourcemap');
  return {
    mode: buildMode,
    isDebug: buildMode === 'debug',
    isProfile: buildMode === 'profile',
    isRelease: buildMode === 'release',
    asserts: MODE_ASSERTS[buildMode],
    optimizationLevel: MODE_OPTIMIZATION_LEVEL[buildMode],
    defines: [...MODE_DEFINES[buildMode]],
    optimize,
    minify,
    treeShake,
    sourcemap,
  };
}

export function modeDefines(plan, extra = []) {
  const entries = [...(plan?.defines ?? []), ...extra];
  return [...new Set(entries)].sort();
}

// The mode record travels with the artifact so a build can be checked later
// without re-running it. Flutter keeps the same information in the build
// system environment (build_system/targets/common.dart:59-72).
export const MODE_RECORD = '.opurom-build-mode.json';

export function writeModeRecord(out, plan, { extra = {} } = {}) {
  const target = path.join(path.resolve(out), MODE_RECORD);
  const record = {
    schema: 'opurom.build-mode/v1',
    mode: plan.mode,
    asserts: plan.asserts,
    optimizationLevel: plan.optimizationLevel,
    defines: plan.defines,
    optimize: plan.optimize,
    minify: plan.minify,
    treeShake: plan.treeShake,
    sourcemap: plan.sourcemap,
    ...extra,
  };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(record, null, 2)}\n`);
  return target;
}
