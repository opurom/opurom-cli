// Desktop preview loop for the native target. The emitted binary is a stdio
// state machine (`tap`/`input`/`state`/`quit` on stdin, a `state k=v` line on
// stdout after every command), so the dev loop drives one live process per
// build. shortcut: a tree-only change cannot be swapped in-process today —
// IR_TEXT and apply() are compiled into the binary — so a hot reload restarts
// the process and restores state by replaying the recorded event log (apply()
// is pure and the schema is unchanged on a hot decision). Update when the
// native emitter reads the IR from a file and accepts a reload command; then
// only the data is swapped and the process survives.

import { spawn } from 'node:child_process';

const EVENT_OPS = ['tap', 'doubleTap', 'longPress', 'drag'];

// Numeric-looking fields become numbers so native state reads like the web
// page's state. The binary prints fields space-separated, so a text value that
// contains spaces degrades to its first token — fix when the emitter gains a
// machine-readable state line.
export function parseStateOutput(text) {
  const state = {};
  for (const match of String(text).matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(-?\S+)/g)) {
    const value = match[2];
    state[match[1]] = /^-?\d+$/.test(value) ? Number(value) : value;
  }
  return state;
}

// Validate one interaction into the binary's stdin line, or null when the op
// is not a state-machine command (an invalid id would make the binary print
// only an error line, which would never resolve a state wait).
export function eventLine(event) {
  const id = Number(event?.id);
  if (!Number.isInteger(id) || id < 0) return null;
  if (event.op === 'input') {
    const text = String(event.text ?? '').replace(/\s+/g, ' ').trim();
    return text === '' ? `input ${id}` : `input ${id} ${text}`;
  }
  if (EVENT_OPS.includes(event?.op)) return `${event.op} ${id}`;
  return null;
}

// The event log is the state carrier across the process swap.
export function replayLines(events) {
  return events.map((event) => eventLine(event)).filter((line) => line !== null);
}

// A hot reload preserved state when replaying the log reproduces the state the
// previous process reported; null before/after means unverifiable, not failed.
export function statePreserved(before, after) {
  if (before == null || after == null) return null;
  return JSON.stringify(before) === JSON.stringify(after);
}

// One live binary per build. Commands are sequential: each resolves with the
// next `state` line the binary prints, because every command ends with one.
export function createNativePreview({ binary, log = () => {}, timeoutMs = 5000 } = {}) {
  let child = null;
  let buffer = '';
  let pending = null;

  const settle = (action) => {
    if (!pending) return;
    const entry = pending;
    pending = null;
    clearTimeout(entry.timer);
    action(entry);
  };

  const handleLine = (line) => {
    if (/^state /.test(line)) {
      const state = parseStateOutput(line);
      settle((entry) => entry.resolve({ state }));
      return;
    }
    if (line.startsWith('error:')) log(`native: ${line}`);
  };

  const drain = (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '').trim();
      buffer = buffer.slice(index + 1);
      if (line !== '') handleLine(line);
    }
  };

  const drop = (error) => {
    child = null;
    settle((entry) => entry.reject(error));
  };

  const start = () => {
    if (child) return child;
    child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', drain);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => log(`native: ${String(chunk).trim()}`));
    child.on('error', drop);
    child.once('exit', (code, signal) => drop(new Error(`native preview exited (${signal ?? code})`)));
    return child;
  };

  const command = (line) => new Promise((resolve, reject) => {
    if (!child) {
      reject(new Error('native preview is not running'));
      return;
    }
    const entry = { resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      if (pending === entry) {
        pending = null;
        reject(new Error(`native preview did not answer "${line}" within ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending = entry;
    try {
      child.stdin.write(`${line}\n`);
    } catch (error) {
      drop(error);
    }
  });

  const stop = () => new Promise((resolve) => {
    const dying = child;
    child = null;
    settle((entry) => entry.reject(new Error('native preview stopped')));
    if (!dying) {
      resolve();
      return;
    }
    dying.once('exit', () => resolve());
    dying.kill('SIGTERM');
    setTimeout(() => dying.kill('SIGKILL'), 1000);
  });

  return {
    get running() { return child !== null; },
    get pid() { return child?.pid ?? null; },
    start,
    command,
    stop,
  };
}
