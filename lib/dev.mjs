import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CLI_ROOT, workspaceRoot } from './paths.mjs';
import { build, buildFull, compilerPath } from './build.mjs';
import { decideReload, formatReload } from './hot_reload.mjs';
import { createDeviceRegistry, handleDeviceRequest } from './device_sync.mjs';
import { applyDeviceReload, makeAdbRunner, parseOnlineDevices } from './android_reload.mjs';
import { createNativePreview, eventLine, replayLines, statePreserved } from './native_preview.mjs';
import { createFrameTier, frameTargetMs, nearestRank, percentiles, PROMOTION_DEN, PROMOTION_NUM, PROMOTION_WINDOWS, rankPercentile, TIER_ORDER, WINDOW_FRAMES } from './frame_tier.mjs';
import { createKernelSource } from './kernel_source.mjs';
import { createInspectRelay } from './inspect_relay.mjs';
import { createLogRing, makeDevLogger, parseLogLevel } from './log_buffer.mjs';
import { buildServer, dbPathFor, spawnService, waitForHealth } from './service.mjs';
import { runOrThrow } from './proc.mjs';
import { VALID_TARGETS, WEB_DOM_TARGET } from './targets.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// Runs before app.js so a reloaded page can pick the snapshot back up.
export function devClientScript() {
  return `<script>
(function () {
  var KEY = 'opurom.state';
  var snapshot = null;
  try { snapshot = JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) {}
  window.opurom = window.opurom || {};
  window.__Opurom_STATE_RESTORE__ = snapshot;
  if (snapshot != null) {
    if (window.opurom.state == null) window.opurom.state = snapshot;
    if (window.opuromState == null) window.opuromState = snapshot;
  }
  var es = new EventSource('/__opurom/events');
  es.addEventListener('snapshot', function (event) {
    try {
      var shared = JSON.parse(event.data);
      window.opurom.syncSnapshot = shared;
      window.__Opurom_SYNC_SNAPSHOT__ = shared;
    } catch (e) {}
  });
  es.addEventListener('reload', function () {
    var state = (window.opurom && window.opurom.state) || window.opuromState || window.state || snapshot;
    try { sessionStorage.setItem(KEY, JSON.stringify(state == null ? null : state)); } catch (e) {}
    location.reload();
  });

  // Observability: capture interactions with their nearest node id and report
  // the live state store to the dev server, exposed to "inspect --dev".
  var pending = [];
  var lastSent = null;
  ['click', 'input', 'change', 'keydown'].forEach(function (type) {
    document.addEventListener(type, function (event) {
      var node = event.target && event.target.closest ? event.target.closest('[data-node-id]') : null;
      pending.push({ type: type, nodeId: node ? Number(node.getAttribute('data-node-id')) : null });
    }, true);
  });
  function reportState() {
    var current = (window.opurom && window.opurom.state !== undefined) ? window.opurom.state : null;
    var text = JSON.stringify(current);
    var events = pending;
    if (text === lastSent && events.length === 0) return;
    pending = [];
    fetch('/__opurom/state', {
      method: 'POST',
      keepalive: true,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ state: current, events: events }),
    }).then(function () {
      lastSent = text;
    }, function () {
      pending = events.concat(pending);
    });
  }
  setInterval(reportState, 500);

  // Frame timeline agent: rAF deltas feed the in-page budget, which is the
  // exact tested mirror from lib/frame_tier.mjs injected below, so the perf.rs
  // rules cannot drift from the tested copy. The record is handed to the dev
  // server already carrying the tier the closed window decided.
  if (!window.__opuromFrameAgent) {
    window.__opuromFrameAgent = true;
    var constants = ${JSON.stringify({ TIER_ORDER, PROMOTION_WINDOWS, PROMOTION_NUM, PROMOTION_DEN, WINDOW_FRAMES })};
    var TIER_ORDER = constants.TIER_ORDER;
    var WINDOW_FRAMES = constants.WINDOW_FRAMES;
    var PROMOTION_WINDOWS = constants.PROMOTION_WINDOWS;
    var PROMOTION_NUM = constants.PROMOTION_NUM;
    var PROMOTION_DEN = constants.PROMOTION_DEN;
    ${frameTargetMs.toString()}
    ${rankPercentile.toString()}
    ${percentiles.toString()}
    ${createFrameTier.toString()}
    var frameMachine = createFrameTier({ hz: 60 });
    var frameBatch = [];
    var frameLast = null;
    var frameSending = false;
    function flushFrames() {
      if (frameSending || frameBatch.length === 0) return;
      var payload = frameBatch.splice(0, frameBatch.length);
      frameSending = true;
      fetch('/__opurom/frames', {
        method: 'POST',
        keepalive: true,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ frames: payload }),
      }).then(function () {}, function () {}).then(function () { frameSending = false; });
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(function frameLoop(now) {
      if (frameLast !== null && now >= frameLast) {
        frameBatch.push(frameMachine.push(now - frameLast, frameLast));
        if (frameBatch.length >= 20) flushFrames();
      }
      frameLast = now;
      requestAnimationFrame(frameLoop);
    });
  }
})();
</script>`;
}

export function injectDevClient(html) {
  const script = devClientScript();
  if (html.includes('/__opurom/events')) return html;
  const head = /<head[^>]*>/i.exec(html);
  if (head) return `${html.slice(0, head.index + head[0].length)}\n${script}${html.slice(head.index + head[0].length)}`;
  const body = /<\/body>/i.exec(html);
  if (body) return `${html.slice(0, body.index)}\n${script}\n${html.slice(body.index)}`;
  return `${script}\n${html}`;
}

// shortcut: 0.1.0 web emitter keeps `const state` in its own script scope; dev-only
// rewrite merges the snapshot and exposes state for the next reload. Update when
// an emitter changes its state declaration.
export function patchAppState(js) {
  if (js.includes('__opurom_state_exposed__')) return js;
  const merged = js.replace(
    /^(\s*(?:const|let|var)\s+state\s*=\s*)(\{[^\n]*\})(\s*;)/m,
    '$1Object.assign($2, window.__Opurom_STATE_RESTORE__ || {})$3',
  );
  return `${merged}\n// __opurom_state_exposed__\nwindow.opurom = window.opurom || {};\nwindow.opurom.state = typeof state !== "undefined" ? state : window.opurom.state;\n`;
}

// shortcut: the web-dom multi-page router keeps `state` in its own closure, so
// the dev client cannot read it. This dev-only rewrite publishes that same
// object as window.opurom.state; drop it when the emitter exposes the store.
export function exposeRouterState(html) {
  if (html.includes('__opurom_router_state__')) return html;
  return html.replace(
    /(\bvar state = )(\{[^\n]*\})(;)/,
    '$1$2$3\nwindow.opurom = window.opurom || {};window.opurom.state = state; // __opurom_router_state__\n',
  );
}

export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const STATE_EVENT_LIMIT = 200;
const STATE_BODY_LIMIT = 64 * 1024;

// Bounded body read for the state reporter: the page posts small JSON, so an
// oversized payload is drained but neither buffered nor parsed.
export function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (over) return;
      if (size > STATE_BODY_LIMIT) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (over) reject(new Error('payload too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
    req.on('close', () => reject(new Error('request closed before the body arrived')));
  });
}

export function createSyncHub(initial = {}) {
  const clients = new Set();
  let shared = structuredClone(initial);
  const write = (res, frame) => {
    try {
      res.write(frame);
      return true;
    } catch {
      clients.delete(res);
      return false;
    }
  };
  const hub = {
    clients,
    get size() { return clients.size; },
    snapshot() { return structuredClone({ ...shared, clients: clients.size }); },
    update(patch = {}) {
      shared = { ...shared, ...structuredClone(patch) };
      return hub.snapshot();
    },
    add(res) {
      clients.add(res);
      const current = hub.snapshot();
      write(res, sseFrame('snapshot', current));
      return current;
    },
    remove(res) {
      return clients.delete(res);
    },
    broadcast(event, data) {
      if (event === 'reload') {
        shared = {
          ...shared,
          reloads: (Number(shared.reloads) || 0) + 1,
          lastReload: structuredClone(data),
        };
      }
      const frame = sseFrame(event, data);
      let delivered = 0;
      for (const res of [...clients]) if (write(res, frame)) delivered++;
      return delivered;
    },
  };
  return hub;
}

export function lanUrls(port) {
  return Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && (entry.family === 'IPv4' || entry.family === 4) && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}/`);
}

// Dev previews lower plain emitter targets only: full and wasm drive cargo builds.
// The responsive DOM build is an extra single-emitter target, so it is accepted
// alongside the eight 0.1.0 emitters and is the everyday default preview.
export function parseDevTargets(value) {
  const raw = value === undefined || value === true ? WEB_DOM_TARGET : String(value);
  const list = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (!VALID_TARGETS.includes(name)) {
      throw new Error(`invalid --targets: ${name} (expected one of ${VALID_TARGETS.join(', ')})`);
    }
    if (!list.includes(name)) list.push(name);
  }
  return list.length ? list : [WEB_DOM_TARGET];
}

export function targetsIndexHtml(entries) {
  const items = entries.map(({ target, entry }) => entry
    ? `<li><a href="/${target}/${entry}">${target}</a> (${entry})</li>`
    : `<li>${target} (no emitted files)</li>`)
    .join('');
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>opurom dev targets</title></head><body><h1>opurom dev targets</h1><ul>${items}</ul></body></html>\n`;
}

export function resolveStatic(root, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.resolve(root, `.${rel}`);
  if (file !== path.resolve(root) && !file.startsWith(`${path.resolve(root)}${path.sep}`)) return null;
  return file;
}

export function mimeType(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

export function freePortNumber() {
  const probe = net.createServer();
  return new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

export async function dev({
  src, port = 5178, root = workspaceRoot(), log = console.log, signals = true, backend = true, sync = false, targets = [WEB_DOM_TARGET],
  reload = true, android = null, kernel = null, inspector = undefined,
  env = process.env, environment = null, buildInfo = null,
} = {}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  const logRing = createLogRing();
  const devLog = makeDevLogger({ ring: logRing, log });
  devLog.info(`dev server starting: ${srcAbs}`);
  if (environment) devLog.info(`environment: ${environment.name}`);
  if (buildInfo) devLog.info(`build mode: ${buildInfo.mode}`);
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const outDir = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'dev-'));
  const backendDir = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'dev-backend-'));
  const syncHost = sync ? '0.0.0.0' : '127.0.0.1';
  const devTargets = parseDevTargets(Array.isArray(targets) ? targets.join(',') : targets);
  const multi = devTargets.length > 1;
  const state = {
    service: 'opurom-dev',
    ok: true,
    src: srcAbs,
    port,
    targets: devTargets,
    // Only the web canvas emitter has an app.js state declaration to rewrite;
    // the responsive DOM page carries its own state runtime, so both restore
    // a sessionStorage snapshot across a hot reload.
    stateRestore: devTargets.filter((target) => target === 'web' || target === WEB_DOM_TARGET),
    rebuilds: 0,
    lastBuild: null,
    lastError: null,
    reloads: 0,
    lastReload: null,
    backend: { enabled: backend, status: 'off', port: null, restarts: 0, lastError: null },
  };
  if (sync) {
    state.sync = {
      enabled: true, mode: 'dev-preview', host: syncHost, urls: [], clients: 0, reloads: 0, lastReload: null,
    };
  }
  const hub = sync ? createSyncHub({
    mode: 'dev-preview',
    service: state.service,
    src: state.src,
    port: state.port,
    host: syncHost,
    urls: [],
    rebuilds: 0,
    lastBuild: null,
    lastError: null,
    backend: state.backend,
    reloads: 0,
    lastReload: null,
  }) : null;
  const clients = hub ? hub.clients : new Set();
  // Multi-target device registry: each reload decision is committed here with a
  // monotonic revision and delivered identically to every registered preview.
  const registry = createDeviceRegistry();

  // Live observability feed: the state store the running page reports plus a
  // bounded ring of its interaction events; seq/at are stamped server-side so
  // the view does not trust the browser clock.
  const feed = { state: null, stateAt: null, events: [], seq: 0 };
  const feedSnapshot = () => ({
    state: feed.state,
    stateAt: feed.stateAt,
    events: feed.events.slice(),
    eventCount: feed.seq,
  });
  // Inspector relay: frames/memory/network rings behind the SSE channels and
  // the /api/inspect pull fallbacks. One memory entry per state dispatch.
  const relay = createInspectRelay();
  // Hosting prefers the assembled bundle (`opurom-web inspector <out-dir>`,
  // assembled to dist/inspector) over the raw sources.
  // shortcut: no assembly stamp here — a stale assembled dir wins over newer
  // sources until web-dev adds a build marker. CI checks out opurom-cli alone,
  // so both sibling paths may be absent; /inspector then answers 404 with the
  // build hint, and tests supply a fixture dir instead of depending on them.
  const assembledInspector = path.join(workspaceRoot(), 'opurom-web', 'dist', 'inspector');
  const inspectorBundle = inspector
    ? path.resolve(inspector)
    : (fs.existsSync(path.join(assembledInspector, 'index.html'))
      ? assembledInspector
      : path.join(workspaceRoot(), 'opurom-web', 'inspector'));
  // Kernel collector (opt-in via `kernel: { binary }`): the runtime kernel is
  // the holder of the frame/memory ledgers, the dev server only relays. The
  // compiled IR is staged beside the dev output and the kernel restarts with
  // every applied reload. An unavailable kernel is a degraded badge, never a
  // failure.
  const kernelIrFile = path.join(outDir, 'kernel.opuir.json');
  const kernelSource = kernel ? createKernelSource({ binary: kernel.binary, irPath: kernel.irPath ?? kernelIrFile, log }) : null;
  // Host frame loop (plan B): the CLI owns the FrameBudget mirror and its own
  // monotonic clock; every page-measured frame is assembled into a FrameSample
  // and recorded into the kernel, whose ledger then reports frames as full.
  const hostClockStart = process.hrtime.bigint();
  const hostClockMs = () => Number((process.hrtime.bigint() - hostClockStart) / 1000000n);
  const hostFrameBudget = kernelSource ? createFrameTier({ hz: 60 }) : null;
  const stageKernelIr = () => {
    if (live.ir) fs.writeFileSync(kernelIrFile, JSON.stringify(live.ir));
  };
  const pullKernel = async () => {
    const frames = await kernelSource.query('frames 0');
    const memory = await kernelSource.query('memory');
    relay.addFrames(frames.payload.frames ?? [], { source: 'kernel' });
    relay.addMemoryRecord(memory.payload);
    broadcast('frame', relay.pullFrames());
    broadcast('memory', relay.pullMemory());
  };
  const restartKernel = async () => {
    if (!kernelSource) return;
    await kernelSource.stop();
    stageKernelIr();
    kernelSource.start();
    await pullKernel();
  };
  const setFeedState = (value) => {
    feed.state = value;
    feed.stateAt = new Date().toISOString();
    // The kernel owns the memory ledger when it is attached; the page-state
    // dispatch only feeds the relay on agent hosts.
    if (!kernelSource && value !== null && value !== undefined) {
      relay.addMemory({ state: value });
      broadcast('memory', relay.pullMemory());
    }
  };
  const recordFeedEvent = (item) => {
    if (!item || typeof item.type !== 'string') return false;
    feed.events.push({
      seq: ++feed.seq,
      type: item.type,
      nodeId: Number.isInteger(item.nodeId) ? item.nodeId : null,
      at: new Date().toISOString(),
    });
    while (feed.events.length > STATE_EVENT_LIMIT) feed.events.shift();
    return true;
  };

  // Desktop preview for the native target: one live binary per build, driven
  // over its stdio state machine; a swap restarts the process and restores
  // state by replaying the recorded event log.
  const nativeBinary = path.join(outDir, 'target', 'release', 'opurom_native');
  const nativePreview = devTargets.length === 1 && devTargets[0] === 'native'
    ? createNativePreview({ log, binary: nativeBinary })
    : null;
  let nativeEventLog = [];

  // Android device hot reload (opt-in via `android`). Resolve the adb runner and
  // the online serial once; a hot decision pushes + broadcasts, a full decision
  // reinstalls. An unavailable device disables the path with a log, never throws.
  let androidApply = null;
  if (android) {
    const adb = android.adb ?? 'adb';
    const run = android.run ?? makeAdbRunner({ adb });
    const serial = android.serial ?? parseOnlineDevices(run(['devices'])?.stdout ?? '')[0] ?? null;
    if (!serial) {
      log('dev: android reload requested but no online device; device push disabled');
      state.android = { enabled: false, reason: 'no-device' };
    } else {
      const apk = android.apk ?? path.join(root, 'opurom-mobile', 'dist', 'opurom-mobile-debug.apk');
      // Serialize the classified IR to a stable file the push reads. The build's
      // temp IR is removed, but dev already holds the parsed nextIr.
      const localIr = path.join(outDir, 'android-reload.opuir.json');
      androidApply = (decision, ir) => {
        try {
          fs.writeFileSync(localIr, JSON.stringify(ir));
        } catch (error) {
          return { action: decision.kind, ok: false, error: `cannot write IR: ${error.message}` };
        }
        return applyDeviceReload({ decision, serial, localIr, apk, run, packageName: android.packageName });
      };
      state.android = { enabled: true, serial, apk };
    }
  }

  const broadcast = (event, data) => {
    if (hub) return hub.broadcast(event, data);
    const frame = sseFrame(event, data);
    for (const res of clients) res.write(frame);
  };

  // Swap the native preview onto the current binary. A hot swap replays the
  // event log so state survives the process restart; a full swap starts fresh.
  const swapNativePreview = async ({ replay }) => {
    await nativePreview.stop();
    nativePreview.start();
    for (const line of replayLines(nativeEventLog)) await nativePreview.command(line);
    setFeedState((await nativePreview.command('state')).state);
    broadcast('state', feedSnapshot());
    return feed.state;
  };
  // The app.js rewrite belongs to the web canvas emitter. The web-dom build is
  // a standalone index.html, so it gets the dev client plus the router state
  // publication instead of an app.js patch.
  const patchOutput = (target) => {
    const index = path.join(outDir, 'index.html');
    if (!fs.existsSync(index)) return; // targets without a served page (native) need no rewrite
    let html = injectDevClient(fs.readFileSync(index, 'utf8'));
    if (target === WEB_DOM_TARGET) html = exposeRouterState(html);
    fs.writeFileSync(index, html);
    if (target !== 'web') return;
    const app = path.join(outDir, 'app.js');
    if (fs.existsSync(app)) fs.writeFileSync(app, patchAppState(fs.readFileSync(app, 'utf8')));
  };

  // Backend: regenerate the service crate from the same source and restart it.
  // shortcut: the service crate is rebuilt in release mode on every change, so a
  // big crate makes the reload slow. Switch to a debug profile when that hurts.
  const backendState = { child: null, bin: null, db: null, port: null, restarts: 0, lastError: null };

  const stopBackend = async () => {
    const child = backendState.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    backendState.child = null;
  };

  const startBackend = async () => {
    try {
      buildFull({ src: srcAbs, out: backendDir, root, quiet: true, log: () => {}, env, environment, buildInfo });
      const db = dbPathFor(backendDir);
      fs.mkdirSync(path.dirname(db), { recursive: true });
      const bin = buildServer({ out: backendDir, root, log: () => {}, env });
      const backendPort = backendState.port ?? await freePortNumber();
      backendState.port = backendPort;
      const child = spawnService(bin, { port: backendPort, db, cwd: backendDir, env });
      backendState.child = child;
      backendState.bin = bin;
      backendState.db = db;
      const base = `http://127.0.0.1:${backendPort}`;
      await waitForHealth(`${base}/health`, { timeoutMs: 30000 });
      state.backend = {
        enabled: true, status: 'running', port: backendPort, restarts: backendState.restarts, lastError: null,
      };
      if (hub) hub.update({ backend: state.backend });
      return true;
    } catch (error) {
      backendState.lastError = error.message;
      state.backend = {
        enabled: true, status: 'failed', port: null, restarts: backendState.restarts, lastError: error.message,
      };
      if (hub) hub.update({ backend: state.backend });
      await stopBackend();
      return false;
    }
  };

  // Read the IR a rebuild left in outDir so the next change can be classified.
  // Multi-target writes it in lowerTargets; single-target writes it in
  // compileIrOnly when reload classification is enabled. Null means unknown.
  const readIr = () => {
    const irFile = path.join(outDir, 'app.opuir.json');
    if (!fs.existsSync(irFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(irFile, 'utf8'));
    } catch {
      return null;
    }
  };

  // One IR per rebuild: compile once, then lower every listed target from that
  // same IR, so the previews show one compiled program instead of per-target
  // recompiles that could drift apart.
  const lowerTargets = (opuromc) => {
    const irFile = path.join(outDir, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile], { env });
    const entries = [];
    for (const target of devTargets) {
      const tOut = path.join(outDir, target);
      fs.mkdirSync(tOut, { recursive: true });
      runOrThrow(opuromc, ['target', irFile, '--target', target, '-o', tOut]);
      const index = path.join(tOut, 'index.html');
      if (fs.existsSync(index)) {
        let html = injectDevClient(fs.readFileSync(index, 'utf8'));
        if (target === WEB_DOM_TARGET) html = exposeRouterState(html);
        fs.writeFileSync(index, html);
      }
      if (target === 'web') {
        const app = path.join(tOut, 'app.js');
        if (fs.existsSync(app)) fs.writeFileSync(app, patchAppState(fs.readFileSync(app, 'utf8')));
      }
      const files = fs.readdirSync(tOut).filter((f) => !f.startsWith('.')).sort();
      entries.push({ target, entry: files.includes('index.html') ? 'index.html' : (files[0] ?? null) });
    }
    fs.writeFileSync(path.join(outDir, 'index.html'), injectDevClient(targetsIndexHtml(entries)));
  };

  // Last good compiled IR for GET /__opurom/ir: a single in-memory document
  // replaced by every successful rebuild, kept across failed builds so the
  // inspector never serves a half-compiled tree.
  const live = { ir: null, at: null };

  // Monotonic host clock (no wall time in machine-readable reload records).
  const nowMs = () => Number(process.hrtime.bigint() / 1000000n);
  let lastBuildTimings = { compileMs: 0, devfsMs: 0 };

  // Failure classes mirror Flutter's retryable reload error vs reload-barred
  // (`run_hot.dart`): a broken source can be fixed and retried, a missing
  // artifact or dead process needs a fresh start of the preview.
  const classifyReloadError = (error) => {
    const message = error instanceof Error ? error.message : String(error);
    const unrecoverable = /invalid IR JSON|missing .*binary|exited \(|not running|ENOENT|EACCES/.test(message);
    return {
      ok: false,
      code: unrecoverable ? 'RELOAD_UNRECOVERABLE' : 'BUILD_ERROR_RETRYABLE',
      retryable: !unrecoverable,
      reason: unrecoverable ? 'restart-required' : 'fix-and-retry',
      message,
    };
  };

  const rebuild = () => {
    let irData = null;
    const t0 = nowMs();
    // Keep the last successfully compiled IR as the authoritative one. Flutter
    // applies a failed DevFS sync to no view (run_hot.dart:985-991), so a failed
    // rebuild must not advance the inspector/session IR or the reload decision.
    const committedIr = live.ir;
    let nextIrData = null;
    if (multi) {
      lowerTargets(compilerPath({ root, log: () => {} }));
      nextIrData = readIr();
      lastBuildTimings = { compileMs: nowMs() - t0, devfsMs: 0 };
    } else {
      const result = build({ src: srcAbs, target: devTargets[0], out: outDir, root, quiet: true, env, environment, buildInfo });
      const t1 = nowMs();
      patchOutput(devTargets[0]);
      lastBuildTimings = { compileMs: t1 - t0, devfsMs: nowMs() - t1 };
      nextIrData = result.irData ?? null;
    }
    irData = nextIrData ?? committedIr;
    if (nextIrData) {
      live.ir = nextIrData;
      live.at = new Date().toISOString();
    }
    state.rebuilds++;
    state.lastBuild = new Date().toISOString();
    state.lastError = null;
    if (hub) {
      hub.update({
        rebuilds: state.rebuilds,
        lastBuild: state.lastBuild,
        lastError: null,
        backend: state.backend,
      });
    }
    // The reload decision stays gated on the reload flag, as before; the IR
    // capture above only feeds GET /__opurom/ir.
    return reload ? irData : null;
  };

  let prevIr;
  try {
    prevIr = rebuild();
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(backendDir, { recursive: true, force: true });
    throw error;
  }
  if (backend) {
    const started = await startBackend();
    if (!started) log(`dev: backend unavailable: ${backendState.lastError}`);
  }
  if (nativePreview) {
    if (!fs.existsSync(nativeBinary)) {
      state.native = { enabled: false, reason: `no native binary at ${nativeBinary} (multi-target dev does not run cargo)` };
      log(`dev: native preview disabled: ${state.native.reason}`);
    } else {
      nativePreview.start();
      try {
        setFeedState((await nativePreview.command('state')).state);
        state.native = { enabled: true, binary: nativeBinary, pid: nativePreview.pid, reloads: 0, lastReload: null };
        broadcast('state', feedSnapshot());
      } catch (error) {
        state.native = { enabled: false, reason: error.message };
        log(`dev: native preview failed to start: ${error.message}`);
      }
    }
  }

  if (kernelSource) {
    try {
      stageKernelIr();
      kernelSource.start();
      await pullKernel();
      state.kernel = { enabled: true, binary: kernel.binary, pid: kernelSource.pid };
    } catch (error) {
      state.kernel = { enabled: false, reason: error.message };
      log(`dev: kernel unavailable: ${error.message}`);
    }
  }

  let pending;
  let reloading = false;

  const onUsr1 = () => { void applyChange({ manual: true, reason: 'signal-SIGUSR1' }); };
  const onUsr2 = () => { void applyChange({ manual: true, restart: true, reason: 'signal-SIGUSR2' }); };

  // One reload path for file changes, HTTP requests and SIGUSR1/2. The IR diff
  // and state channels are unchanged; this only adds manual triggers, phase
  // timings and a stable failure code.
  const applyChange = async ({ manual = false, restart = false, reason = 'source-change' } = {}) => {
    if (reloading) return { ok: false, code: 'RELOAD_IN_PROGRESS' };
    reloading = true;
    try {
        // Classify before rebuilding: the current IR is the "previous" one, the
        // fresh compile after rebuild() is the "next" one.
        const beforeIr = prevIr;
        let nativeBefore = null;
        if (nativePreview) {
          // The preview must release the binary before cargo relinks it, so
          // the live state is captured first and restored after the swap.
          try {
            nativeBefore = (await nativePreview.command('state')).state;
          } catch (error) {
            log(`dev: native state query failed: ${error.message}`);
          }
          await nativePreview.stop();
        }
        const nextIr = rebuild();
        // A leaf-only edit keeps state (hot); a state-schema or shell change
        // needs a full reload. When the emitter exposes no IR file, fall back
        // to a plain full reload.
        const decision = restart
          ? { kind: 'full', reason: 'manual-restart' }
          : (reload && nextIr && beforeIr
            ? decideReload(beforeIr, nextIr)
            : { kind: 'full', reason: 'no-ir' });
        prevIr = nextIr ?? beforeIr;
        // A no-op (comment-only edit) leaves the running app untouched.
        if (decision.kind === 'none') {
          if (nativePreview) {
            // The IR is unchanged, so the swap puts the same binary back; the
            // replay restores the state the stopped process was holding.
            await swapNativePreview({ replay: true });
            log(`dev: no reload for ${path.basename(srcAbs)} (${decision.reason}); native preview restarted`);
          } else {
            log(`dev: no reload for ${path.basename(srcAbs)} (${decision.reason})`);
          }
          return { ok: true, code: 'RELOAD_NOOP', kind: 'none' };
        }
        const vmStart = nowMs();
        // Same IR decision feeds every registered device under one revision,
        // and is pushed as one identical frame to all connected previews.
        const syncPayload = registry.commit(decision);
        broadcast('decision', syncPayload);
        // Native/Android device target: push the hot IR or reinstall on a full
        // change, reusing the same decision. Never blocks a web reload on failure.
        if (androidApply && nextIr && decision.kind !== 'none') {
          const applied = androidApply(decision, nextIr);
          state.android = { ...state.android, last: applied };
          if (!applied.ok) log(`dev: android ${applied.action} failed: ${applied.error}`);
          else log(`dev: android ${applied.action} applied on ${state.android.serial}`);
        }
        // The inspector rings reset on every applied reload; the bumped
        // version is visible on the next pull, and the kernel refills the
        // rings from the fresh answers below.
        // The inspector rings reset on every applied reload; the bumped
        // version makes the gap visible and the baselines go out right away.
        relay.reset();
        broadcast('frame', relay.pullFrames());
        broadcast('memory', relay.pullMemory());
        broadcast('network', relay.pullNetwork());
        if (kernelSource) {
          // The kernel holds one compiled IR per process, so the reload swaps
          // it too; the rings refill from the fresh kernel answers.
          try {
            await restartKernel();
          } catch (error) {
            log(`dev: kernel unavailable after reload: ${error.message}`);
          }
        }
        if (nativePreview) {
          // hot keeps state by replaying the recorded event log against the
          // new binary; full starts fresh because the state schema changed.
          if (decision.kind === 'full') nativeEventLog = [];
          const after = await swapNativePreview({ replay: decision.kind === 'hot' });
          state.native = {
            ...state.native,
            enabled: true,
            pid: nativePreview.pid,
            reloads: (state.native?.reloads ?? 0) + 1,
            lastReload: {
              kind: decision.kind,
              reason: decision.reason,
              preserved: decision.kind === 'hot' ? statePreserved(nativeBefore, after) : null,
              state: after,
            },
          };
          log(`dev: native preview ${decision.kind} (${decision.reason}) preserved=${state.native.lastReload.preserved}`);
        }
        if (backend) {
          await stopBackend();
          backendState.restarts++;
          await startBackend();
        }
        const reassembleStart = nowMs();
        state.reloads++;
        const timings = {
          ...lastBuildTimings,
          vmMs: reassembleStart - vmStart,
          reassembleMs: 0,
        };
        state.lastReload = {
          kind: decision.kind, reason: decision.reason, trigger: reason, timings,
        };
        if (hub) hub.update({ reloads: state.reloads, lastReload: state.lastReload });
        timings.reassembleMs = nowMs() - reassembleStart;
        log(`${formatReload({ kind: decision.kind, reason: decision.reason, reloads: state.reloads, src: srcAbs })} (${clients.size} clients) timings=${JSON.stringify(timings)}`);
        broadcast('reload', {
          at: state.lastBuild, src: srcAbs, kind: decision.kind, reason: decision.reason, trigger: reason, timings,
        });
        return { ok: true, code: 'RELOAD_APPLIED', kind: decision.kind, timings };
      } catch (error) {
        const detail = classifyReloadError(error);
        state.lastError = detail.message;
        state.lastErrorDetail = detail;
        if (hub) hub.update({ lastError: detail.message });
        if (nativePreview) {
          // A failed build leaves the previous binary on disk: keep the
          // preview alive on it instead of dropping the desktop loop.
          try {
            await swapNativePreview({ replay: nativeEventLog.length > 0 });
            log(`dev: build failed [${detail.code}]: ${detail.message}; native preview kept on the previous binary`);
          } catch (swapError) {
            log(`dev: build failed [${detail.code}]: ${detail.message}; native preview stopped: ${swapError.message}`);
          }
        } else {
          log(`dev: build failed [${detail.code}]: ${detail.message}`);
        }
        broadcast('build-error', detail);
        return detail;
    } finally {
      reloading = false;
    }
  };

  const watcher = fs.watch(path.dirname(srcAbs), (event, filename) => {
    if (filename && path.basename(String(filename)) !== path.basename(srcAbs)) return;
    clearTimeout(pending);
    pending = setTimeout(() => { void applyChange({ reason: 'source-change' }); }, 120);
  });
  watcher.on('error', (error) => log(`dev: watcher error: ${error.message}`));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (handleDeviceRequest(registry, req, res, url)) return;
    if (url.pathname === '/health') {
      if (hub) {
        const snapshot = hub.snapshot();
        state.sync = {
          enabled: true,
          mode: 'dev-preview',
          host: syncHost,
          urls: lanUrls(state.port),
          clients: clients.size,
          reloads: snapshot.reloads ?? 0,
          lastReload: snapshot.lastReload ?? null,
        };
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ...state, clients: clients.size, devices: registry.size, revision: registry.revision }));
      return;
    }
    // DevTools session discovery (Flutter daemon devtools.serve parity):
    // the three URLs point at the live dev server; the DAP adapter path is
    // reported when the sibling repo is present, never guessed as running.
    if (url.pathname === '/api/devtools/exit') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      // Flutter authority: foundation/service_extensions.dart:30-37 and
      // foundation/binding.dart:1008-1010 register `ext.flutter.exit` to
      // terminate the application with exit code 0.
      devLog.info('session exit requested via /api/devtools/exit');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, exitCode: 0 }));
      void close();
      return;
    }
    if (url.pathname === '/api/logs') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      const format = url.searchParams.get('format') ?? 'json';
      if (!['json', 'ndjson', 'text'].includes(format)) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'invalid format (expected json, ndjson, text)' }));
        return;
      }
      let minLevel;
      try {
        minLevel = parseLogLevel(url.searchParams.get('level') ?? undefined);
      } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
        return;
      }
      const rows = logRing.query({
        level: minLevel,
        source: url.searchParams.get('source') ?? undefined,
        q: url.searchParams.get('q') ?? '',
        since: url.searchParams.get('since') ?? 0,
        limit: url.searchParams.get('limit') ?? undefined,
      });
      const contentType = format === 'text' ? 'text/plain; charset=utf-8'
        : format === 'ndjson' ? 'application/x-ndjson; charset=utf-8'
          : 'application/json; charset=utf-8';
      const body = format === 'json'
        ? `${JSON.stringify({ schema: 'opurom.dev-log/v1', count: rows.length, errorCount: logRing.errorCount, rows }, null, 2)}\n`
        : `${rows.map((row) => format === 'text' ? `[${row.level.toUpperCase()}] ${row.source}: ${row.message}` : JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`;
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/devtools/session') {
      const debugAdapter = path.join(workspaceRoot(), 'opurom-debug', 'bin', 'server.mjs');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        service: 'opurom-devtools',
        host: '127.0.0.1',
        port: state.port,
        uri: base,
        devtoolsUri: `${base}/inspector`,
        irUri: `${base}/__opurom/ir`,
        framesUri: `${base}/api/inspect/frames`,
        memoryUri: `${base}/api/inspect/memory`,
        networkUri: `${base}/api/inspect/network`,
        eventsUri: `${base}/__opurom/events`,
        logsUri: `${base}/api/logs`,
        exitUri: `${base}/api/devtools/exit`,
        debugAdapter: fs.existsSync(debugAdapter) ? debugAdapter : null,
        inspectorAvailable: inspectorBundle && fs.existsSync(path.join(inspectorBundle, 'index.html')),
        environment: environment?.name ?? null,
        mode: buildInfo?.mode ?? null,
      }));
      return;
    }
    if (url.pathname === '/__opurom/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write('retry: 2000\n\n');
      if (hub) {
        hub.add(res);
        try {
          res.write(sseFrame('ready', { src: srcAbs, clients: clients.size, sync: true }));
        } catch {
          hub.remove(res);
        }
      } else {
        res.write(sseFrame('ready', { src: srcAbs, clients: clients.size + 1 }));
        clients.add(res);
      }
      req.on('close', () => {
        if (hub) hub.remove(res);
        else clients.delete(res);
      });
      return;
    }
    if (url.pathname === '/__opurom/state') {
      if (req.method === 'POST') {
        readJsonBody(req).then((raw) => {
          let payload;
          try {
            payload = JSON.parse(raw);
          } catch {
            throw new Error('body is not JSON');
          }
          if (payload === null || typeof payload !== 'object') throw new Error('body must be a JSON object');
          const stateChanged = payload.state !== undefined;
          if (stateChanged) setFeedState(payload.state);
          let added = 0;
          for (const item of Array.isArray(payload.events) ? payload.events : []) {
            if (recordFeedEvent(item)) added++;
          }
          if (stateChanged || added) broadcast('state', feedSnapshot());
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, eventCount: feed.seq }));
        }).catch((error) => {
          const status = error.message === 'payload too large' ? 413 : 400;
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: error.message }));
        });
        return;
      }
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(feedSnapshot()));
      return;
    }
    if (url.pathname === '/__opurom/ir') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      if (!live.ir) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'no compiled IR yet', reason: 'no-compile-yet' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, at: live.at, rebuilds: state.rebuilds, ir: live.ir }));
      return;
    }
    if (url.pathname === '/__opurom/frames') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      readJsonBody(req).then(async (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error('body is not JSON');
        }
        if (payload === null || typeof payload !== 'object') throw new Error('body must be a JSON object');
        if (hostFrameBudget && kernelSource?.running) {
          for (const sample of Array.isArray(payload.frames) ? payload.frames : []) {
            const frameMs = Number(sample?.frameMs);
            if (!Number.isFinite(frameMs) || frameMs < 0) continue;
            await kernelSource.recordFrame({
              startMs: hostClockMs(),
              frameMs: Math.max(0, Math.round(frameMs)),
              budgetMs: hostFrameBudget.budgetMs,
              nodes: Number.isInteger(sample?.nodes) ? sample.nodes : 0,
              effects: Number.isInteger(sample?.effects) ? sample.effects : 0,
              report: hostFrameBudget.report(),
            });
          }
          await pullKernel();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, availability: 'full' }));
          return;
        }
        const availability = relay.addFrames(payload.frames);
        broadcast('frame', relay.pullFrames());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, availability: availability.availability }));
      }).catch((error) => {
        const status = error.message === 'payload too large' ? 413 : 400;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      });
      return;
    }
    if (url.pathname === '/api/inspect/frames' || url.pathname === '/api/inspect/memory' || url.pathname === '/api/inspect/network') {
      if (req.method !== 'GET') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      const since = Number(url.searchParams.get('since') ?? 0);
      const kind = url.pathname.split('/').pop();
      const view = kind === 'frames' ? relay.pullFrames({ since })
        : kind === 'memory' ? relay.pullMemory()
          : relay.pullNetwork();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(view));
      return;
    }
    if (url.pathname === '/inspector' || url.pathname.startsWith('/inspector/')) {
      const bundle = inspectorBundle;
      const rel = url.pathname === '/inspector' ? 'index.html' : url.pathname.slice('/inspector/'.length);
      const file = resolveStatic(bundle, `/${rel}`);
      if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'inspector bundle missing (build it with "opurom-web inspector")' }));
        return;
      }
      res.writeHead(200, { 'content-type': mimeType(file) });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (url.pathname === '/__opurom/native') {
      if (!nativePreview) {
        res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'no native preview (start dev with --targets native)' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      readJsonBody(req).then(async (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new Error('body is not JSON');
        }
        const line = eventLine(payload);
        if (line === null) {
          throw new Error('op must be tap|doubleTap|longPress|drag or input, with an integer node id');
        }
        const { state } = await nativePreview.command(line);
        nativeEventLog.push(payload);
        setFeedState(state);
        recordFeedEvent({ type: payload.op, nodeId: Number(payload.id) });
        broadcast('state', feedSnapshot());
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, state }));
      }).catch((error) => {
        const status = error.message.startsWith('op must be') || error.message === 'body is not JSON' ? 400 : 502;
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: error.message }));
      });
      return;
    }
    if (url.pathname === '/__opurom/reload') {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed\n');
        return;
      }
      readJsonBody(req).then(async (raw) => {
        let payload = {};
        if (raw.trim() !== '') {
          try {
            payload = JSON.parse(raw);
          } catch {
            throw new Error('body is not JSON');
          }
        }
        if (payload === null || typeof payload !== 'object') throw new Error('body must be a JSON object');
        const restart = payload.kind === 'restart';
        const result = await applyChange({
          manual: true, restart,
          reason: String(payload.reason ?? (restart ? 'manual-restart' : 'manual-reload')),
        });
        const status = result.ok ? 200 : (result.code === 'RELOAD_IN_PROGRESS' ? 409 : 500);
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(result));
      }).catch((error) => {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: 'RELOAD_BAD_REQUEST', message: error.message }));
      });
      return;
    }
    const file = resolveStatic(outDir, url.pathname);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found\n');
      return;
    }
    res.writeHead(200, { 'content-type': mimeType(file) });
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, syncHost, () => resolve());
  });
  state.port = server.address().port;
  if (hub) hub.update({ port: state.port, urls: lanUrls(state.port) });
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        clients.delete(res);
      }
    }
  }, 15000);

  const close = () => new Promise((resolve) => {
    clearTimeout(pending);
    clearInterval(heartbeat);
    watcher.close();
    process.removeListener('SIGUSR1', onUsr1);
    process.removeListener('SIGUSR2', onUsr2);
    for (const res of clients) res.end();
    clients.clear();
    const previewClosed = nativePreview ? nativePreview.stop() : Promise.resolve();
    const kernelClosed = kernelSource ? kernelSource.stop() : Promise.resolve();
    Promise.all([stopBackend(), previewClosed, kernelClosed]).then(() => {
      server.close(() => {
        fs.rmSync(outDir, { recursive: true, force: true });
        fs.rmSync(backendDir, { recursive: true, force: true });
        resolve();
      });
    });
  });
  if (signals) {
    const onSignal = () => close().then(() => process.exit(0));
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    // SIGUSR1/SIGUSR2 drive the same reload path the HTTP endpoint uses, so a
    // shell or CI job can reload without a file change (Flutter parity).
    process.on('SIGUSR1', onUsr1);
    process.on('SIGUSR2', onUsr2);
  }

  const base = `http://127.0.0.1:${state.port}`;
  log(`dev server: ${base}/  (watching ${srcAbs})`);
  log(`  health: curl -s ${base}/health`);
  log(`  events: curl -N ${base}/__opurom/events`);
  log(`  state:  curl -s ${base}/__opurom/state  (or: opurom inspect --dev ${base})`);
  log(`  devtools: curl -s ${base}/api/devtools/session`);
  log(`  logs:     curl -s '${base}/api/logs?level=warn&q=reload&format=text'`);
  log(`  reload: curl -s -X POST ${base}/__opurom/reload -d '{"kind":"reload|restart"}'  (or kill -USR1 <pid> / -USR2 <pid>)`);
  if (state.native?.enabled) {
    log(`  native: preview pid ${state.native.pid} - POST /__opurom/native {"op":"tap","id":4} drives the state machine`);
  }
  log(`  ir:     curl -s ${base}/__opurom/ir  (or: opurom inspect --dev ${base} --tree)`);
  log(`  html:   curl -s ${base}/index.html | grep __opurom/events`);
  log(`  devices: GET ${base}/devices | POST /devices (id,target) | GET /reload?since=N`);
  if (backend) {
    log(`  backend: ${state.backend.status}${state.backend.port ? ` at http://127.0.0.1:${state.backend.port}` : ''}`);
  }
  if (multi) {
    log(`  targets: ${devTargets.join(', ')} lowered from one IR; the index page lists them`);
  }
  if (devTargets.includes(WEB_DOM_TARGET)) {
    log(`  ${WEB_DOM_TARGET}: SSE hot reload; state snapshot restored in the responsive DOM page`);
  }
  if (sync) {
    log('  sync: dev preview hub for N browser clients; NOT a device-conformance or multi-OS claim');
    log('  sync: no TLS/auth; use a trusted local network only');
    for (const url of lanUrls(state.port)) log(`  sync: ${url}`);
    log('  sync: new clients receive event: snapshot; source changes broadcast the same reload frame');
  }
  return { server, outDir, state, close, broadcast, hub, sync, registry };
}
