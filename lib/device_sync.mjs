// Multi-target dev sync: a deterministic device registry and reload broadcast
// log. The reload decision is delegated to hot_reload.decideReload -- there is
// intentionally no second IR classifier here. Assigning a monotonic revision
// and delivering ONE frozen payload to every client keeps the emitted log
// byte-identical for identical inputs; no wall clock enters a decision payload.
import { decideReload } from './hot_reload.mjs';

export const DEVICE_TARGETS = Object.freeze(['web', 'native', 'mini', 'wasm']);
export const DEFAULT_DEVICE_CAP = 32;
export const MAX_ID_LENGTH = 128;
export const MAX_BODY_BYTES = 8192;

export class DeviceRegistryError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DeviceRegistryError';
    this.status = status;
  }
}

function checkedPayload(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new DeviceRegistryError('device payload must be a JSON object', 400);
  }
  const { id, target } = payload;
  if (typeof id !== 'string' || !id.trim()) {
    throw new DeviceRegistryError('device id must be a non-empty string', 400);
  }
  if (id.length > MAX_ID_LENGTH) {
    throw new DeviceRegistryError(`device id must be at most ${MAX_ID_LENGTH} characters`, 400);
  }
  if (typeof target !== 'string' || !DEVICE_TARGETS.includes(target)) {
    throw new DeviceRegistryError(`device target must be one of ${DEVICE_TARGETS.join(', ')}`, 400);
  }
  return { id, target };
}

// createDeviceRegistry is pure: `clock` (injected logical clock for connectedAt)
// and `deliver` (injected "server" sink) never touch the decision payload.
export function createDeviceRegistry({
  cap = DEFAULT_DEVICE_CAP,
  clock = null,
  deliver = () => {},
} = {}) {
  if (!Number.isInteger(cap) || cap < 1) throw new Error('cap must be a positive integer');
  const devices = new Map();
  let seq = 0;         // connected-at sequence (monotonic)
  let revision = 0;    // broadcast revision (monotonic)
  const decisions = [null]; // decisions[revision] = frozen payload (1-indexed)
  const log = [];      // deterministic broadcast log entries

  function register(payload) {
    const { id, target } = checkedPayload(payload);
    if (devices.has(id)) throw new DeviceRegistryError(`duplicate device id: ${id}`, 409);
    if (devices.size >= cap) throw new DeviceRegistryError(`device registry is full (cap ${cap})`, 429);
    seq += 1;
    const connectedAt = typeof clock === 'function' ? clock() : seq;
    const record = { id, target, connectedAt, lastSeen: revision };
    devices.set(id, record);
    return { ...record };
  }

  function list() {
    return [...devices.values()].map((record) => ({ ...record }));
  }

  function snapshot() {
    return { cap, revision, devices: list() };
  }

  // Commit one decision: assign the next revision, freeze ONE payload and
  // deliver it to every client in stable client-id order.
  function commit(decision) {
    const kind = String(decision?.kind ?? 'none');
    const reason = String(decision?.reason ?? 'no-ir');
    revision += 1;
    const payload = Object.freeze({ revision, kind, reason });
    decisions[revision] = payload;
    for (const id of [...devices.keys()].sort()) {
      devices.get(id).lastSeen = revision;
      try { deliver(id, payload); } catch { /* a broken sink must not crash the server */ }
      log.push({ id, revision, kind, reason });
    }
    return payload;
  }

  // Reuse the existing IR classifier; this is the only decision producer.
  function broadcast(prevIr, nextIr) {
    return commit(decideReload(prevIr, nextIr));
  }

  // Exact, byte-identical decisions for every revision a client missed.
  function replay(since = 0) {
    if (!Number.isInteger(since) || since < 0) {
      throw new DeviceRegistryError('since must be a non-negative integer', 400);
    }
    const missed = [];
    for (let r = since + 1; r <= revision; r += 1) missed.push(decisions[r]);
    return { since, revision, decisions: missed };
  }

  function logText() {
    return log.map((e) => `${e.id} r${e.revision} ${e.kind} (${e.reason})`).join('\n');
  }

  return {
    register,
    list,
    snapshot,
    commit,
    broadcast,
    replay,
    log: () => log.map((e) => ({ ...e })),
    logText,
    get size() { return devices.size; },
    get revision() { return revision; },
    get decisions() { return decisions.slice(); },
  };
}

function sendJson(res, status, body) {
  if (res.writableEnded) return;
  try {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(data),
    });
    res.end(data);
  } catch { /* client disconnected before the response */ }
}

// shortcut: body is buffered up to MAX_BODY_BYTES, then drained ignored; a
// streaming parser is warranted only if device payloads grow beyond a header.
function readAndRegister(registry, req, res) {
  let raw = '';
  let tooLarge = false;
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    if (tooLarge) return;
    raw += chunk;
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) tooLarge = true;
  });
  req.on('end', () => {
    try {
      if (tooLarge) { sendJson(res, 413, { error: 'device payload too large' }); return; }
      let payload;
      try { payload = JSON.parse(raw || 'null'); } catch {
        sendJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      sendJson(res, 201, registry.register(payload));
    } catch (error) {
      const status = error instanceof DeviceRegistryError ? error.status : 400;
      sendJson(res, status, { error: error.message });
    }
  });
  req.on('error', () => sendJson(res, 400, { error: 'request body error' }));
  req.on('aborted', () => sendJson(res, 400, { error: 'request aborted' }));
}

// Shared HTTP router for GET/POST /devices and GET /reload?since=N. Returns
// true when the path was handled; never throws, so a bad request cannot crash
// the server. Reused by dev() and by a standalone server in the tests.
export function handleDeviceRequest(registry, req, res, url) {
  const path = url.pathname;
  if (path !== '/devices' && path !== '/reload') return false;
  try {
    if (path === '/devices') {
      if (req.method === 'GET') { sendJson(res, 200, registry.snapshot()); return true; }
      if (req.method === 'POST') { readAndRegister(registry, req, res); return true; }
      sendJson(res, 405, { error: 'method not allowed: use GET or POST /devices' });
      return true;
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed: use GET /reload' });
      return true;
    }
    const raw = url.searchParams.get('since');
    let since = 0;
    if (raw !== null) {
      if (!/^\d+$/.test(raw)) {
        sendJson(res, 400, { error: 'since must be a non-negative integer' });
        return true;
      }
      since = Number(raw);
      if (!Number.isSafeInteger(since)) {
        sendJson(res, 400, { error: 'since is out of range' });
        return true;
      }
    }
    sendJson(res, 200, registry.replay(since));
    return true;
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return true;
  }
}
