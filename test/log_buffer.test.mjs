// Dev server log ring tests. Flutter authority: `Logger` levels and machine
// output in packages/flutter_tools/lib/src/base/logger.dart:29-64, 68-260
// (flutter-golden ab2912035e / 3.50-candidate.0).
import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogRing, makeDevLogger, parseLogLevel } from '../lib/log_buffer.mjs';

test('log levels follow Flutter warning alias and reject unknown values', () => {
  assert.equal(parseLogLevel(undefined), 'trace');
  assert.equal(parseLogLevel('verbose'), 'trace');
  assert.equal(parseLogLevel('WARNING'), 'warn');
  assert.equal(parseLogLevel('error'), 'error');
  assert.throws(() => parseLogLevel('debug'), /invalid log level/);
});

test('log ring is bounded by sequence, not wall clock', () => {
  const ring = createLogRing({ limit: 3, now: () => 42 });
  for (let i = 1; i <= 5; i++) ring.add(i === 4 ? 'error' : 'info', `line-${i}`);
  assert.deepEqual(ring.query().map((row) => row.message), ['line-3', 'line-4', 'line-5']);
  assert.equal(ring.errorCount, 1);
  assert.deepEqual(ring.query({ since: 4 }).map((row) => row.seq), [4, 5]);
  assert.deepEqual(ring.query({ level: 'error' }).map((row) => row.message), ['line-4']);
  assert.equal(ring.query({ q: 'LINE-5' }).length, 1);
  assert.equal(ring.query({ source: 'nope' }).length, 0);
});

test('exports are deterministic in json, ndjson and text', () => {
  const ring = createLogRing({ now: () => 0 });
  ring.add('info', 'first');
  ring.add('warn', 'second', { source: 'watch' });
  const json = JSON.parse(ring.export());
  assert.equal(json.schema, 'opurom.dev-log/v1');
  assert.equal(json.count, 2);
  assert.deepEqual(json.rows.map((row) => row.level), ['info', 'warn']);
  assert.equal(ring.export({ format: 'ndjson' }).trim().split('\n').length, 2);
  assert.equal(ring.export({ format: 'text' }), '[INFO] dev: first\n[WARN] watch: second\n');
  assert.throws(() => ring.export({ format: 'yaml' }), /invalid log export format/);
  assert.deepEqual(ring.clear(), { cleared: true });
  assert.equal(ring.size, 0);
  assert.equal(ring.errorCount, 0);
});

test('dev logger writes to the console once and records the same message', () => {
  const ring = createLogRing();
  const lines = [];
  const logger = makeDevLogger({ ring, log: (line) => lines.push(line), source: 'dev-server' });
  logger.trace('trace line');
  logger.info('info line');
  logger.warn('warn line');
  logger.error('error line');
  assert.deepEqual(lines, ['trace line', 'info line', 'warn line', 'error line']);
  assert.deepEqual(ring.query({ level: 'warn' }).map((row) => row.message), ['warn line', 'error line']);
  assert.ok(ring.query().every((row) => row.source === 'dev-server'));
});
