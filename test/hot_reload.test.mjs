import assert from 'node:assert/strict';
import test from 'node:test';
import { createDebouncer, decideReload, formatReload } from '../lib/hot_reload.mjs';

const baseIr = () => ({
  ir: '0.1',
  app: 'Counter',
  state: [{ name: 'count', type: 'int', init: 0 }],
  tree: {
    id: 0,
    kind: 'Column',
    props: { gap: 8 },
    children: [{ id: 1, kind: 'Text', props: { value: 'Count: {count}' }, children: [], events: {} }],
    events: {},
  },
  theme: { mode: 'system' },
});

test('decideReload returns none for identical IR', () => {
  const a = baseIr();
  const b = structuredClone(a);
  assert.deepEqual(decideReload(a, b), { kind: 'none', reason: 'unchanged' });
});

test('decideReload returns hot for a leaf-only change with the same state schema', () => {
  const prev = baseIr();
  const next = structuredClone(prev);
  next.tree.children[0].props.value = 'Total: {count}';
  assert.deepEqual(decideReload(prev, next), { kind: 'hot', reason: 'tree-changed' });
});

test('decideReload returns full when the state schema changes', () => {
  const prev = baseIr();
  const next = structuredClone(prev);
  next.state.push({ name: 'label', type: 'string', init: '' });
  assert.deepEqual(decideReload(prev, next), { kind: 'full', reason: 'state-schema-changed' });
});

test('decideReload returns full when a state type or init changes', () => {
  const typeChange = structuredClone(baseIr());
  typeChange.state[0].type = 'float';
  assert.equal(decideReload(baseIr(), typeChange).kind, 'full');
  const initChange = structuredClone(baseIr());
  initChange.state[0].init = 5;
  assert.equal(decideReload(baseIr(), initChange).kind, 'full');
});

test('decideReload returns full when the shell (theme/app) changes', () => {
  const next = structuredClone(baseIr());
  next.theme.accent = '#FF0000';
  assert.deepEqual(decideReload(baseIr(), next), { kind: 'full', reason: 'shell-changed' });
});

test('decideReload handles the undefined-IR edges', () => {
  assert.deepEqual(decideReload(null, null), { kind: 'none', reason: 'no-ir' });
  assert.deepEqual(decideReload(null, baseIr()), { kind: 'full', reason: 'initial-build' });
  assert.deepEqual(decideReload(baseIr(), null), { kind: 'full', reason: 'removed-ir' });
});

test('formatReload is stable: no timestamps, deterministic fields', () => {
  const line = formatReload({ kind: 'hot', reason: 'tree-changed', reloads: 3, src: '/tmp/demo/main.opu' });
  assert.equal(line, 'hot-reload #3 hot (tree-changed) main.opu');
  assert.doesNotMatch(line, /\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/);
});

test('createDebouncer coalesces rapid events into one flush with an injected clock', () => {
  let now = 0;
  const timers = new Map();
  let nextId = 1;
  const setTimer = (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; };
  const clearTimer = (id) => timers.delete(id);
  const flushes = [];
  const deb = createDebouncer({ waitMs: 120, onFlush: (files) => flushes.push(files), setTimer, clearTimer });

  deb.push('main.opu');
  now += 40;
  deb.push('main.opu');
  now += 40;
  deb.push('views.opu');
  assert.equal(deb.pending, true);
  assert.equal(flushes.length, 0);

  // Advance past the last scheduled timer and fire it.
  now += 200;
  for (const [id, timer] of [...timers]) {
    if (timer.at <= now) { timers.delete(id); timer.fn(); }
  }
  assert.equal(flushes.length, 1);
  assert.deepEqual(flushes[0], ['main.opu', 'views.opu']);
  assert.equal(deb.pending, false);
});

test('createDebouncer cancels without flushing', () => {
  let fired = 0;
  const setTimer = () => 1;
  const clearTimer = () => {};
  const deb = createDebouncer({ onFlush: () => { fired++; }, setTimer, clearTimer });
  deb.push('a.opu');
  deb.cancel();
  assert.equal(fired, 0);
  assert.equal(deb.pending, false);
});
