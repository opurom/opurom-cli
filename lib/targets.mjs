// The 8 IR emitters, authoritative for this framework generation.
export const TARGETS = Object.freeze([
  'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
]);

// The responsive DOM build target. It is not an IR emitter, so it stays
// out of TARGETS (and out of the `opurom targets` list) while remaining a
// valid single-emitter build.
export const WEB_DOM_TARGET = 'web-dom';

// Targets a single-emitter build accepts: the eight IR emitters plus the
// responsive DOM build.
export const VALID_TARGETS = Object.freeze([...TARGETS, WEB_DOM_TARGET]);

// Build modes handled by the CLI itself, not by a single emitter.
export const BUILD_TARGETS = Object.freeze([...VALID_TARGETS, 'full', 'wasm']);

// The authoritative emitter list is the TARGETS constant above.
export function targetsFromBuiltins() {
  return [...TARGETS];
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
