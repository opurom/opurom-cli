import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SYNC_CLIENTS, MAX_SYNC_CLIENTS, OPCODE, acceptKey, decodeFrame, encodeFrame,
  formatSyncReport, handshakeRequest, handshakeResponse, maskedTextFrame, parseClientCount,
  parseHandshakeResponse, parseUpgradeRequest, startLoopbackHub, verifySync,
} from '../lib/sync.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

async function waitFor(predicate, timeout = 1000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition was not met before the test timeout');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withHub(options, fn) {
  const hub = await startLoopbackHub({ port: 0, ...options });
  try {
    return await fn(hub);
  } finally {
    await hub.close();
  }
}

function assertPortClosed(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('error', (error) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve();
      else reject(error);
    });
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`port ${port} is still listening`));
    });
  });
}

test('RFC 6455 handshake uses the published accept-key vector', () => {
  const key = 'dGhlIHNhbXBsZSBub25jZQ==';
  const accept = 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=';
  assert.equal(acceptKey(key), accept);
  const request = handshakeRequest({ host: '127.0.0.1', port: 5178, key });
  assert.equal(request, [
    'GET /__opurom/sync HTTP/1.1',
    'Host: 127.0.0.1:5178',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n'));
  assert.deepEqual(parseUpgradeRequest(request), { path: '/__opurom/sync', key });
  const response = handshakeResponse(key);
  assert.equal(response, [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  assert.equal(parseHandshakeResponse(Buffer.from(response), key).accept, accept);
  assert.throws(() => parseHandshakeResponse(Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), key), /server answered/);
  assert.throws(() => parseHandshakeResponse(Buffer.from(response.replace(accept, 'bad')), key), /does not match/);
  assert.throws(() => parseUpgradeRequest(request.replace('Sec-WebSocket-Version: 13', 'Sec-WebSocket-Version: 12')), /version/);
});

test('masked text frames carry the exact RFC 6455 header, mask and payload', () => {
  const text = '{"type":"state"}';
  const mask = Buffer.from([1, 2, 3, 4]);
  const frame = maskedTextFrame(text, mask);
  const bytes = Buffer.from(text);
  assert.equal(frame[0], 0x81);
  assert.equal(frame[1], 0x80 | bytes.length);
  assert.deepEqual([...frame.subarray(2, 6)], [1, 2, 3, 4]);
  assert.deepEqual(frame.subarray(6), Buffer.from(bytes.map((byte, index) => byte ^ mask[index % 4])));
  const decoded = decodeFrame(frame, { expectMasked: true });
  assert.equal(decoded.frame.fin, true);
  assert.equal(decoded.frame.opcode, OPCODE.TEXT);
  assert.equal(decoded.frame.payload.toString('utf8'), text);
  assert.equal(decoded.rest.length, 0);
  assert.throws(() => decodeFrame(frame, { expectMasked: false }), /server frame is masked/);
  const long = encodeFrame(OPCODE.TEXT, 'x'.repeat(130), { mask });
  assert.equal(long[1] & 0x7f, 126);
  assert.equal(long.readUInt16BE(2), 130);
  assert.equal(decodeFrame(long, { expectMasked: true }).frame.payload.length, 130);
});

test('client count defaults to 2, caps at 8, and the CLI rejects invalid values', () => {
  assert.equal(DEFAULT_SYNC_CLIENTS, 2);
  assert.equal(MAX_SYNC_CLIENTS, 8);
  assert.equal(parseClientCount(), 2);
  assert.equal(parseClientCount(true), 2);
  assert.equal(parseClientCount('1'), 1);
  assert.equal(parseClientCount('8'), 8);
  for (const value of ['0', '-1', '9', '3.5', 'nope', false, Number.NaN, Infinity]) {
    assert.throws(() => parseClientCount(value), /invalid --clients: .* \(expected 1\.\.8\)/);
  }
  for (const value of ['0', '9']) {
    const result = spawnSync(process.execPath, [CLI, 'dev', '--sync', '--clients', value, '--port', '5178'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(`error: invalid --clients: ${value} \\(expected 1\\.\\.8\\)`));
  }
});

test('sync reports only measured times or honest n/a reasons', () => {
  const base = { host: '127.0.0.1', port: 5178, clients: 2, delta: { count: 1 } };
  const passed = formatSyncReport({
    ...base, status: 'PASS', reason: null,
    measurements: [{ client: 1, ms: 1.25 }, { client: 2, ms: 2.5 }],
  });
  assert.match(passed, /client 1: 1\.25 ms/);
  assert.match(passed, /client 2: 2\.5 ms/);
  assert.match(passed, /same delta: PASS \(2\/2\)/);
  const failed = formatSyncReport({
    ...base, status: 'FAIL', reason: '1 client missed the state delta',
    measurements: [{ client: 1, ms: Number.NaN, reason: 'hub closed' }, { client: 2, ms: 2.5 }],
  });
  assert.match(failed, /client 1: n\/a \(hub closed\)/);
  assert.match(failed, /status: FAIL/);
  const skipped = formatSyncReport({ ...base, status: 'SKIP', reason: 'no sync hub at 127.0.0.1:5178' });
  assert.match(skipped, /sync: n\/a \(no sync hub at 127\.0\.0\.1:5178\)/);
  assert.match(skipped, /status: SKIP/);
  assert.doesNotMatch(skipped, /same delta: PASS/);
  assert.match(skipped, /NOT real devices; no visual diff, no network capture UI/);
});

test('N=2 real WebSocket clients receive one identical delta via ping/pong and close', { timeout: 10000 }, async () => {
  await withHub({}, async (hub) => {
    const result = await verifySync({ port: hub.port, clients: 2, timeout: 2000, log: () => {} });
    assert.equal(result.status, 'PASS');
    assert.equal(result.code, 0);
    assert.equal(result.measurements.length, 2);
    for (const row of result.measurements) {
      assert.ok(Number.isFinite(row.ms) && row.ms >= 0);
      assert.deepEqual(row.delta, { count: 1 });
    }
    assert.match(result.report, /same delta: PASS \(2\/2\)/);
    await waitFor(() => hub.state.pongs >= 2 && hub.state.closes >= 2 && hub.state.clients.size === 0);
    assert.equal(hub.state.delivered, 2);
    assert.deepEqual(hub.state.errors, []);
  });
});

test('N=8 real WebSocket clients receive the same measured state delta', { timeout: 15000 }, async () => {
  await withHub({}, async (hub) => {
    const result = await verifySync({ port: hub.port, clients: 8, timeout: 3000, log: () => {} });
    assert.equal(result.status, 'PASS');
    assert.equal(result.code, 0);
    assert.equal(result.measurements.length, 8);
    assert.equal(new Set(result.measurements.map((row) => JSON.stringify(row.delta))).size, 1);
    for (const row of result.measurements) assert.ok(Number.isFinite(row.ms) && row.ms >= 0);
    assert.match(result.report, /same delta: PASS \(8\/8\)/);
    assert.equal(hub.state.delivered, 8);
    await waitFor(() => hub.state.pongs >= 8 && hub.state.clients.size === 0);
  });
});

test('a different delta on one client is a FAIL', { timeout: 10000 }, async () => {
  await withHub({ corruptClient: 1 }, async (hub) => {
    const result = await verifySync({ port: hub.port, clients: 2, timeout: 2000, log: () => {} });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.code, 1);
    assert.match(result.report, /clients received different state deltas/);
    assert.ok(result.measurements.every((row) => Number.isFinite(row.ms)));
    assert.equal(hub.state.delivered, 2);
  });
});

test('a dropped client is a FAIL and never fabricates its delivery time', { timeout: 10000 }, async () => {
  await withHub({ dropClient: 1 }, async (hub) => {
    const result = await verifySync({ port: hub.port, clients: 2, timeout: 400, log: () => {} });
    assert.equal(result.status, 'FAIL');
    assert.equal(result.code, 1);
    assert.match(result.report, /missed the state delta/);
    assert.match(result.report, /client \d+: n\/a \(/);
    assert.ok(result.measurements.some((row) => !Number.isFinite(row.ms)));
    assert.equal(hub.state.delivered, 1);
  });
});

test('no running hub is a documented SKIP with a clean exit', { timeout: 10000 }, async () => {
  const closed = await startLoopbackHub({ port: 0 });
  const port = closed.port;
  await closed.close();
  const result = await verifySync({ port, clients: 2, timeout: 400, log: () => {} });
  assert.equal(result.status, 'SKIP');
  assert.equal(result.code, 0);
  assert.match(result.report, /sync: n\/a \(no sync hub at 127\.0\.0\.1:\d+: connect ECONNREFUSED/);
  assert.match(result.report, /status: SKIP/);
  assert.doesNotMatch(result.report, /same delta: PASS/);
});

test('verification leaves no listening hub or client sockets', { timeout: 10000 }, async () => {
  const hub = await withHub({}, async (active) => {
    const result = await verifySync({ port: active.port, clients: 2, timeout: 2000, log: () => {} });
    assert.equal(result.status, 'PASS');
    await waitFor(() => active.state.clients.size === 0 && active.state.closes >= 2);
    return active;
  });
  assert.equal(hub.server.listening, false);
  assert.equal(hub.state.clients.size, 0);
  await assertPortClosed(hub.port);
});
