// Log export CLI tests. Flutter logger authority (3.50-candidate.0):
// packages/flutter_tools/lib/src/base/logger.dart:29-64,68-260.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('logs CLI filters saved log files and exports JSON or text', () => {
  const base = tmpDir('logs-cli-');
  try {
    const file = path.join(base, 'dev.log');
    fs.writeFileSync(file, [
      JSON.stringify({ level: 'info', source: 'dev', message: 'server ready' }),
      JSON.stringify({ level: 'warn', source: 'watch', message: 'reload queued' }),
      JSON.stringify({ level: 'error', source: 'kernel', message: 'bad frame' }),
    ].join('\n'));
    const json = run(process.execPath, [CLI, 'logs', file, '--level', 'warn', '--format', 'json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.deepEqual(parsed.rows.map((row) => row.level), ['warn', 'error']);
    assert.equal(parsed.errorCount, 1);
    const text = run(process.execPath, [CLI, 'logs', file, '--q', 'RELOAD', '--format', 'text']);
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stdout.trim(), '[WARN] watch: reload queued');
    const out = path.join(base, 'filtered.json');
    const exported = run(process.execPath, [CLI, 'logs', file, '--format', 'json', '--out', out]);
    assert.equal(exported.status, 0, exported.stderr);
    assert.match(exported.stdout, /logs exported/);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).rows.length, 3);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('logs CLI rejects invalid level, since and limit', () => {
  const base = tmpDir('logs-cli-invalid-');
  try {
    const file = path.join(base, 'dev.log');
    fs.writeFileSync(file, JSON.stringify({ level: 'info', message: 'ok' }));
    for (const args of [
      ['--level', 'debug'],
      ['--since', '-1'],
      ['--limit', '0'],
    ]) {
      const result = run(process.execPath, [CLI, 'logs', file, ...args]);
      assert.notEqual(result.status, 0, args.join(' '));
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
