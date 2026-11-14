// Deterministic hot reload core: compare two IRs and decide whether a rebuild
// is needed and whether application state survives. Pure: no fs, no clock, no
// browser needed, so the whole decision is directly testable.

// A state schema is the declared state list (names + types + initial values).
// Two IRs with the same schema keep their runtime state across a hot reload;
// any change to a name, type or initial value needs a full reload.
function schemaKey(ir) {
  const list = Array.isArray(ir?.state) ? ir.state : [];
  return JSON.stringify(list.map((entry) => [entry?.name, entry?.type, entry?.init]));
}

// The component tree is the rendered part. A change confined to it (props or
// text) is a hot update: the tree re-renders over the preserved state.
function treeKey(ir) {
  return JSON.stringify(ir?.tree ?? null);
}

// Everything else that affects the emitted program (app name, theme, models,
// api) cannot be applied by a tree re-render, so it forces a full reload.
function shellKey(ir) {
  return JSON.stringify({
    app: ir?.app ?? null,
    theme: ir?.theme ?? null,
    models: ir?.models ?? null,
    api: ir?.api ?? null,
  });
}

// prevIr / nextIr: parsed IR objects (or null for "nothing built yet").
export function decideReload(prevIr, nextIr) {
  if (prevIr == null && nextIr == null) return { kind: 'none', reason: 'no-ir' };
  if (prevIr == null) return { kind: 'full', reason: 'initial-build' };
  if (nextIr == null) return { kind: 'full', reason: 'removed-ir' };
  if (shellKey(prevIr) !== shellKey(nextIr)) return { kind: 'full', reason: 'shell-changed' };
  if (schemaKey(prevIr) !== schemaKey(nextIr)) return { kind: 'full', reason: 'state-schema-changed' };
  if (treeKey(prevIr) !== treeKey(nextIr)) return { kind: 'hot', reason: 'tree-changed' };
  return { kind: 'none', reason: 'unchanged' };
}

// Stable, assertable reload log line. No timestamps: the reload counter and the
// decision fields are the only varying values, and both are deterministic.
export function formatReload({ kind, reason, reloads, src }) {
  const name = src == null ? '' : String(src).replace(/^.*[\\/]/, '');
  return `hot-reload #${reloads} ${kind} (${reason}) ${name}`.trim();
}

// Debounce file events into one callback per burst. Uses an injected clock so
// tests drive it without real time: `setTimer`/`clearTimer` default to the
// global timers, and the callback receives the coalesced file list.
export function createDebouncer({
  waitMs = 120,
  onFlush,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof onFlush !== 'function') throw new Error('createDebouncer needs onFlush');
  let timer = null;
  const files = new Set();
  const flush = () => {
    timer = null;
    const changed = [...files].sort();
    files.clear();
    if (changed.length) onFlush(changed);
  };
  return {
    get pending() { return timer !== null; },
    push(file) {
      if (file != null) files.add(String(file));
      if (timer !== null) clearTimer(timer);
      timer = setTimer(flush, waitMs);
    },
    cancel() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      files.clear();
    },
  };
}
