// Android device hot reload: drive the reload decision (already made by
// hot_reload.decideReload) onto a running app over adb. A tree-only change is a
// hot update: push the new IR into the app files dir and broadcast the reload
// action so the live activity swaps the frame over its retained state. A schema
// or shell change needs a full install, which rewrites the app process.
//
// The process control is injected (`run`) so the routing and argument shapes are
// unit-testable without a device: the same function backs the real adb calls.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const RELOAD_ACTION = 'org.opurom.mobile.RELOAD';
export const RELOAD_FILE = 'opurom-reload.opuir.json';
export const DEFAULT_PACKAGE = 'org.opurom.mobile';

// Shape an adb command list for one of the two device actions. Pure: it only
// builds argv, so tests assert exact calls. `serial` is the adb -s target.
export function pushIrArgs({ serial, localIr, packageName = DEFAULT_PACKAGE }) {
  // Push to a temp path the shell can write, then copy into the app's private
  // files dir via run-as so the receiver can read it (no external storage perm).
  return [
    ['-s', serial, 'push', localIr, '/data/local/tmp/' + RELOAD_FILE],
    ['-s', serial, 'shell', 'run-as', packageName, 'mkdir', '-p', 'files'],
    ['-s', serial, 'shell', 'run-as', packageName, 'cp',
      '/data/local/tmp/' + RELOAD_FILE, 'files/' + RELOAD_FILE],
  ];
}

export function broadcastArgs({ serial, packageName = DEFAULT_PACKAGE }) {
  return ['-s', serial, 'shell', 'am', 'broadcast', '-a', RELOAD_ACTION, '-p', packageName];
}

export function installArgs({ serial, apk }) {
  return ['-s', serial, 'install', '-r', apk];
}

// Parse `adb devices` output into the list of online serials. Offline/unauthorized
// entries are skipped so a half-connected device never receives a partial push.
export function parseOnlineDevices(output) {
  return String(output)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('List of devices'))
    .map((line) => line.split(/\s+/))
    .filter((cols) => cols.length >= 2 && cols[1] === 'device')
    .map((cols) => cols[0]);
}

// Route one decision to the device. `run(args)` executes one adb argv (injected;
// returns { ok, stdout, stderr }). Returns a { action, ok } record the dev loop
// logs and exposes as state. `hot` pushes + broadcasts; `full` installs the APK.
export function applyDeviceReload({ decision, serial, localIr, apk, run, packageName = DEFAULT_PACKAGE }) {
  if (decision?.kind === 'hot') {
    if (!fs.existsSync(localIr)) {
      return { action: 'hot', ok: false, error: `missing IR to push: ${localIr}` };
    }
    for (const args of pushIrArgs({ serial, localIr, packageName })) {
      const result = run(args);
      if (!result.ok) return { action: 'hot', ok: false, error: `adb ${args[2]} failed: ${result.stderr || result.stdout}` };
    }
    const sent = run(broadcastArgs({ serial, packageName }));
    return sent.ok
      ? { action: 'hot', ok: true }
      : { action: 'hot', ok: false, error: `broadcast failed: ${sent.stderr || sent.stdout}` };
  }
  if (decision?.kind === 'full') {
    if (!apk || !fs.existsSync(apk)) {
      return { action: 'full', ok: false, error: `missing APK to install: ${apk}` };
    }
    const result = run(installArgs({ serial, apk }));
    return result.ok
      ? { action: 'full', ok: true }
      : { action: 'full', ok: false, error: `install failed: ${result.stderr || result.stdout}` };
  }
  return { action: 'none', ok: true };
}

// Thin wrapper over a real exec so dev() can call the same routing above. Kept
// separate from the pure functions so imports stay fs-only at module load.
export function makeAdbRunner({ adb, cwd } = {}) {
  return (args) => {
    const result = spawnSync(adb, args, { cwd, encoding: 'utf8', timeout: 120000 });
    return {
      ok: result.status === 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? (result.error ? String(result.error.message) : ''),
    };
  };
}

// The remote IR path the CLI writes and the app reads. Exposed for logging.
export function remoteIrPath() {
  return path.posix.join('files', RELOAD_FILE);
}
