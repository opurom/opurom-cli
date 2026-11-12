import fs from 'node:fs';
import path from 'node:path';
import { buildServer, dbPathFor, serviceBinary, spawnService, waitForHealth } from './service.mjs';
import { DEFAULT_SERVICE_PORT } from './service.mjs';

export function serveUrl(port) {
  return `http://127.0.0.1:${port}`;
}

export async function serve({ out, port = DEFAULT_SERVICE_PORT, root, log = console.log, signals = true, waitMs = 30000 } = {}) {
  const outAbs = path.resolve(out);
  if (!fs.existsSync(path.join(outAbs, 'server', 'Cargo.toml'))) {
    throw new Error(`no generated service in ${outAbs}; run "opurom build --target full --src <file.opu> --out ${outAbs}" first`);
  }
  const db = dbPathFor(outAbs);
  fs.mkdirSync(path.dirname(db), { recursive: true });

  let bin = serviceBinary(outAbs);
  if (!bin) bin = buildServer({ out: outAbs, root, log });

  const child = spawnService(bin, { port, db, cwd: outAbs });
  let output = '';
  const forward = (chunk) => {
    output += chunk;
    log(chunk.toString().trimEnd());
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  const base = serveUrl(port);
  try {
    await waitForHealth(`${base}/health`, { timeoutMs: waitMs });
  } catch (error) {
    child.kill('SIGTERM');
    throw error;
  }

  log(`service ready: ${base}`);
  log(`  health: curl -s ${base}/health`);
  log(`  db:     ${db}`);
  log('press Ctrl+C to stop');

  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
      return;
    }
    child.once('exit', (code) => resolve(code));
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 3000).unref();
  });
  if (signals) {
    const onSignal = () => stop().then(() => process.exit(0));
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  return { child, bin, db, port, base, stop, output: () => output };
}
