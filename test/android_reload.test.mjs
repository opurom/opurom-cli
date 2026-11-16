import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RELOAD_ACTION, broadcastArgs, installArgs, parseOnlineDevices, pushIrArgs,
  applyDeviceReload, remoteIrPath, RELOAD_FILE,
} from '../lib/android_reload.mjs';

function tmpFile(name, body = '{}') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-android-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

test('parseOnlineDevices keeps only online serials', () => {
  const out = [
    'List of devices attached',
    'emulator-5554\tdevice',
    'emulator-5556\toffline',
    'XYZ123\tunauthorized',
    '',
  ].join('\n');
  assert.deepEqual(parseOnlineDevices(out), ['emulator-5554']);
  assert.deepEqual(parseOnlineDevices('List of devices attached\n'), []);
});

test('pushIrArgs pushes to tmp then copies into the app files dir via run-as', () => {
  const calls = pushIrArgs({ serial: 'emulator-5554', localIr: '/t/app.opuir.json', packageName: 'org.opurom.mobile' });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], ['-s', 'emulator-5554', 'push', '/t/app.opuir.json', '/data/local/tmp/' + RELOAD_FILE]);
  assert.deepEqual(calls[1], ['-s', 'emulator-5554', 'shell', 'run-as', 'org.opurom.mobile', 'mkdir', '-p', 'files']);
  assert.deepEqual(calls[2], ['-s', 'emulator-5554', 'shell', 'run-as', 'org.opurom.mobile', 'cp', '/data/local/tmp/' + RELOAD_FILE, 'files/' + RELOAD_FILE]);
  assert.equal(remoteIrPath(), 'files/' + RELOAD_FILE);
});

test('broadcastArgs targets the reload action and package', () => {
  assert.deepEqual(broadcastArgs({ serial: 'S', packageName: 'org.opurom.mobile' }),
    ['-s', 'S', 'shell', 'am', 'broadcast', '-a', RELOAD_ACTION, '-p', 'org.opurom.mobile']);
});

test('installArgs reinstalls with -r', () => {
  assert.deepEqual(installArgs({ serial: 'S', apk: '/d/app.apk' }), ['-s', 'S', 'install', '-r', '/d/app.apk']);
});

test('a hot decision pushes and broadcasts, never installs', () => {
  const localIr = tmpFile('app.opuir.json');
  const seen = [];
  const result = applyDeviceReload({
    decision: { kind: 'hot', reason: 'tree-changed' },
    serial: 'S', localIr, apk: null,
    run: (args) => { seen.push(args.join(' ')); return { ok: true }; },
  });
  assert.deepEqual(result, { action: 'hot', ok: true });
  assert.ok(seen.some((c) => c.includes('push')));
  assert.ok(seen.some((c) => c.includes('broadcast')));
  assert.ok(!seen.some((c) => c.includes('install')));
});

test('a full decision installs the APK, never pushes', () => {
  const apk = tmpFile('app.apk', 'x');
  const seen = [];
  const result = applyDeviceReload({
    decision: { kind: 'full', reason: 'state-schema-changed' },
    serial: 'S', localIr: null, apk,
    run: (args) => { seen.push(args.join(' ')); return { ok: true }; },
  });
  assert.deepEqual(result, { action: 'full', ok: true });
  assert.ok(seen.some((c) => c.includes('install')));
  assert.ok(!seen.some((c) => c.includes('push')));
});

test('none decision is a no-op', () => {
  let called = 0;
  const result = applyDeviceReload({
    decision: { kind: 'none', reason: 'unchanged' },
    serial: 'S', run: () => { called += 1; return { ok: true }; },
  });
  assert.deepEqual(result, { action: 'none', ok: true });
  assert.equal(called, 0);
});

test('a failed push surfaces the adb error and stops before broadcast', () => {
  const localIr = tmpFile('app.opuir.json');
  const seen = [];
  const result = applyDeviceReload({
    decision: { kind: 'hot', reason: 'tree-changed' },
    serial: 'S', localIr,
    run: (args) => { seen.push(args[2]); return { ok: args[2] !== 'push', stderr: 'boom' }; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /push failed/);
  assert.ok(!seen.includes('broadcast'), 'no broadcast after a failed push');
});

test('missing IR on a hot decision fails without touching adb', () => {
  let called = 0;
  const result = applyDeviceReload({
    decision: { kind: 'hot', reason: 'tree-changed' },
    serial: 'S', localIr: '/no/such/app.opuir.json',
    run: () => { called += 1; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing IR/);
  assert.equal(called, 0);
});

test('missing APK on a full decision fails without touching adb', () => {
  let called = 0;
  const result = applyDeviceReload({
    decision: { kind: 'full', reason: 'initial-build' },
    serial: 'S', apk: '/no/such/app.apk',
    run: () => { called += 1; return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /missing APK/);
  assert.equal(called, 0);
});
