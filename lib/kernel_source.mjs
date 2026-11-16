// Stdio driver for the opurom-core runtime kernel — the collector and holder
// of the inspector records (INSPECTOR_DATA_PLANE.md). One kernel process per
// compiled IR answers `frames [sinceSeq]` and `memory` on stdout as
// `frames {json} version N` / `memory {json} version N`; the dev server is
// only the relay. Commands are sequential: each query resolves with the next
// answer line for its channel.

import { spawn } from 'node:child_process';

const CHANNELS = ['frames', 'memory'];

// One stdout line into `{ channel, payload, version }`, or null when the line
// is not a channel answer (state prints, patches, errors, usage).
export function parseKernelLine(line) {
  const match = /^(frames|memory) (.+) version (\d+)$/.exec(String(line).trim());
  if (match === null) return null;
  let payload;
  try {
    payload = JSON.parse(match[2]);
  } catch {
    return null;
  }
  return { channel: match[1], payload, version: Number(match[3]) };
}

export function createKernelSource({ binary, irPath, log = () => {}, timeoutMs = 5000 } = {}) {
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

  const drop = (error) => {
    child = null;
    settle((entry) => entry.reject(error));
  };

  const handleLine = (line) => {
    const answer = parseKernelLine(line);
    if (answer !== null && pending !== null && pending.channel === answer.channel) {
      settle((entry) => entry.resolve(answer));
      return;
    }
    if (line.startsWith('error:')) log(`kernel: ${line}`);
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

  const start = () => {
    if (child) return child;
    child = spawn(binary, [irPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', drain);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => log(`kernel: ${String(chunk).trim()}`));
    child.on('error', drop);
    child.once('exit', (code, signal) => drop(new Error(`kernel exited (${signal ?? code})`)));
    return child;
  };

  // `query('frames 12')` resolves with the next `frames` answer line. A query
  // for one channel while another answer is in flight cannot happen: callers
  // await each query.
  const query = (command, { channel } = {}) => new Promise((resolve, reject) => {
    const name = channel ?? String(command).split(' ')[0];
    if (!CHANNELS.includes(name)) {
      reject(new Error(`kernel query must be frames or memory, got ${name}`));
      return;
    }
    if (!child) {
      reject(new Error('kernel is not running'));
      return;
    }
    const entry = { channel: name, resolve, reject, timer: null };
    entry.timer = setTimeout(() => {
      if (pending === entry) {
        pending = null;
        reject(new Error(`kernel did not answer "${command}" within ${timeoutMs}ms`));
      }
    }, timeoutMs);
    pending = entry;
    try {
      child.stdin.write(`${command}\n`);
    } catch (error) {
      drop(error);
    }
  });

  const stop = () => new Promise((resolve) => {
    const dying = child;
    child = null;
    settle((entry) => entry.reject(new Error('kernel stopped')));
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
    query,
    stop,
  };
}
