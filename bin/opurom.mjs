#!/usr/bin/env node
import path from 'node:path';
import { flagEnabled, parseArgs, parsePort, requireFlags } from '../lib/args.mjs';
import { build, buildFull, buildWasm, check, migrate } from '../lib/build.mjs';
import { dev } from '../lib/dev.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { init } from '../lib/init.mjs';
import { specFile } from '../lib/paths.mjs';
import { targetsFromSpec, validateBuildTarget } from '../lib/targets.mjs';
import { runE2e } from '../lib/e2e.mjs';
import { serve } from '../lib/serve.mjs';
import { bench } from '../lib/bench.mjs';
import { inspect, profile } from '../lib/async_runtime.mjs';
import { sizeReport } from '../lib/minify.mjs';
import { compareBackends, profileRepeat } from '../lib/profile.mjs';
import { DEFAULT_SYNC_PORT, verifySync } from '../lib/sync.mjs';

const USAGE = `opurom — OPUROM toolchain CLI (zero npm dependencies)

Usage: node bin/opurom.mjs <command> [options]

Commands:
  doctor                          check rustc/cargo/node/opuromc/render
  targets                         list the IR emitters
  init <dir>                      scaffold a new project
  check <src.opu>                 type-check a source file
  build --src <src.opu> --target <name> --out <dir> [--optimize] [--minify] [--tree-shake] [--sourcemap]
                                  compile IR and lower to a target
                                  (name: emitter, "full" or "wasm")
  build --src <src.opu> --target full --out <dir>
                                  frontend + service crate + migrations + shared types
  size <dir>                      measured before/after byte table of a build
  serve --out <dir> [--port N]    run the generated service (OPR_PORT/OPR_DB)
  migrate --src <src.opu> --out <dir>
                                  generate SQL migrations from the IR models
  dev --src <src.opu> [--port N] [--sync]
                                  serve web target with SSE hot reload (+ backend restart)
  dev --sync [--clients N] [--port N]
                                  verify N loopback WebSocket clients against a running sync hub
  bench --src <src.opu> [--out <dir>] [--full]
                                  measured compile/build times and artifact sizes
  bench --src <src.opu> --compare
                                  measured software vs GPU backend times + byte equality
  profile --src <src.opu> [--frames N]
                                  measured software-raster frame timings (1..600)
  profile --src <src.opu> --repeat N
                                  measured repeated runs, warmup excluded and reported (1..600)
  inspect <ir.json>               read-only layer + a11y trees side by side
  test                            end-to-end golden pipeline checks

Run "node bin/opurom.mjs <command> --help" for the same summary.`;

async function main(argv) {
  const { flags, positionals } = parseArgs(argv);
  const command = positionals[0];
  if (!command || flags.help || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case 'doctor':
      return runDoctor();
    case 'targets':
      for (const name of targetsFromSpec(specFile('IR_SCHEMA.md'))) console.log(name);
      return 0;
    case 'init': {
      if (!positionals[1]) throw new Error('usage: init <dir>');
      const dir = init(positionals[1]);
      console.log(`init ok: ${dir} (edit ${path.join(dir, 'src', 'main.opu')})`);
      return 0;
    }
    case 'check': {
      const src = positionals[1] ?? flags.src;
      if (!src) throw new Error('usage: check <src.opu>');
      check(src);
      console.log(`check ok: ${path.resolve(src)}`);
      return 0;
    }
    case 'build': {
      const { src, target, out } = requireFlags(flags, ['src', 'target', 'out']);
      validateBuildTarget(target);
      const optimize = flagEnabled(flags, 'optimize');
      const minify = flagEnabled(flags, 'minify');
      const treeShake = flagEnabled(flags, 'tree-shake');
      const sourcemap = flagEnabled(flags, 'sourcemap');
      if (target === 'full') {
        buildFull({ src, out, optimize, minify, treeShake, sourcemap });
        return 0;
      }
      if (target === 'wasm') {
        buildWasm({ src, out, optimize, minify, treeShake, sourcemap });
        return 0;
      }
      build({ src, target, out, optimize, minify, treeShake, sourcemap });
      return 0;
    }
    case 'size': {
      const dir = positionals[1] ?? (typeof flags.out === 'string' ? flags.out : null);
      if (!dir) throw new Error('usage: size <dir>');
      sizeReport({ dir });
      return 0;
    }
    case 'serve': {
      const { out } = requireFlags(flags, ['out']);
      const port = parsePort(flags.port, 8787);
      await serve({ out, port });
      return 0; // the service keeps the process alive
    }
    case 'migrate': {
      const { src, out } = requireFlags(flags, ['src', 'out']);
      migrate({ src, out });
      return 0;
    }
    case 'dev': {
      const sync = flagEnabled(flags, 'sync');
      if (flags.clients !== undefined && !sync) throw new Error('usage: --clients requires --sync');
      const port = parsePort(flags.port ?? process.env.OPR_SYNC_PORT, DEFAULT_SYNC_PORT);
      const hasSource = flags.src !== undefined && flags.src !== true && flags.src !== '';
      if (sync && flags.clients === undefined && flags.src !== undefined) {
        requireFlags(flags, ['src']);
      }
      if (sync && (flags.clients !== undefined || !hasSource)) {
        return (await verifySync({ port, clients: flags.clients })).code;
      }
      const { src } = requireFlags(flags, ['src']);
      await dev({ src, port, sync });
      return 0; // the HTTP server keeps the process alive
    }
    case 'bench': {
      const { src } = requireFlags(flags, ['src']);
      if (flagEnabled(flags, 'compare')) {
        return compareBackends({ src });
      }
      const out = typeof flags.out === 'string' ? flags.out : path.join('tmp', 'bench');
      await bench({ src, out, full: flagEnabled(flags, 'full') });
      return 0;
    }
    case 'profile': {
      const { src } = requireFlags(flags, ['src']);
      if (flags.repeat !== undefined) {
        return profileRepeat({ src, repeat: flags.repeat });
      }
      return profile({ src, frames: flags.frames });
    }
    case 'inspect': {
      const ir = positionals[1];
      if (!ir) throw new Error('usage: inspect <ir.json>');
      return inspect({ ir });
    }
    case 'test':
      console.log('OPUROM end-to-end tests');
      return (await runE2e()).exitCode;
    default:
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (error) => {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  },
);
