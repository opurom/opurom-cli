#!/usr/bin/env node
// Standalone loopback sync hub for `dev --sync --clients N`; no Rust server.
import { parseArgs } from '../lib/args.mjs';
import { DEFAULT_SYNC_PORT, SYNC_PATH, parseClientCount, startLoopbackHub } from '../lib/r8.mjs';

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const port = Number(flags.port ?? process.env.OPR_SYNC_PORT ?? DEFAULT_SYNC_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port: ${String(flags.port ?? process.env.OPR_SYNC_PORT)} (expected 0..65535)`);
  }
  const expectedClients = flags.clients === undefined ? null : parseClientCount(flags.clients);
  const hub = await startLoopbackHub({ port, expectedClients, log: (line) => console.log(line) });
  console.log(`loopback sync hub: ws://127.0.0.1:${hub.port}${SYNC_PATH}`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    hub.close().then(() => { process.exitCode = 0; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
