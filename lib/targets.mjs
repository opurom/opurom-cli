import { readFileSync } from 'node:fs';

// The 8 v0.1 emitters, mirrored from opurom-spec/IR_SCHEMA.md "Target emitters".
export const TARGETS = Object.freeze([
  'native', 'web', 'wechat', 'alipay', 'qq', 'douyin', 'baidu', 'kuaishou',
]);

// R2 build modes handled by the CLI itself, not by a single emitter.
export const BUILD_TARGETS = Object.freeze([...TARGETS, 'full', 'wasm']);

export function targetsFromSpec(specFile) {
  let text;
  try {
    text = readFileSync(specFile, 'utf8');
  } catch {
    return [...TARGETS];
  }
  const section = text.split('## Target emitters')[1]?.split('\n## ')[0] ?? text;
  const names = [...section.matchAll(/^\|\s*`([a-z][a-z0-9-]*)`\s*\|/gm)].map((m) => m[1]);
  return names.length ? [...new Set(names)] : [...TARGETS];
}

export function validateTarget(name, targets = TARGETS) {
  if (!targets.includes(name)) throw new Error(`unknown target: ${name} (expected one of ${targets.join(', ')})`);
  return name;
}

export function validateBuildTarget(name, targets = BUILD_TARGETS) {
  if (!targets.includes(name)) {
    throw new Error(`unknown target: ${name} (expected one of ${targets.join(', ')})`);
  }
  return name;
}
