import { readFileSync } from 'node:fs';

// The 8 0.1.0 emitters, mirrored from the framework rules "Target emitters".
export const TARGETS = Object.freeze([
  'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
]);

// The responsive DOM build target. It is not a 0.1.0 IR emitter, so it stays
// out of TARGETS (and out of the `opurom targets` list) while remaining a
// valid single-emitter build.
export const WEB_DOM_TARGET = 'web-dom';

// Targets a single-emitter build accepts: the eight IR emitters plus the
// responsive DOM build.
export const VALID_TARGETS = Object.freeze([...TARGETS, WEB_DOM_TARGET]);

// Build modes handled by the CLI itself, not by a single emitter.
export const BUILD_TARGETS = Object.freeze([...VALID_TARGETS, 'full', 'wasm']);

export function targetsFromBuiltins(goldenFile) {
  let text;
  try {
    text = readFileSync(goldenFile, 'utf8');
  } catch {
    return [...TARGETS];
  }
  const section = text.split('## Target emitters')[1]?.split('\n## ')[0] ?? text;
  const names = [...section.matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((m) => m[1]);
  return names.length ? [...new Set(names)] : [...TARGETS];
}

export function validateTarget(name, targets = VALID_TARGETS) {
  if (!targets.includes(name)) throw new Error(`unknown target: ${name} (expected one of ${targets.join(', ')})`);
  return name;
}

export function validateBuildTarget(name, targets = BUILD_TARGETS) {
  if (!targets.includes(name)) {
    throw new Error(`unknown target: ${name} (expected one of ${targets.join(', ')})`);
  }
  return name;
}
