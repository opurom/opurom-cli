// The IR emitters exposed by the single-emitter build path. native, web, the
// six mini-program targets, wasm and HarmonyOS. The responsive DOM build target
// (web-dom) is a build-only variant kept separate so the emitter list stays the
// set the compiler reports for IR lowering.
export const TARGETS = Object.freeze([
  'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
  'wasm', 'harmony',
]);

// The responsive DOM build target: a single-emitter build variant that is not an
// IR emitter (the compiler dispatches it explicitly).
export const WEB_DOM_TARGET = 'web-dom';

// Targets a single-emitter build accepts: every emitter plus web-dom.
export const VALID_TARGETS = Object.freeze([...TARGETS, WEB_DOM_TARGET]);

// Build modes handled by the CLI itself, not by a single emitter.
export const BUILD_TARGETS = Object.freeze([...VALID_TARGETS, 'full']);

// The list `opurom targets` prints: every single-emitter build target, kept in
// sync with `opuromc targets` (which also reports the web-dom variant).
export function targetsFromBuiltins() {
  return [...VALID_TARGETS];
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
