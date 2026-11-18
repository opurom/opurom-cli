// DevTools aggregate-panel tests. Flutter authority (3.50.0):
// - resident_runner.dart:2012-2043, daemon.dart:1636-1660 (serve/launch contract)
// - dev/devicelab/lib/framework/browser.dart:349-350 (connection URI, not invented data)
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEVTOOLS_PANELS, aggregatePanels, fetchPanels, formatPanels,
} from '../lib/devtools_panels.mjs';

test('panels keep absent availability with explicit reasons', () => {
  const snapshot = aggregatePanels();
  assert.equal(snapshot.schema, 'opurom.devtools-panels/v1');
  assert.equal(snapshot.version, 0);
  assert.deepEqual(Object.keys(snapshot.summary), [...DEVTOOLS_PANELS]);
  for (const row of Object.values(snapshot.summary)) {
    assert.equal(row.availability, 'absent');
    assert.match(row.reason, /no .* payload supplied/);
  }
  assert.match(formatPanels(snapshot), /frames: absent \(no data source\)/);
});

test('panels use the smallest explicit version and preserve payloads', () => {
  const snapshot = aggregatePanels({
    frames: { availability: 'partial', reason: 'rAF only', version: 7, frames: [{ seq: 1, frameMs: 8 }] },
    memory: { availability: 'full', reason: 'kernel', version: 9, memory: { stateBytes: 12 } },
    network: { availability: 'absent', reason: 'no proxy', version: 8 },
    logs: { availability: 'partial', reason: 'saved file', count: 1, version: 10 },
  });
  assert.equal(snapshot.version, 7);
  assert.equal(snapshot.panels.frames.frames[0].frameMs, 8);
  assert.equal(snapshot.panels.memory.memory.stateBytes, 12);
  assert.equal(snapshot.summary.memory.availability, 'full');
  assert.equal(snapshot.summary.network.detail, 'no data source');
});

test('fetchPanels reads the session URLs and survives a failing endpoint', async () => {
  const session = {
    framesUri: 'http://dev/frames',
    memoryUri: 'http://dev/memory',
    networkUri: 'http://dev/network',
    logsUri: 'http://dev/logs',
  };
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === session.networkUri) return { ok: false, status: 503 };
    return { ok: true, json: async () => ({ availability: 'partial', reason: `from ${url}`, version: 3 }) };
  };
  const snapshot = await fetchPanels({ session, fetchImpl });
  assert.deepEqual(seen, [session.framesUri, session.memoryUri, session.networkUri, session.logsUri]);
  assert.equal(snapshot.version, 3);
  assert.equal(snapshot.panels.network.availability, 'absent');
  assert.match(snapshot.panels.network.reason, /503/);
});

test('fetchPanels requires a session object', async () => {
  await assert.rejects(() => fetchPanels({}), /devtools session is required/);
});
