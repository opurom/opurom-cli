// Source-level interaction test runner: a declarative script drives an IR
// through events and an animation clock, then asserts final state and frame
// digest. State transitions run in opurom-core (tap/input by node id); frames
// rasterize in opurom-render with --state/--tick overrides. Both are pure, so a
// given IR plus steps always yields the same digest.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { compilerPath } from './build.mjs';
import { ensureSiblingBinary, workspaceRoot } from './paths.mjs';

const ENV = { ...process.env, PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}` };

function coreBinary(log) {
  const found = ensureSiblingBinary('opurom-core', ['opurom-core', 'opurom_core'], { root: workspaceRoot(), log });
  if (!found.path) throw new Error(`opurom-core unavailable: ${found.reason}`);
  return found.path;
}

function renderBinary(log) {
  const found = ensureSiblingBinary('opurom-render', ['opurom-render', 'opurom_render'], { root: workspaceRoot(), log });
  if (!found.path) throw new Error(`opurom-render unavailable: ${found.reason}`);
  return found.path;
}

// State after a step list: replay every tap/input in one core session and read
// the final snapshot. The core CLI prints one line per command; the last
// `state [...]` line carries the values.
function stateAfterSteps(corePath, irPath, steps) {
  const lines = [];
  for (const step of steps) {
    if (step.tap !== undefined) lines.push(`tap ${step.tap}`);
    else if (step.input !== undefined) lines.push(`input ${step.input} ${step.value ?? ''}`);
    else if (step.tick !== undefined) continue; // tick does not mutate state
    else throw new Error(`unknown step: ${JSON.stringify(step)}`);
  }
  lines.push('state', 'quit');
  const run = spawnSync(corePath, [irPath], { input: lines.join('\n'), encoding: 'utf8', env: ENV });
  if (run.status !== 0) {
    throw new Error(`opurom-core exited ${run.status}: ${(run.stderr || run.stdout || '').trim().slice(0, 300)}`);
  }
  const stateLines = (run.stdout || '').split('\n').filter((line) => line.startsWith('state '));
  const last = stateLines[stateLines.length - 1];
  if (!last) throw new Error('opurom-core printed no state snapshot');
  const json = last.slice('state '.length, last.lastIndexOf(' version '));
  const pairs = JSON.parse(json);
  return Object.fromEntries(pairs.map((entry) => [entry.name, entry.value]));
}

function totalTick(steps) {
  return steps.reduce((sum, step) => sum + (step.tick ?? 0), 0);
}

// Frame digest for the final state at the accumulated tick.
function frameDigest(renderPath, irPath, width, height, state, tick, tmp) {
  const out = join(tmp, `frame-${tick}-${Object.keys(state).length}.ppm`);
  const args = [irPath, String(width), String(height), out];
  for (const [name, value] of Object.entries(state)) args.push('--state', `${name}=${value}`);
  if (tick > 0) args.push('--tick', String(tick));
  const run = spawnSync(renderPath, args, { encoding: 'utf8', env: ENV });
  if (run.status !== 0) {
    throw new Error(`opurom-render exited ${run.status}: ${(run.stderr || run.stdout || '').trim().slice(0, 300)}`);
  }
  const match = (run.stdout || '').match(/digest=([0-9a-f]+)/i);
  if (!match) throw new Error('opurom-render printed no digest');
  return match[1];
}

function sameState(actual, expected) {
  const keys = Object.keys(expected);
  return keys.every((key) => JSON.stringify(actual[key]) === JSON.stringify(expected[key]));
}

function loadScript(scriptPath) {
  const script = JSON.parse(readFileSync(scriptPath, 'utf8'));
  if (!script.ir && !script.src) throw new Error('script needs an "ir" or "src" path');
  if (script.ir && script.src) throw new Error('script needs exactly one of "ir" or "src"');
  if (!Array.isArray(script.steps)) throw new Error('script needs a "steps" array');
  const base = dirname(resolve(scriptPath));
  const loaded = { ...script };
  if (script.ir) loaded.ir = resolve(base, script.ir);
  if (script.src) loaded.src = resolve(base, script.src);
  return loaded;
}

// Compiles a source file into tmp so a script can drive an app that has no
// checked-in IR. The compiler resolves imports through the project the source
// lives in, so registry packages keep working.
function compileSource(srcPath, tmp, log) {
  const out = join(tmp, 'app.opuir.json');
  const compiler = compilerPath({ log });
  const run = spawnSync(compiler, ['compile', srcPath, '-o', out], { encoding: 'utf8', env: ENV });
  if (run.status !== 0) {
    throw new Error(`opuromc compile failed: ${(run.stderr || run.stdout || '').trim().slice(0, 300)}`);
  }
  return out;
}

// Runs one interaction-test script. Returns a result record and never throws on
// an assertion mismatch (only on a tool or script failure).
export function runWidgetScript(scriptPath, { log = () => {}, keepFrames = false } = {}) {
  const started = performance.now();
  const tmp = mkdtempSync(join(tmpdir(), 'opurom-widget-'));
  try {
    const script = loadScript(scriptPath);
    const corePath = coreBinary(log);
    const renderPath = renderBinary(log);
    const irPath = script.src ? compileSource(script.src, tmp, log) : script.ir;
    const width = script.width ?? 320;
    const height = script.height ?? 240;
    const state = stateAfterSteps(corePath, irPath, script.steps);
    const tick = totalTick(script.steps);
    const digest = frameDigest(renderPath, irPath, width, height, state, tick, tmp);

    const expect = script.expect ?? {};
    const failures = [];
    if (expect.state && !sameState(state, expect.state)) {
      failures.push(`state mismatch: got ${JSON.stringify(state)}, expected ${JSON.stringify(expect.state)}`);
    }
    if (expect.digest && digest !== expect.digest) {
      failures.push(`digest mismatch: got ${digest}, expected ${expect.digest}`);
    }
    return {
      id: scriptPath,
      status: failures.length ? 'FAIL' : 'PASS',
      state,
      digest,
      failures,
      ms: performance.now() - started,
    };
  } catch (error) {
    return { id: scriptPath, status: 'FAIL', failures: [error.message], ms: performance.now() - started };
  } finally {
    if (!keepFrames) rmSync(tmp, { recursive: true, force: true });
  }
}

export function runWidgetTests(files, { log = () => {}, verbose = false } = {}) {
  const results = files.map((file) => {
    const result = runWidgetScript(file, { log });
    const tag = result.status === 'PASS' ? 'PASS' : 'FAIL';
    const detail = result.status === 'PASS'
      ? `state ${JSON.stringify(result.state)} digest ${result.digest}`
      : result.failures.join('; ');
    console.log(`${tag}  ${file}  ${(result.ms / 1000).toFixed(2)}s`);
    if (verbose || result.status === 'FAIL') for (const line of result.failures) console.log(`      ${line}`);
    return result;
  });
  const failed = results.filter((result) => result.status === 'FAIL').length;
  console.log(`\ninteraction tests: ${results.length - failed} passed, ${failed} failed`);
  return { results, passed: results.length - failed, failed, exitCode: failed ? 1 : 0 };
}

export function discoverScripts(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!existsSync(current)) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name.endsWith('.wtest.json')) found.push(full);
    }
  }
  return found.sort();
}
