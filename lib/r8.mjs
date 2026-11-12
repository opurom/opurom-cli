// R8 sync verification: RFC 6455 wire helpers, a loopback broadcast hub, and
// measured state-delta delivery over real TCP client sockets.
import crypto from 'node:crypto';
import net from 'node:net';
import { formatExactMillis, unavailable } from './bench.mjs';

export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const WS_VERSION = '13';
export const SYNC_PATH = '/__opurom/sync';
export const DEFAULT_SYNC_PORT = 5178;
export const DEFAULT_SYNC_CLIENTS = 2;
export const MAX_SYNC_CLIENTS = 8;
export const MAX_FRAME_PAYLOAD = 1024 * 1024;
export const MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
export const OPCODE = Object.freeze({
  CONTINUATION: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xA,
});

const DATA_OPCODES = new Set([OPCODE.CONTINUATION, OPCODE.TEXT, OPCODE.BINARY]);
const CONTROL_OPCODES = new Set([OPCODE.CLOSE, OPCODE.PING, OPCODE.PONG]);
const NO_HUB_CODES = new Set(['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ETIMEDOUT']);

export function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + WS_GUID, 'utf8').digest('base64');
}

export function randomKey() {
  return crypto.randomBytes(16).toString('base64');
}

export function randomMask() {
  return crypto.randomBytes(4);
}

export function handshakeRequest({
  host = '127.0.0.1', port = DEFAULT_SYNC_PORT, path = SYNC_PATH, key = randomKey(),
} = {}) {
  const target = path.startsWith('/') ? path : `/${path}`;
  return `GET ${target} HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${WS_VERSION}\r\n\r\n`;
}

export function handshakeResponse(key) {
  return `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`;
}

function headersFromLines(lines) {
  const headers = new Map();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return headers;
}

export function parseUpgradeRequest(head) {
  const lines = String(head).split('\r\n');
  const request = /^GET\s+(\S+)\s+HTTP\/1\.1$/.exec(lines[0] ?? '');
  if (!request) throw new Error('the WebSocket upgrade is not a GET HTTP/1.1 request');
  const headers = headersFromLines(lines.slice(1));
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw new Error('the upgrade header is not websocket');
  }
  if (!(headers.get('connection') ?? '').split(',').some((value) => value.trim().toLowerCase() === 'upgrade')) {
    throw new Error('the connection header does not request upgrade');
  }
  if ((headers.get('sec-websocket-version') ?? '').trim() !== WS_VERSION) {
    throw new Error('the WebSocket version is not 13');
  }
  const key = (headers.get('sec-websocket-key') ?? '').trim();
  if (!key) throw new Error('the WebSocket key is missing');
  return { path: request[1], key };
}

export function parseHandshakeResponse(bytes, key) {
  const lines = Buffer.from(bytes).toString('latin1').split('\r\n');
  if (!String(lines[0] ?? '').startsWith('HTTP/1.1 101')) {
    throw new Error(`the server answered ${lines[0] ?? 'an empty response'}`);
  }
  const headers = headersFromLines(lines.slice(1));
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') {
    throw new Error('the handshake answer has no websocket upgrade header');
  }
  if (!(headers.get('connection') ?? '').split(',').some((value) => value.trim().toLowerCase() === 'upgrade')) {
    throw new Error('the handshake answer has no connection upgrade header');
  }
  const expected = acceptKey(key);
  const accept = headers.get('sec-websocket-accept');
  if (accept !== expected) throw new Error('Sec-WebSocket-Accept does not match Sec-WebSocket-Key');
  return { status: lines[0], headers, accept };
}

export function closePayload(code = 1000, reason = '') {
  const text = Buffer.from(String(reason), 'utf8');
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

export function encodeFrame(opcode, payload = Buffer.alloc(0), { fin = true, mask = null } = {}) {
  if (!DATA_OPCODES.has(opcode) && !CONTROL_OPCODES.has(opcode)) throw new Error(`unknown WebSocket opcode: ${opcode}`);
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  if (data.length > MAX_FRAME_PAYLOAD) throw new Error('WebSocket frame exceeds the size limit');
  if (CONTROL_OPCODES.has(opcode) && (!fin || data.length > 125)) {
    throw new Error('a control frame must be final and at most 125 bytes');
  }
  const lengthCode = data.length;
  let head;
  if (lengthCode < 126) {
    head = Buffer.alloc(2);
    head[1] = lengthCode;
  } else if (lengthCode <= 0xffff) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(lengthCode, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(lengthCode), 2);
  }
  head[0] = (fin ? 0x80 : 0) | opcode;
  if (!mask) {
    head[1] &= 0x7f;
    return Buffer.concat([head, data]);
  }
  const key = Buffer.from(mask);
  if (key.length !== 4) throw new Error('a WebSocket mask must be four bytes');
  head[1] |= 0x80;
  const masked = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i += 1) masked[i] = data[i] ^ key[i % 4];
  return Buffer.concat([head, key, masked]);
}

export function maskedTextFrame(text, mask = randomMask()) {
  return encodeFrame(OPCODE.TEXT, text, { mask });
}

export function decodeFrame(bytes, { expectMasked = false, maxPayload = MAX_FRAME_PAYLOAD } = {}) {
  if (bytes.length < 2) return null;
  const first = bytes[0];
  const second = bytes[1];
  if (first & 0x70) throw new Error('a reserved WebSocket bit is set');
  const fin = (first & 0x80) !== 0;
  const opcode = first & 0x0f;
  if (!DATA_OPCODES.has(opcode) && !CONTROL_OPCODES.has(opcode)) throw new Error('unknown WebSocket opcode');
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (bytes.length < offset + 2) return null;
    length = bytes.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (bytes.length < offset + 8) return null;
    const raw = bytes.readBigUInt64BE(offset);
    offset += 8;
    if (raw > BigInt(maxPayload)) throw new Error('WebSocket frame exceeds the size limit');
    length = Number(raw);
  }
  if (length > maxPayload) throw new Error('WebSocket frame exceeds the size limit');
  if (CONTROL_OPCODES.has(opcode) && (!fin || length > 125)) {
    throw new Error('a control frame must be final and at most 125 bytes');
  }
  if (expectMasked && !masked) throw new Error('a client frame is not masked');
  if (!expectMasked && masked) throw new Error('a server frame is masked');
  const maskOffset = offset;
  const payloadOffset = offset + (masked ? 4 : 0);
  if (bytes.length < payloadOffset + length) return null;
  let payload = bytes.subarray(payloadOffset, payloadOffset + length);
  if (masked) {
    const mask = bytes.subarray(maskOffset, maskOffset + 4);
    const copy = Buffer.from(payload);
    for (let i = 0; i < copy.length; i += 1) copy[i] ^= mask[i % 4];
    payload = copy;
  }
  return { frame: { fin, opcode, masked, payload }, rest: bytes.subarray(payloadOffset + length) };
}

class MessageReader {
  constructor({ expectMasked = false, maxMessage = MAX_MESSAGE_BYTES } = {}) {
    this.expectMasked = expectMasked;
    this.maxMessage = maxMessage;
    this.opcode = null;
    this.chunks = [];
    this.size = 0;
  }

  complete() {
    const message = { kind: 'message', opcode: this.opcode, payload: Buffer.concat(this.chunks, this.size) };
    this.opcode = null;
    this.chunks = [];
    this.size = 0;
    return message;
  }

  push(bytes) {
    let rest = bytes;
    const messages = [];
    while (rest.length) {
      const parsed = decodeFrame(rest, { expectMasked: this.expectMasked });
      if (!parsed) return { messages, rest };
      rest = parsed.rest;
      const frame = parsed.frame;
      if (CONTROL_OPCODES.has(frame.opcode)) {
        messages.push({ kind: 'control', frame });
        continue;
      }
      if (frame.opcode === OPCODE.CONTINUATION) {
        if (this.opcode === null) throw new Error('a continuation frame has no start frame');
        this.size += frame.payload.length;
        if (this.size > this.maxMessage) throw new Error('WebSocket message exceeds the size limit');
        this.chunks.push(frame.payload);
        if (frame.fin) messages.push(this.complete());
        continue;
      }
      if (this.opcode !== null) throw new Error('a data frame started before the previous one finished');
      if (frame.payload.length > this.maxMessage) throw new Error('WebSocket message exceeds the size limit');
      if (frame.fin) {
        messages.push({ kind: 'message', opcode: frame.opcode, payload: frame.payload });
      } else {
        this.opcode = frame.opcode;
        this.chunks = [frame.payload];
        this.size = frame.payload.length;
      }
    }
    return { messages, rest };
  }
}

// A testable loopback hub: it uses the same bounded frame conventions as the
// Rust server, then broadcasts one canonical delta after N state events.
export function startLoopbackHub({
  host = '127.0.0.1', port = 0, expectedClients = null, dropClient = null,
  corruptClient = null, log = () => {},
} = {}) {
  const state = {
    clients: new Set(),
    events: new Set(),
    expectedClients: expectedClients === null ? null : parseClientCount(expectedClients),
    delta: null,
    broadcast: false,
    delivered: 0,
    pongs: 0,
    closes: 0,
    errors: [],
  };
  let nextId = 0;

  const send = (client, opcode, payload) => {
    if (client.active && !client.socket.destroyed && !client.socket.writableEnded) {
      client.socket.write(encodeFrame(opcode, payload));
    }
  };
  const closeClient = (client, code, reason) => {
    if (!client.active) return;
    client.active = false;
    state.clients.delete(client);
    state.events.delete(client.id);
    try {
      client.socket.end(encodeFrame(OPCODE.CLOSE, closePayload(code, reason)));
    } catch {
      client.socket.destroy();
    }
  };
  const protocolError = (client, message) => {
    state.errors.push(message);
    log(`loopback hub: ${message}`);
    closeClient(client, 1002, message);
  };
  const broadcast = () => {
    if (state.broadcast || state.delta === null || state.events.size < state.expectedClients) return;
    state.broadcast = true;
    const dropId = Number(dropClient);
    if (Number.isInteger(dropId) && dropId > 0) {
      const victim = [...state.clients].find((client) => client.id === dropId && client.active);
      if (victim) closeClient(victim, 1001, 'client dropped by test hub');
    }
    const canonical = JSON.parse(state.delta);
    const normal = JSON.stringify({ type: 'delta', delta: canonical });
    const source = canonical && typeof canonical === 'object' && !Array.isArray(canonical) ? canonical : {};
    const corrupted = JSON.stringify({ type: 'delta', delta: { ...source, corrupt: true } });
    for (const client of [...state.clients]) {
      if (!client.active) continue;
      const corruptId = Number(corruptClient);
      send(client, OPCODE.TEXT, client.id === corruptId ? corrupted : normal);
      state.delivered += 1;
    }
  };
  const handleMessage = (client, message) => {
    if (message.kind === 'control') {
      const frame = message.frame;
      if (frame.opcode === OPCODE.PING) {
        send(client, OPCODE.PONG, frame.payload);
      } else if (frame.opcode === OPCODE.PONG) {
        state.pongs += 1;
      } else if (frame.opcode === OPCODE.CLOSE) {
        state.closes += 1;
        client.active = false;
        state.clients.delete(client);
        state.events.delete(client.id);
        if (!client.socket.destroyed) client.socket.end(encodeFrame(OPCODE.CLOSE, frame.payload));
      }
      return;
    }
    if (message.opcode !== OPCODE.TEXT) {
      protocolError(client, 'sync events must be text frames');
      return;
    }
    let event;
    try {
      event = JSON.parse(message.payload.toString('utf8'));
    } catch {
      protocolError(client, 'a sync event is not valid JSON');
      return;
    }
    if (event?.type !== 'state' || event.delta === undefined) {
      protocolError(client, 'a sync event has no state delta');
      return;
    }
    if (state.expectedClients === null) {
      const count = Number(event.clients);
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SYNC_CLIENTS) {
        protocolError(client, 'a sync event has an invalid client count');
        return;
      }
      state.expectedClients = count;
    }
    if (state.delta === null) state.delta = JSON.stringify(event.delta);
    state.events.add(client.id);
    broadcast();
  };

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    const client = {
      id: ++nextId,
      socket,
      buffer: Buffer.alloc(0),
      upgraded: false,
      reader: new MessageReader({ expectMasked: true }),
      active: true,
    };
    state.clients.add(client);
    socket.on('error', (error) => {
      if (client.active) state.errors.push(error.message);
    });
    socket.on('close', () => {
      client.active = false;
      state.clients.delete(client);
      state.events.delete(client.id);
    });
    socket.on('data', (chunk) => {
      if (!client.active) return;
      client.buffer = Buffer.concat([client.buffer, chunk]);
      if (!client.upgraded) {
        const end = client.buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        const head = client.buffer.subarray(0, end + 4).toString('latin1');
        let request;
        try {
          request = parseUpgradeRequest(head);
        } catch (error) {
          state.errors.push(error.message);
          socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
          return;
        }
        client.upgraded = true;
        client.buffer = client.buffer.subarray(end + 4);
        const reply = Buffer.from(handshakeResponse(request.key), 'latin1');
        socket.write(Buffer.concat([reply, encodeFrame(OPCODE.PING, 'r8')]));
      }
      try {
        const parsed = client.reader.push(client.buffer);
        client.buffer = parsed.rest;
        for (const message of parsed.messages) handleMessage(client, message);
      } catch (error) {
        protocolError(client, error.message);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = address && typeof address === 'object' ? address.port : port;
      resolve({
        server,
        host,
        port: actualPort,
        state,
        close: () => new Promise((done, fail) => {
          if (!server.listening) return done();
          for (const client of [...state.clients]) client.socket.destroy();
          state.clients.clear();
          server.close((error) => (error ? fail(error) : done()));
        }),
      });
    });
  });
}

export function parseClientCount(value = DEFAULT_SYNC_CLIENTS) {
  if (value === true || value === undefined || value === '') return DEFAULT_SYNC_CLIENTS;
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SYNC_CLIENTS) {
    throw new Error(`invalid --clients: ${String(value)} (expected 1..${MAX_SYNC_CLIENTS})`);
  }
  return count;
}

export function formatSyncReport({
  host, port, path = SYNC_PATH, clients, delta, measurements = [], status, reason,
}) {
  const lines = [
    'OPUROM dev --sync (MEASURED WebSocket state-delta delivery)',
    `hub: ws://${host}:${port}${path}`,
    `clients: ${clients} real loopback TCP WebSocket client${clients === 1 ? '' : 's'}`,
  ];
  if (status === 'SKIP') {
    lines.push(`sync: ${unavailable(reason)}`);
    lines.push('status: SKIP (documented; no successful sync is claimed)');
  } else {
    lines.push(`state delta: ${JSON.stringify(delta)}`);
    for (const row of measurements) {
      const timing = Number.isFinite(row.ms)
        ? formatExactMillis(row.ms)
        : unavailable(row.reason ?? 'missed state delta');
      lines.push(`client ${row.client}: ${timing}`);
    }
    lines.push(status === 'PASS'
      ? `same delta: PASS (${measurements.length}/${clients})`
      : `same delta: FAIL (${reason})`);
    lines.push(`status: ${status}`);
  }
  lines.push('scope: loopback clients on one host, NOT real devices; no visual diff, no network capture UI.');
  return lines.join('\n');
}

function tagPhase(error, phase) {
  const value = error instanceof Error ? error : new Error(String(error));
  value.phase = phase;
  return value;
}

function isNoHubError(error) {
  return error?.phase === 'connect'
    && (NO_HUB_CODES.has(error.code) || /timed out|no sync hub/i.test(error.message));
}

function runSyncClient({ host, port, path, key, eventText, timeout }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    let reader = null;
    let started = null;
    let done = false;
    let timer = null;

    const finish = (result, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners('data');
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      const closeFrame = encodeFrame(OPCODE.CLOSE, closePayload(1000, 'sync complete'), { mask: randomMask() });
      socket.end(closeFrame, () => socket.destroy());
      resolve(result);
    };
    const fail = (error, phase = upgraded ? 'frame' : 'connect') => finish(null, tagPhase(error, phase));

    timer = setTimeout(() => fail(new Error(`timed out after ${timeout} ms`)), timeout);
    socket.on('error', (error) => {
      if (!done) fail(error, upgraded ? 'frame' : 'connect');
    });
    socket.on('close', () => {
      if (!done) fail(new Error('hub closed before the state delta'), upgraded ? 'frame' : 'connect');
    });
    socket.on('connect', () => {
      socket.write(handshakeRequest({ host, port, path, key }));
    });
    socket.on('data', (chunk) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end === -1) return;
        try {
          parseHandshakeResponse(buffer.subarray(0, end + 4), key);
        } catch (error) {
          fail(error, 'handshake');
          return;
        }
        upgraded = true;
        reader = new MessageReader({ expectMasked: false });
        buffer = buffer.subarray(end + 4);
        started = process.hrtime.bigint();
        socket.write(maskedTextFrame(eventText));
      }
      try {
        const parsed = reader.push(buffer);
        buffer = parsed.rest;
        for (const message of parsed.messages) {
          if (message.kind === 'control') {
            const frame = message.frame;
            if (frame.opcode === OPCODE.PING) {
              socket.write(encodeFrame(OPCODE.PONG, frame.payload, { mask: randomMask() }));
            } else if (frame.opcode === OPCODE.CLOSE) {
              fail(new Error('hub closed before the state delta'), 'frame');
              return;
            }
            continue;
          }
          if (message.opcode !== OPCODE.TEXT) {
            fail(new Error('server replied with a non-text frame'), 'frame');
            return;
          }
          const text = message.payload.toString('utf8');
          let reply;
          try {
            reply = JSON.parse(text);
          } catch {
            fail(new Error('server reply is not valid JSON'), 'frame');
            return;
          }
          if (reply?.type === 'error') {
            fail(new Error(reply.message ?? 'hub rejected the state event'), 'frame');
            return;
          }
          const received = reply && Object.prototype.hasOwnProperty.call(reply, 'delta') ? reply.delta : reply;
          const deltaText = JSON.stringify(received);
          if (deltaText === undefined || started === null) {
            fail(new Error('server reply has no state delta'), 'frame');
            return;
          }
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          if (!Number.isFinite(ms)) {
            fail(new Error('delivery time is not measurable'), 'frame');
            return;
          }
          finish({ ms, delta: received, deltaText, reply: text });
          return;
        }
      } catch (error) {
        fail(error, 'frame');
      }
    });
  });
}

export async function verifySync({
  host = '127.0.0.1',
  port = Number(process.env.OPR_SYNC_PORT ?? DEFAULT_SYNC_PORT),
  path = SYNC_PATH,
  clients = DEFAULT_SYNC_CLIENTS,
  delta = { count: 1 },
  timeout = 5000,
  log = console.log,
} = {}) {
  const count = parseClientCount(clients);
  const hubPort = Number(port);
  if (!Number.isInteger(hubPort) || hubPort < 1 || hubPort > 65535) {
    throw new Error(`invalid sync hub port: ${String(port)} (expected 1..65535)`);
  }
  const eventText = JSON.stringify({ type: 'state', clients: count, delta });
  const settled = await Promise.all(Array.from({ length: count }, () => runSyncClient({
    host, port: hubPort, path, key: randomKey(), eventText, timeout,
  }).then(
    (result) => ({ ok: true, result }),
    (error) => ({ ok: false, error }),
  )));

  const measurements = settled.map((entry, index) => ({
    client: index + 1,
    ms: entry.ok ? entry.result.ms : Number.NaN,
    delta: entry.ok ? entry.result.delta : null,
    reason: entry.ok ? null : entry.error.message,
  }));
  const firstError = settled.find((entry) => !entry.ok)?.error;
  let status = 'PASS';
  let reason = null;
  const noHub = settled.every((entry) => !entry.ok && isNoHubError(entry.error));
  if (noHub) {
    status = 'SKIP';
    reason = `no sync hub at ${host}:${hubPort}: ${firstError?.message ?? 'connection failed'}`;
  } else if (firstError) {
    const missed = settled.filter((entry) => !entry.ok).length;
    status = 'FAIL';
    reason = `${missed} client${missed === 1 ? '' : 's'} missed the state delta: ${firstError.message}`;
  } else if (new Set(settled.map((entry) => entry.result.deltaText)).size !== 1) {
    status = 'FAIL';
    reason = 'clients received different state deltas';
  }

  const report = formatSyncReport({
    host, port: hubPort, path, clients: count, delta, measurements: status === 'SKIP' ? [] : measurements, status, reason,
  });
  log(report);
  return { status, reason, code: status === 'FAIL' ? 1 : 0, report, measurements };
}
