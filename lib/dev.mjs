import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CLI_ROOT, workspaceRoot } from './paths.mjs';
import { build } from './build.mjs';

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

export async function dev({ src, port = 5178, root = workspaceRoot(), log = console.log, signals = true } = {}) {
  const srcAbs = path.resolve(src);
  if (!fs.existsSync(srcAbs)) throw new Error(`source not found: ${srcAbs}`);
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const outDir = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'dev-'));
  const clients = new Set();
  const state = { service: 'opurom-dev', ok: true, src: srcAbs, port, rebuilds: 0, lastBuild: null, lastError: null };

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
    throw error;
  }
  let pending;
  const watcher = fs.watch(path.dirname(srcAbs), (event, filename) => {
    if (filename && path.basename(String(filename)) !== path.basename(srcAbs)) return;
    clearTimeout(pending);
    pending = setTimeout(() => {
      try {
        rebuild();
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
    server.close(() => {
      fs.rmSync(outDir, { recursive: true, force: true });
      resolve();
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
  return { server, outDir, state, close, broadcast };
}
