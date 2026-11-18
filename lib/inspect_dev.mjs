// Consume the live observability feed of a running `opurom dev` server: the
// state store the page reports, its recent interaction events, and the last
// good compiled IR, rendered as read-only text views or byte-stable JSON.

import fs from 'node:fs';
import path from 'node:path';
import { inspectTree, rendererBinary } from './inspect_tree.mjs';
import { diffTrees, digestJson, formatDigestText, readBaseline, renderDigest } from './inspect_digest.mjs';
import { tmpDir } from './paths.mjs';

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

export async function fetchDevIr({ url, fetchImpl = fetch } = {}) {
  const base = devStateUrl(url);
  let response;
  try {
    response = await fetchImpl(`${base}/__opurom/ir`);
  } catch (error) {
    throw new Error(`dev server not reachable at ${base}: ${error.message} (start it with "opurom dev --src <file>")`);
  }
  if (response.status === 404) {
    let reason = 'no-compile-yet';
    try { reason = (await response.json()).reason ?? reason; } catch { /* keep the default reason */ }
    throw new Error(`dev server at ${base} has no compiled IR yet (reason: ${reason}); wait for the first build`);
  }
  if (!response.ok) throw new Error(`dev server at ${base} answered HTTP ${response.status} for /__opurom/ir`);
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new Error(`invalid /__opurom/ir payload from ${base}: ${error.message}`);
  }
  const ir = payload?.ir;
  if (!ir || typeof ir !== 'object') throw new Error(`invalid /__opurom/ir payload from ${base}: missing IR document`);
  return { base, ir };
}

// The tree view reads an IR file and asks the renderer for authoritative
// bounds, so the fetched document is staged once in a temp file. Everything
// downstream (validation, renderer invocation, output) is the static path.
export async function inspectDevTree({
  url, select = undefined, layers = false, json: jsonMode = false,
  root = undefined, renderer = null, log = console.log, fetchImpl = fetch,
} = {}) {
  const { base, ir } = await fetchDevIr({ url, fetchImpl });
  const dir = tmpDir('inspect-dev-ir-');
  try {
    const file = path.join(dir, 'live.opuir.json');
    fs.writeFileSync(file, JSON.stringify(ir));
    return inspectTree({ ir: file, select, layers, json: jsonMode, root, renderer, log });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Golden digest diff over the live IR: fetch the running app's IR from the dev
// server, render it with the same renderer + viewport the golden gate uses,
// and compare against opurom-examples/golden/counter. A missing baseline
// degrades to a live-digest-only view, never a fabricated diff.
export async function inspectDevDigest({
  url, json: jsonMode = false, root = undefined, renderer = null,
  log = console.log, fetchImpl = fetch,
} = {}) {
  const { base, ir } = await fetchDevIr({ url, fetchImpl });
  const renderBin = rendererBinary({ root, renderer });
  const dir = tmpDir('inspect-digest-');
  try {
    const liveFile = path.join(dir, 'live.opuir.json');
    fs.writeFileSync(liveFile, JSON.stringify(ir));
    const { digest: liveDigest } = renderDigest(renderBin, liveFile, dir, 'live');
    const baseline = readBaseline(root, renderBin);
    const diff = baseline.missing ? null : diffTrees(baseline.ir, ir);
    const view = { base, liveDigest, baseline, diff };
    log(jsonMode ? JSON.stringify(digestJson(view), null, 2) : formatDigestText(view));
    return 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// DevTools session discovery: the Opurom counterpart of the Flutter daemon's
// `devtools.serve` (flutter-golden ab2912035e, daemon.dart:1636-1660 and
// resident_runner.dart:2090-2098). No VM Service is invented: the live dev
// server is the session, and the data-plane URLs are reported as-is.
export async function fetchDevtoolsSession({ url, fetchImpl = fetch } = {}) {
  const base = devStateUrl(url);
  let response;
  try {
    response = await fetchImpl(`${base}/api/devtools/session`);
  } catch (error) {
    throw new Error(`dev server not reachable at ${base}: ${error.message} (start it with "opurom dev --src <file>")`);
  }
  if (response.status === 404) {
    throw new Error(`dev server at ${base} is older than devtools.serve; restart "opurom dev --src <file>"`);
  }
  if (!response.ok) throw new Error(`dev server at ${base} answered HTTP ${response.status} for /api/devtools/session`);
  let session;
  try {
    session = await response.json();
  } catch (error) {
    throw new Error(`invalid /api/devtools/session payload from ${base}: ${error.message}`);
  }
  return { base, session };
}

export function devtoolsSessionText({ base, session }) {
  const lines = [
    'Opurom DevTools session (read-only GET /api/devtools/session)',
    `dev: ${base}`,
    `host: ${session.host}:${session.port}`,
    `devtools: ${session.devtoolsUri}`,
    `ir: ${session.irUri}`,
    `frames: ${session.framesUri}`,
    `memory: ${session.memoryUri}`,
    `network: ${session.networkUri}`,
    `events: ${session.eventsUri}`,
    `logs: ${session.logsUri}`,
    `exit: ${session.exitUri}`,
    `debug adapter: ${session.debugAdapter ?? 'not found (check out opurom-debug)'}`,
    `inspector bundle: ${session.inspectorAvailable ? 'available' : 'missing (build it with "opurom-web inspector")'}`,
  ];
  if (session.environment) lines.push(`environment: ${session.environment}`);
  if (session.mode) lines.push(`mode: ${session.mode}`);
  return `${lines.join('\n')}\n`;
}

export async function inspectDevtools({
  url, json: jsonMode = false, panels = false, log = console.log, fetchImpl = fetch,
} = {}) {
  const view = await fetchDevtoolsSession({ url, fetchImpl });
  if (panels) {
    const { fetchPanels, formatPanels } = await import('./devtools_panels.mjs');
    const snapshot = await fetchPanels({ session: view.session, fetchImpl });
    log(jsonMode ? JSON.stringify(snapshot, null, 2) : formatPanels(snapshot));
    return 0;
  }
  log(jsonMode ? JSON.stringify(view.session, null, 2) : devtoolsSessionText(view));
  return 0;
}
