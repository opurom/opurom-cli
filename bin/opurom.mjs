#!/usr/bin/env node
import path from 'node:path';
import { flagEnabled, parseArgs, parsePort, requireFlags } from '../lib/args.mjs';
import { build, buildFull, buildWasm, check, migrate, projectMain } from '../lib/build.mjs';
import { verifyArtifactManifest } from '../lib/fullstack.mjs';
import { dev } from '../lib/dev.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { runLintDocs } from '../lib/lint-docs.mjs';
import { init } from '../lib/init.mjs';
import { specFile } from '../lib/paths.mjs';
import { targetsFromSpec, validateBuildTarget } from '../lib/targets.mjs';
import { runE2e } from '../lib/e2e.mjs';
import { serve } from '../lib/serve.mjs';
import { bench } from '../lib/bench.mjs';
import { inspect, machineReport, profile } from '../lib/async_runtime.mjs';
import { sizeReport } from '../lib/minify.mjs';
import { compareBackends, profileRepeat } from '../lib/profile.mjs';
import { DEFAULT_SYNC_PORT, verifySync } from '../lib/sync.mjs';
import { examplesList, runExampleTests } from '../lib/examples.mjs';

const USAGE = `opurom — OPUROM toolchain CLI (zero npm dependencies)

Usage: node bin/opurom.mjs <command> [options]

Commands:
  doctor                          check rustc/cargo/node/opuromc/render/gpu
  targets                         list the IR emitters
  init <dir> [--template counter|particles|project]
                                  scaffold a new project (project has multiple .opu files)
  check <src.opu>                 type-check a source file
  build --src <src.opu> --target <name> --out <dir> [--optimize] [--minify] [--tree-shake] [--sourcemap]
                                  compile IR and lower to a target
                                  (name: emitter, "full" or "wasm")
  build --src <src.opu> --target web-dom --out <dir>
                                  responsive DOM page that reflows on browser resize
  build --project <dir> --target <name> --out <dir>
                                  build <dir>/main.opu with its imports resolved
  build --src <src.opu> --target full --out <dir>
                                  frontend + service crate + migrations + shared types
  verify --out <dir>              check the generated-artifact manifest of a full build
  size <dir>                      measured before/after byte table of a build
  serve --out <dir> [--port N]    run the generated service (OPR_PORT/OPR_DB)
  migrate --src <src.opu> --out <dir>
                                  generate SQL migrations from the IR models
  dev --src <src.opu> [--port N] [--sync] [--targets t1,t2]
                                  serve web target with SSE hot reload (+ backend restart);
                                  --targets lowers 2+ targets from one IR and lists them
  dev --sync [--clients N] [--port N]
                                  verify N loopback WebSocket clients against a running sync hub
  bench --src <src.opu> [--out <dir>] [--full] [--json]
                                  measured compile/build times and artifact sizes
  bench --src <src.opu> --compare [--json]
                                  measured software vs GPU backend times + byte equality
  profile --src <src.opu> [--frames N] [--json]
                                  measured software-raster frame timings (1..600)
  profile --src <src.opu> --repeat N [--json]
                                  measured repeated runs, warmup excluded and reported (1..600)
  inspect <ir.json>               read-only layer + a11y trees side by side
  examples                        list registered example apps and their tests
  test                            end-to-end golden pipeline checks
  test --examples [--filter <name>] [--jobs N] [--verbose]
                                  run registered example tests ctest-style
  lint-docs [dir]                 check published Markdown for red lines

Run "node bin/opurom.mjs <command> --help" for the same summary.`;

function buildSource(flags) {
  if (flags.project !== undefined) {
    if (flags.src !== undefined) throw new Error('usage: build accepts --src or --project, not both');
    return projectMain(flags.project);
  }
  return requireFlags(flags, ['src']).src;
}

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
      const template = typeof flags.template === 'string' ? flags.template : 'counter';
      const dir = init(positionals[1], { template });
      const edit = path.join(dir, template === 'project' ? 'main.opu' : 'src');
      console.log(`init ok: ${dir} (edit ${edit})`);
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
      const src = buildSource(flags);
      const { target, out } = requireFlags(flags, ['target', 'out']);
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
    case 'verify': {
      const { out } = requireFlags(flags, ['out']);
      const manifest = verifyArtifactManifest(out);
      console.log(`manifest ok: ${manifest.artifacts.length} artifacts, ${manifest.files.length} files`);
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
      await dev({ src, port, sync, targets: flags.targets });
      return 0; // the HTTP server keeps the process alive
    }
    case 'bench': {
      const { src } = requireFlags(flags, ['src']);
      const json = flagEnabled(flags, 'json');
      if (flagEnabled(flags, 'compare')) {
        return compareBackends({ src, json });
      }
      const out = typeof flags.out === 'string' ? flags.out : path.join('tmp', 'bench');
      const full = flagEnabled(flags, 'full');
      const result = await bench({ src, out, full, json });
      if (!json) return 0;
      console.log(machineReport({
        command: 'bench',
        mode: full ? 'full' : 'single',
        samples: result.samples,
        reason: result.samples.length ? null : 'no measurements',
      }));
      return result.samples.length ? 0 : 1;
    }
    case 'profile': {
      const { src } = requireFlags(flags, ['src']);
      const json = flagEnabled(flags, 'json');
      if (flags.repeat !== undefined) {
        return profileRepeat({ src, repeat: flags.repeat, json });
      }
      return profile({ src, frames: flags.frames, json });
    }
    case 'inspect': {
      const ir = positionals[1];
      if (!ir) throw new Error('usage: inspect <ir.json>');
      return inspect({ ir });
    }
    case 'examples':
      examplesList();
      return 0;
    case 'test':
      if (flagEnabled(flags, 'examples')) {
        if (flags.filter === true) throw new Error('--filter requires a name');
        const { exitCode } = await runExampleTests({
          filter: typeof flags.filter === 'string' ? flags.filter : undefined,
          jobs: flags.jobs,
          verbose: flagEnabled(flags, 'verbose'),
        });
        return exitCode;
      }
      console.log('OPUROM end-to-end tests');
      return (await runE2e()).exitCode;
    case 'lint-docs':
      return runLintDocs({ root: positionals[1] ?? '.' });
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
