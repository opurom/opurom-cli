import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { CLI_ROOT, findInPath } from './paths.mjs';
import { run, runOrThrow } from './proc.mjs';

export const DEFAULT_SERVICE_PORT = 8787;
export const DEFAULT_DEV_PORT = 5178;

// The generated service reads OPR_PORT and OPR_DB; nothing else is invented.
export function serviceEnv({ port, db, base = process.env } = {}) {
  const env = { ...base };
  if (port !== undefined && port !== null) env.OPR_PORT = String(port);
  if (db !== undefined && db !== null) env.OPR_DB = String(db);
  return env;
}

export function dbPathFor(out, name = 'opurom.db') {
  return path.join(path.resolve(out), 'data', name);
}

export function serverManifest(out) {
  return path.join(path.resolve(out), 'server', 'Cargo.toml');
}

export function serverCrateDir(out) {
  return path.join(path.resolve(out), 'server');
}

export function targetDir(out) {
  return path.join(path.resolve(out), 'target');
}

export function serviceBinary(out, { release = true } = {}) {
  const profile = release ? 'release' : 'debug';
  const dir = path.join(targetDir(out), profile);
  const name = binaryName(serverManifest(out)) ?? 'opurom-service';
  const exact = path.join(dir, name);
  if (fs.existsSync(exact)) return exact;
  let entries = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const match = entries.find((entry) => !path.extname(entry) && fs.statSync(path.join(dir, entry)).isFile());
  return match ? path.join(dir, match) : null;
}

export function binaryName(manifest) {
  if (!fs.existsSync(manifest)) return null;
  const text = fs.readFileSync(manifest, 'utf8');
  return /\[\[bin\]\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(text)?.[1]
    ?? /\[package\][\s\S]*?name\s*=\s*"([^"]+)"/.exec(text)?.[1]
    ?? null;
}

export function buildServer({ out, root, cargo = findInPath('cargo'), log = console.log, offline = false } = {}) {
  if (!cargo) throw new Error('cargo not found: install Rust via https://rustup.rs');
  const manifest = serverManifest(out);
  if (!fs.existsSync(manifest)) {
    throw new Error(`no generated server crate at ${path.dirname(manifest)}; run "opurom build --target full" first`);
  }
  log(`building generated service (cargo build --release) ...`);
  const args = ['build', '--release', '--manifest-path', manifest];
  const options = {
    cwd: serverCrateDir(out),
    env: { ...process.env, CARGO_TARGET_DIR: targetDir(out) },
  };
  if (offline) {
    try {
      runOrThrow(cargo, args, {
        ...options,
        env: { ...options.env, CARGO_NET_OFFLINE: 'true' },
      });
    } catch (error) {
      if (!/offline|no matching package|unable to update registry|failed to load source|failed to get/i.test(error.message)) {
        throw error;
      }
      runOrThrow(cargo, args, options);
    }
  } else {
    runOrThrow(cargo, args, options);
  }
  const bin = serviceBinary(out);
  if (!bin) throw new Error(`cargo build produced no service binary in ${targetDir(out)}/release`);
  return bin;
}

export async function waitForHealth(url, { timeoutMs = 30000, intervalMs = 150, fetchImpl = fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url);
      const text = await response.text();
      if (response.ok) return { ok: true, status: response.status, body: text };
      lastError = `status ${response.status}: ${text.slice(0, 200)}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`service did not become healthy within ${timeoutMs}ms (${lastError})`);
}

export function spawnService(bin, { port, db, cwd, env = process.env } = {}) {
  const child = spawn(bin, [], {
    cwd,
    env: serviceEnv({ port, db, base: env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

export async function startService({ out, port = DEFAULT_SERVICE_PORT, root, log = console.log, wait = true, offline = false }) {
  const db = dbPathFor(out);
  fs.mkdirSync(path.dirname(db), { recursive: true });
  let bin = serviceBinary(out);
  if (!bin) bin = buildServer({ out, root, log, offline });
  const child = spawnService(bin, { port, db, cwd: path.resolve(out) });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  if (wait) {
    const base = `http://127.0.0.1:${port}`;
    try {
      await waitForHealth(`${base}/health`);
    } catch (error) {
      child.kill('SIGTERM');
      throw new Error(`${error.message}\n--- service output ---\n${output.slice(-800)}`);
    }
  }
  return {
    child,
    bin,
    db,
    port,
    base: `http://127.0.0.1:${port}`,
    output: () => output,
    exited,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
        await exited;
        clearTimeout(timer);
      }
      return child.exitCode;
    },
  };
}

export function freePort() {
  // A closed listener on port 0 yields a free port number without extra deps.
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
