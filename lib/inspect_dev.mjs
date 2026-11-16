// Consume the live observability feed of a running `opurom dev` server: the
// state store the page reports plus its recent interaction events, rendered as
// a read-only text view or byte-stable JSON.

const DEFAULT_DEV_URL = 'http://127.0.0.1:5178';

export function devStateUrl(value) {
  if (value === undefined || value === true) return DEFAULT_DEV_URL;
  const raw = String(value).trim();
  if (raw === '') return DEFAULT_DEV_URL;
  const url = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return url.replace(/\/+$/, '');
}

export async function fetchDevState({ url, fetchImpl = fetch } = {}) {
  const base = devStateUrl(url);
  let response;
  try {
    response = await fetchImpl(`${base}/__opurom/state`);
  } catch (error) {
    throw new Error(`dev server not reachable at ${base}: ${error.message} (start it with "opurom dev --src <file>")`);
  }
  if (!response.ok) throw new Error(`dev server at ${base} answered HTTP ${response.status} for /__opurom/state`);
  let snapshot;
  try {
    snapshot = await response.json();
  } catch (error) {
    throw new Error(`invalid /__opurom/state payload from ${base}: ${error.message}`);
  }
  return { base, snapshot };
}

function stateRows(state) {
  if (typeof state !== 'object' || state === null || Array.isArray(state)) return [`value: ${JSON.stringify(state)}`];
  return Object.keys(state).sort().map((key) => `${key}=${JSON.stringify(state[key])}`);
}

export function stateViewText({ base, snapshot }) {
  const lines = [
    'Opurom inspect live state (read-only GET /__opurom/state)',
    `dev: ${base}`,
  ];
  if (snapshot.state === null || snapshot.state === undefined) {
    lines.push(snapshot.stateAt
      ? `state: null (page reported no state store at ${snapshot.stateAt})`
      : 'state: not reported yet (open the app page; the dev client posts window.opurom.state)');
  } else {
    lines.push(`state reported at ${snapshot.stateAt ?? 'unknown time'}:`);
    const rows = stateRows(snapshot.state);
    if (rows.length === 0) lines.push('  (empty)');
    for (const row of rows) lines.push(`  ${row}`);
  }
  const events = Array.isArray(snapshot.events) ? snapshot.events : [];
  if (events.length === 0) {
    lines.push('events: none yet');
  } else {
    lines.push(`events: ${Number(snapshot.eventCount) || events.length} total, showing ${events.length} (oldest first)`);
    for (const event of events) {
      lines.push(`  #${event.seq} ${event.type} node=${event.nodeId ?? '-'} at=${event.at}`);
    }
  }
  return lines.join('\n');
}

// Top-level keys in a fixed order so the JSON form is byte-stable.
export function stateViewJson({ base, snapshot }) {
  return {
    command: 'inspect',
    mode: 'state',
    url: base,
    state: snapshot.state ?? null,
    stateAt: snapshot.stateAt ?? null,
    eventCount: Number(snapshot.eventCount) || 0,
    events: Array.isArray(snapshot.events) ? snapshot.events : [],
  };
}

export async function inspectDevState({ url, json: jsonMode = false, log = console.log, fetchImpl = fetch } = {}) {
  const view = await fetchDevState({ url, fetchImpl });
  log(jsonMode ? JSON.stringify(stateViewJson(view), null, 2) : stateViewText(view));
  return 0;
}
