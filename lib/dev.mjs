import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CLI_ROOT, workspaceRoot } from './paths.mjs';
import { build, buildFull, compilerPath } from './build.mjs';
import { buildServer, dbPathFor, spawnService, waitForHealth } from './service.mjs';
import { runOrThrow } from './proc.mjs';
import { TARGETS } from './targets.mjs';

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
  window.__OPUROM_STATE_RESTORE__ = snapshot;
  if (snapshot != null) {
    if (window.opurom.state == null) window.opurom.state = snapshot;
    if (window.opuromState == null) window.opuromState = snapshot;
  }
  var es = new EventSource('/__opurom/events');
  es.addEventListener('snapshot', function (event) {
    try {
      var shared = JSON.parse(event.data);
      window.opurom.syncSnapshot = shared;
      window.__OPUROM_SYNC_SNAPSHOT__ = shared;
    } catch (e) {}
  });
  es.addEventListener('reload', function () {
    var state = (window.opurom && window.opurom.state) || window.opuromState || window.state || snapshot;
    try { sessionStorage.setItem(KEY, JSON.stringify(state == null ? null : state)); } catch (e) {}
    location.reload();
  });
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

// shortcut: v0.1 web emitter keeps `const state` in its own script scope; dev-only
// rewrite merges the snapshot and exposes state for the next reload. Update when
// an emitter changes its state declaration.
export function patchAppState(js) {
  if (js.includes('__opurom_state_exposed__')) return js;
  const merged = js.replace(
    /^(\s*(?:const|let|var)\s+state\s*=\s*)(\{[^\n]*\})(\s*;)/m,
    '$1Object.assign($2, window.__OPUROM_STATE_RESTORE__ || {})$3',
  );
  return `${merged}\n// __opurom_state_exposed__\nwindow.opurom = window.opurom || {};\nwindow.opurom.state = typeof state !== "undefined" ? state : window.opurom.state;\n`;
}

export function sseFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
export function parseDevTargets(value) {
  const raw = value === undefined || value === true ? 'web' : String(value);
  const list = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    if (!TARGETS.includes(name)) {
      throw new Error(`invalid --targets: ${name} (expected one of ${TARGETS.join(', ')})`);
    }
    if (!list.includes(name)) list.push(name);
  }
  return list.length ? list : ['web'];
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
  src, port = 5178, root = workspaceRoot(), log = console.log, signals = true, backend = true, sync = false, targets = ['web'],
} = {}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
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
    rebuilds: 0,
    lastBuild: null,
    lastError: null,
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

  const broadcast = (event, data) => {
    if (hub) return hub.broadcast(event, data);
    const frame = sseFrame(event, data);
    for (const res of clients) res.write(frame);
  };
  const patchOutput = () => {
    const index = path.join(outDir, 'index.html');
    fs.writeFileSync(index, injectDevClient(fs.readFileSync(index, 'utf8')));
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
      buildFull({ src: srcAbs, out: backendDir, root, quiet: true, log: () => {} });
      const db = dbPathFor(backendDir);
      fs.mkdirSync(path.dirname(db), { recursive: true });
      const bin = buildServer({ out: backendDir, root, log: () => {} });
      const backendPort = backendState.port ?? await freePortNumber();
      backendState.port = backendPort;
      const child = spawnService(bin, { port: backendPort, db, cwd: backendDir });
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

  // One IR per rebuild: compile once, then lower every listed target from that
  // same IR, so the previews show one compiled program instead of per-target
  // recompiles that could drift apart.
  const lowerTargets = (opuromc) => {
    const irFile = path.join(outDir, 'app.opuir.json');
    runOrThrow(opuromc, ['compile', srcAbs, '-o', irFile]);
    const entries = [];
    for (const target of devTargets) {
      const tOut = path.join(outDir, target);
      fs.mkdirSync(tOut, { recursive: true });
      runOrThrow(opuromc, ['target', irFile, '--target', target, '-o', tOut]);
      const index = path.join(tOut, 'index.html');
      if (fs.existsSync(index)) {
        fs.writeFileSync(index, injectDevClient(fs.readFileSync(index, 'utf8')));
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

  const rebuild = () => {
    if (multi) {
      lowerTargets(compilerPath({ root, log: () => {} }));
    } else {
      build({ src: srcAbs, target: devTargets[0], out: outDir, root, quiet: true });
      patchOutput();
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
  };

  try {
    rebuild();
  } catch (error) {
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.rmSync(backendDir, { recursive: true, force: true });
    throw error;
  }
  if (backend) {
    const started = await startBackend();
    if (!started) log(`dev: backend unavailable: ${backendState.lastError}`);
  }

  let pending;
  const watcher = fs.watch(path.dirname(srcAbs), (event, filename) => {
    if (filename && path.basename(String(filename)) !== path.basename(srcAbs)) return;
    clearTimeout(pending);
    pending = setTimeout(async () => {
      try {
        rebuild();
        if (backend) {
          await stopBackend();
          backendState.restarts++;
          await startBackend();
        }
        log(`dev: rebuilt ${path.basename(srcAbs)} -> reload (${clients.size} clients)`);
        broadcast('reload', { at: state.lastBuild, src: srcAbs });
      } catch (error) {
        state.lastError = error.message;
        if (hub) hub.update({ lastError: error.message });
        log(`dev: build failed: ${error.message}`);
        broadcast('build-error', { message: error.message });
      }
    }, 120);
  });
  watcher.on('error', (error) => log(`dev: watcher error: ${error.message}`));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
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
      res.end(JSON.stringify({ ...state, clients: clients.size }));
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
    for (const res of clients) res.end();
    clients.clear();
    stopBackend().then(() => {
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
  }

  const base = `http://127.0.0.1:${state.port}`;
  log(`dev server: ${base}/  (watching ${srcAbs})`);
  log(`  health: curl -s ${base}/health`);
  log(`  events: curl -N ${base}/__opurom/events`);
  log(`  html:   curl -s ${base}/index.html | grep __opurom/events`);
  if (backend) {
    log(`  backend: ${state.backend.status}${state.backend.port ? ` at http://127.0.0.1:${state.backend.port}` : ''}`);
  }
  if (multi) {
    log(`  targets: ${devTargets.join(', ')} lowered from one IR; the index page lists them`);
  }
  if (sync) {
    log('  sync: dev preview hub for N browser clients; NOT a device-conformance or multi-OS claim');
    log('  sync: no TLS/auth; use a trusted local network only');
    for (const url of lanUrls(state.port)) log(`  sync: ${url}`);
    log('  sync: new clients receive event: snapshot; source changes broadcast the same reload frame');
  }
  return { server, outDir, state, close, broadcast, hub, sync };
}
