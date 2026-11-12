import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { CLI_ROOT, workspaceRoot } from './paths.mjs';
import { build, buildFull } from './build.mjs';
import { buildServer, dbPathFor, spawnService, waitForHealth } from './service.mjs';

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
  src, port = 5178, root = workspaceRoot(), log = console.log, signals = true, backend = true,
} = {}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const outDir = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'dev-'));
  const backendDir = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'dev-backend-'));
  const clients = new Set();
  const state = {
    service: 'opurom-dev',
    ok: true,
    src: srcAbs,
    port,
    rebuilds: 0,
    lastBuild: null,
    lastError: null,
    backend: { enabled: backend, status: 'off', port: null, restarts: 0, lastError: null },
  };

  const broadcast = (event, data) => {
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
      return true;
    } catch (error) {
      backendState.lastError = error.message;
      state.backend = {
        enabled: true, status: 'failed', port: null, restarts: backendState.restarts, lastError: error.message,
      };
      await stopBackend();
      return false;
    }
  };

  const rebuild = () => {
    build({ src: srcAbs, target: 'web', out: outDir, root, quiet: true });
    patchOutput();
    state.rebuilds++;
    state.lastBuild = new Date().toISOString();
    state.lastError = null;
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
        log(`dev: build failed: ${error.message}`);
        broadcast('build-error', { message: error.message });
      }
    }, 120);
  });
  watcher.on('error', (error) => log(`dev: watcher error: ${error.message}`));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
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
      res.write(sseFrame('ready', { src: srcAbs, clients: clients.size + 1 }));
      clients.add(res);
      req.on('close', () => clients.delete(res));
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
    server.listen(port, '127.0.0.1', () => resolve());
  });
  state.port = server.address().port;
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
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
  return { server, outDir, state, close, broadcast };
}
