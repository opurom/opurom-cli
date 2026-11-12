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

const USAGE = `opurom — OPUROM toolchain CLI (zero npm dependencies)

Usage: node bin/opurom.mjs <command> [options]

Commands:
  doctor                          check rustc/cargo/node/opuromc/render
  targets                         list the IR emitters
  init <dir>                      scaffold a new project
  check <src.opu>                 type-check a source file
  build --src <src.opu> --target <name> --out <dir> [--optimize]
                                  compile IR and lower to a target
                                  (name: emitter, "full" or "wasm")
  build --src <src.opu> --target full --out <dir>
                                  frontend + service crate + migrations + shared types
  serve --out <dir> [--port N]    run the generated service (OPR_PORT/OPR_DB)
  migrate --src <src.opu> --out <dir>
                                  generate SQL migrations from the IR models
  dev --src <src.opu> [--port N] [--sync]
                                  serve web target with SSE hot reload (+ backend restart)
  bench --src <src.opu> [--out <dir>] [--full]
                                  measured compile/build times and artifact sizes
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
      if (target === 'full') {
        buildFull({ src, out, optimize });
        return 0;
      }
      if (target === 'wasm') {
        buildWasm({ src, out, optimize });
        return 0;
      }
      build({ src, target, out, optimize });
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
      const { src } = requireFlags(flags, ['src']);
      const port = parsePort(flags.port);
      await dev({ src, port, sync: flagEnabled(flags, 'sync') });
      return 0; // the HTTP server keeps the process alive
    }
    case 'bench': {
      const { src } = requireFlags(flags, ['src']);
      const out = typeof flags.out === 'string' ? flags.out : path.join('tmp', 'bench');
      await bench({ src, out, full: flagEnabled(flags, 'full') });
      return 0;
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
