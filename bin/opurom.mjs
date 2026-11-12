#!/usr/bin/env node
import path from 'node:path';
import { parseArgs, parsePort, requireFlags } from '../lib/args.mjs';
import { build, check } from '../lib/build.mjs';
import { dev } from '../lib/dev.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { init } from '../lib/init.mjs';
import { specFile } from '../lib/paths.mjs';
import { targetsFromSpec, validateTarget } from '../lib/targets.mjs';
import { runE2e } from '../lib/e2e.mjs';

const USAGE = `opurom — OPUROM toolchain CLI (zero npm dependencies)

Usage: node bin/opurom.mjs <command> [options]

Commands:
  doctor                          check rustc/cargo/node/opuromc/render
  targets                         list the 8 IR emitters
  init <dir>                      scaffold a new project
  check <src.opu>                 type-check a source file
  build --src <src.opu> --target <name> --out <dir>
                                  compile IR and lower to a target
  dev --src <src.opu> [--port N] serve web target with SSE hot reload
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
      validateTarget(target);
      build({ src, target, out });
      return 0;
    }
    case 'dev': {
      const { src } = requireFlags(flags, ['src']);
      const port = parsePort(flags.port);
      await dev({ src, port });
      return 0; // the HTTP server keeps the process alive
    }
    case 'test':
      console.log('OPUROM end-to-end tests');
      return runE2e().exitCode;
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
