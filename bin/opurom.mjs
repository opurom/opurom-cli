#!/usr/bin/env node
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { flagEnabled, parseArgs, parsePort, requireFlags } from '../lib/args.mjs';
import {
  buildEnvironmentArgs, buildInfoFor, configCommand, createLogRing, environmentProcessEnv,
  parseCliDefines, parseLogLevel, resolveEnvironment,
} from '../lib/config.mjs';
import { build, buildFull, buildWasm, check, migrate, projectMain } from '../lib/build.mjs';
import { analyze } from '../lib/analyze.mjs';
import { pub } from '../lib/pub.mjs';
import { modePlan } from '../lib/build_mode.mjs';
import { verifyArtifactManifest } from '../lib/fullstack.mjs';
import { dev } from '../lib/dev.mjs';
import { runDoctor } from '../lib/doctor.mjs';
import { init, TEMPLATE_HELP, TEMPLATES } from '../lib/init.mjs';
import { targetsFromBuiltins, validateBuildTarget } from '../lib/targets.mjs';
import { runE2e } from '../lib/e2e.mjs';
import { serve } from '../lib/serve.mjs';
import { bench } from '../lib/bench.mjs';
import { benchSuite } from '../lib/bench_suite.mjs';
import { inspect, machineReport, profile } from '../lib/async_runtime.mjs';
import { MAX_FRAMES as FRAME_PROFILE_MAX_FRAMES, profileFrames } from '../lib/frame_profile.mjs';
import { inspectTree } from '../lib/inspect_tree.mjs';
import { inspectDevDigest, inspectDevState, inspectDevTree, inspectDevtools, inspectPerformance } from '../lib/inspect_dev.mjs';
import { sizeReport } from '../lib/minify.mjs';
import { compareBackends, profileRepeat } from '../lib/profile.mjs';
import { DEFAULT_SYNC_PORT, verifySync } from '../lib/sync.mjs';
import { examplesList, runExampleTests } from '../lib/examples.mjs';
import { discoverScripts, runWidgetTests } from '../lib/widget_test.mjs';
import { archiveReport, buildReport, latestReport, readArchivedReport, reportJson } from '../lib/test_report.mjs';
import { workspaceRoot } from '../lib/paths.mjs';

const USAGE = `opurom — Opurom toolchain CLI (zero npm dependencies)

Usage: node bin/opurom.mjs <command> [options]

Commands:
  doctor                          check rustc/cargo/node/opuromc/render/gpu
  config [--list] [--machine] [--key value ...]
                                  read/write global settings (empty value removes)
  logs [<file>...] [--level trace|info|warn|error] [--source <s>] [--q <text>]
       [--format json|ndjson|text] [--out <file>]
                                  read/export dev log exports or saved log files
  targets                         list the IR emitters
  pub <subcommand> [arguments...]  forward dependency commands to opurom-pkg
                                  (get/upgrade/add/remove/outdated/deps/...)
  init --list
                                  list starter templates
  init <dir> [--template <name>]
                                  scaffold a new project (project has multiple .opu files)
  check <src.opu>                 type-check a source file
  analyze [<dir>] [--machine] [--write <file>]
                                  static quality gate over the project sources
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
                                  serve web-dom page with SSE hot reload (+ backend restart);
                                  --targets accepts nine dev targets; 2+ list them at /
  dev ... [--kernel <opurom-core>] [--inspector <bundle-dir>]
                                  relay the inspector data plane (frames/memory/network)
                                  at /api/inspect/* and host the inspector at /inspector
  dev --src <src.opu> --android [--device <serial>]
                                  push state-preserving hot reload to an Android device
  dev --sync [--clients N] [--port N]
                                  verify N loopback WebSocket clients against a running sync hub
  bench --src <src.opu> [--out <dir>] [--full] [--json]
                                  measured compile/build times and artifact sizes
  bench --src <src.opu> --compare [--json]
                                  measured software vs GPU backend times + byte equality
  bench --suite [--runs N] [--json] [--markdown]
                                  measured cold compile/render samples and 10 target byte sizes;
                                  competitors not measured
  profile --src <src.opu> [--frames N] [--degrade <60|120>] [--json] [--markdown]
                                  measured frame timings, fps x10 and ASCII sparkline (1..1000);
                                  --degrade also runs the renderer's auto-degrade policy
  profile --src <src.opu> --repeat N [--json]
                                  measured repeated runs, warmup excluded and reported (1..600)
  inspect <ir.json> [--select <id>] [--layers] [--json]
                                  widget tree (ids, kinds, bounds, visibility);
                                  --select returns one node's ancestor path+subtree
  inspect --dev [<url>] [--tree|--digest] [--select <id>] [--layers] [--json]
                                  live views from a running "opurom dev" server
                                  (default :5178): state snapshot + recent
                                  events, --tree for the live IR widget tree,
                                  --digest for the golden digest + node diff
  devtools [<url>] [--json] [--panels]
                                  show DevTools session discovery and, with
                                  --panels, the frames/memory/network/logs views
  perf [<url>] [--json]           show the measured frame-phase flame graph
                                  from a running "opurom dev" server
  examples                        list registered example apps and their tests
  test                            end-to-end golden pipeline checks
  test --examples [--filter <name>] [--jobs N] [-j N] [--verbose] [--fail-fast]
                                  run registered example tests ctest-style
  test --widget <file|dir> [--verbose] [--fail-fast] [--update-goldens]
                                  run interaction-test scripts (.wtest.json);
                                  --update-goldens rewrites only changed digests
  test --report [--out <dir>] [--latest]
                                  build and archive a deterministic test report;
                                  --latest prints the most recent archived report
                                  run interaction-test scripts (.wtest.json)

Run "node bin/opurom.mjs <command> --help" for the same summary.

Global build options (check/build/dev/serve):
  --env <name>                    select a configured environment (default/dev/test/prod)
  --mode <debug|profile|release>  build mode (Flutter BuildMode parity, default debug)
  --dart-define KEY=VALUE         compile-time value; repeats allowed, highest precedence
  --dart-define-from-file <file>  JSON or .env value file; repeats allowed, merged in order

Settings are stored under $OPUR_CONFIG or $XDG_CONFIG_HOME/opurom; project
overrides live in <project>/.opurom/settings.json.`;

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
  const cwd = process.cwd();
  const configOptions = {};
  const reserved = new Set([
    'src', 'project', 'out', 'target', 'port', 'template', 'list', 'machine', 'help',
    'env', 'mode', 'dart-define', 'dart-define-from-file', 'json', 'markdown', 'full',
    'compare', 'suite', 'runs', 'frames', 'repeat', 'degrade', 'select', 'layers', 'tree',
    'digest', 'dev', 'widget', 'examples', 'filter', 'jobs', 'concurrency', 'verbose',
    'fail-fast', 'update-goldens', 'optimize', 'minify', 'tree-shake', 'sourcemap',
    'device', 'android', 'kernel', 'inspector', 'sync', 'clients', 'targets',
    'level', 'source', 'q', 'format', 'since', 'limit', 'write', 'panels',
  ]);
  for (const [key, value] of Object.entries(flags)) {
    if (!reserved.has(key) && !key.startsWith('dart-define')) configOptions[key] = value;
  }
  const environment = command && ['check', 'analyze', 'build', 'dev', 'serve'].includes(command)
    ? resolveEnvironment({
      cwd,
      envName: typeof flags.env === 'string' ? flags.env : undefined,
      dartDefine: flags['dart-define'],
      defineFromFile: flags['dart-define-from-file'],
    })
    : null;
  const buildInfo = environment && command !== 'serve'
    ? buildInfoFor({
      mode: flags.mode,
      target: command === 'build' && typeof flags.target === 'string' ? flags.target : null,
      environment,
    })
    : null;
  const runtimeEnv = environment ? environmentProcessEnv(environment) : process.env;
  if (environment) {
    for (const key of ['--env', '--mode']) {
      const flag = key.slice(2);
      if (flags[flag] === true) throw new Error(`missing required value for ${key}`);
    }
  }
  if (!command || (flags.help && command !== 'pub') || command === 'help') {
    console.log(USAGE);
    return 0;
  }

  switch (command) {
    case 'doctor':
      return runDoctor();
    case 'logs': {
      const format = typeof flags.format === 'string' ? flags.format : 'text';
      const level = parseLogLevel(flags.level ?? undefined);
      const source = typeof flags.source === 'string' ? flags.source : undefined;
      const q = typeof flags.q === 'string' ? flags.q : '';
      const since = flags.since === undefined ? 0 : Number(flags.since);
      const limit = flags.limit === undefined ? undefined : Number(flags.limit);
      if (!Number.isInteger(since) || since < 0) throw new Error(`invalid --since: ${flags.since}`);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error(`invalid --limit: ${flags.limit}`);
      const ring = createLogRing();
      const files = positionals.slice(1);
      if (files.length === 0) {
        const view = await (await fetch('http://127.0.0.1:5178/api/logs')).text();
        console.log(view.trimEnd());
        return 0;
      }
      for (const file of files) {
        const lines = readFileSync(file, 'utf8').split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          let row;
          try {
            row = JSON.parse(line);
          } catch {
            row = { level: 'info', source: 'file', message: line };
          }
          ring.add(row.level ?? 'info', row.message ?? String(row), {
            source: row.source ?? path.basename(file),
          });
        }
      }
      const output = ring.export({ format, level, source, q, since, limit });
      if (typeof flags.out === 'string') {
        const fs = await import('node:fs');
        fs.writeFileSync(flags.out, output);
        console.log(`logs exported: ${flags.out}`);
      } else {
        process.stdout.write(output);
      }
      return 0;
    }
    case 'config': {
      if (positionals[1]) throw new Error(`unexpected argument: ${positionals[1]}`);
      const { code } = configCommand({
        options: configOptions,
        list: flagEnabled(flags, 'list'),
        machine: flagEnabled(flags, 'machine'),
        cwd,
        log: console.log,
      });
      return code;
    }
    case 'pub': {
      const { code } = pub({ argv: process.argv.slice(3) });
      return code;
    }
    case 'targets':
      for (const name of targetsFromBuiltins()) console.log(name);
      return 0;
    case 'init': {
      if (flagEnabled(flags, 'list')) {
        for (const name of TEMPLATES) {
          console.log(flagEnabled(flags, 'verbose') ? `${name}\t${TEMPLATE_HELP[name]}` : name);
        }
        return 0;
      }
      if (!positionals[1]) throw new Error('usage: init <dir>');
      if (flags.template === true || flags.template === '') throw new Error('missing required option --template');
      const template = typeof flags.template === 'string' ? flags.template : 'counter';
      const dir = init(positionals[1], { template });
      const edit = path.join(dir, template === 'project' ? 'main.opu' : 'src');
      console.log(`init ok: ${dir} (edit ${edit})`);
      return 0;
    }
    case 'check': {
      const src = positionals[1] ?? flags.src;
      if (!src) throw new Error('usage: check <src.opu>');
      check(src, { env: runtimeEnv, environment, buildInfo });
      console.log(`check ok: ${path.resolve(src)}`);
      for (const entry of environment.entries) console.log(`  define: ${entry}`);
      return 0;
    }
    case 'analyze': {
      const target = positionals[1] ?? '.';
      const result = analyze({
        path: target, env: runtimeEnv, environment, buildInfo,
        machine: flagEnabled(flags, 'machine') || flagEnabled(flags, 'json'),
        write: typeof flags.write === 'string' ? flags.write : null,
      });
      return result.issues ? 1 : 0;
    }
    case 'build': {
      const src = buildSource(flags);
      const { target, out } = requireFlags(flags, ['target', 'out']);
      validateBuildTarget(target);
      const flagsByName = {
        optimize: flags.optimize !== undefined,
        minify: flags.minify !== undefined,
        treeShake: flags['tree-shake'] !== undefined,
        sourcemap: flags.sourcemap !== undefined,
      };
      const modeFlags = modePlan(buildInfo?.mode, flagsByName);
      const optimize = modeFlags.optimize;
      const minify = modeFlags.minify;
      const treeShake = modeFlags.treeShake;
      const sourcemap = modeFlags.sourcemap;
      const modeContext = { ...modeFlags, out };
      if (target === 'full') {
        buildFull({ src, out, optimize, minify, treeShake, sourcemap, env: runtimeEnv, environment, buildInfo, modeContext });
        return 0;
      }
      if (target === 'wasm') {
        buildWasm({ src, out, optimize, minify, treeShake, sourcemap, env: runtimeEnv, environment, buildInfo, modeContext });
        return 0;
      }
      build({ src, target, out, optimize, minify, treeShake, sourcemap, env: runtimeEnv, environment, buildInfo, modeContext });
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
      await serve({ out, port, env: runtimeEnv });
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
      await dev({
        src, port, sync, targets: flags.targets,
        android: flagEnabled(flags, 'android') ? { serial: typeof flags.device === 'string' ? flags.device : undefined } : null,
        kernel: typeof flags.kernel === 'string' ? { binary: flags.kernel } : null,
        inspector: typeof flags.inspector === 'string' ? flags.inspector : undefined,
        env: runtimeEnv, environment, buildInfo,
      });
      return 0; // the HTTP server keeps the process alive
    }
    case 'bench': {
      const json = flagEnabled(flags, 'json');
      const markdown = flagEnabled(flags, 'markdown');
      if (flagEnabled(flags, 'suite')) {
        if (flagEnabled(flags, 'full') || flagEnabled(flags, 'compare')) {
          throw new Error('usage: --suite cannot be combined with --full or --compare');
        }
        return benchSuite({ runs: flags.runs, json, markdown }).exitCode;
      }
      const { src } = requireFlags(flags, ['src']);
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
      const markdown = flagEnabled(flags, 'markdown');
      const degrade = flags.degrade === true ? '' : flags.degrade;
      if (degrade !== undefined && flags.repeat !== undefined) {
        throw new Error('usage: --degrade applies to --frames, not --repeat');
      }
      if (flags.repeat !== undefined) {
        if (markdown) throw new Error('usage: --markdown requires --frames, not --repeat');
        return profileRepeat({ src, repeat: flags.repeat, json });
      }
      if (json || markdown || degrade !== undefined) {
        return profileFrames({ src, frames: flags.frames, json, markdown, degrade });
      }
      return profile({ src, frames: flags.frames, json, frameLimit: FRAME_PROFILE_MAX_FRAMES });
    }
    case 'inspect': {
      const ir = positionals[1];
      if (flags.dev !== undefined) {
        if (ir) throw new Error('usage: inspect accepts <ir.json> or --dev <url>, not both');
        const select = flags.select === undefined ? undefined
          : (flags.select === true ? '' : String(flags.select));
        if (flagEnabled(flags, 'tree') && flagEnabled(flags, 'digest')) {
          throw new Error('usage: inspect --dev takes --tree or --digest, not both');
        }
        if (flagEnabled(flags, 'tree')) {
          return await inspectDevTree({
            url: flags.dev, select, layers: flagEnabled(flags, 'layers'), json: flagEnabled(flags, 'json'),
          });
        }
        if (flagEnabled(flags, 'digest')) {
          if (flags.select !== undefined || flagEnabled(flags, 'layers')) {
            throw new Error('usage: inspect --dev --digest takes only --json');
          }
          return await inspectDevDigest({ url: flags.dev, json: flagEnabled(flags, 'json') });
        }
        if (flags.select !== undefined || flagEnabled(flags, 'layers')) {
          throw new Error('usage: inspect --dev --select/--layers require --tree (the state view takes none)');
        }
        return await inspectDevState({ url: flags.dev, json: flagEnabled(flags, 'json') });
      }
      if (!ir) throw new Error('usage: inspect <ir.json> [--select <id>] [--layers] [--json] | inspect --dev [<url>] [--tree] [--json]');
      const select = flags.select === undefined ? undefined
        : (flags.select === true ? '' : String(flags.select));
      return inspectTree({ ir, select, layers: flagEnabled(flags, 'layers'), json: flagEnabled(flags, 'json') });
    }
    case 'devtools': {
      const url = positionals[1];
      if (url && flags.tree) throw new Error('usage: devtools [<url>] [--json]');
      return await inspectDevtools({
        url, json: flagEnabled(flags, 'json'), panels: flagEnabled(flags, 'panels'),
      });
    }
    case 'perf': {
      return await inspectPerformance({ url: positionals[1], json: flagEnabled(flags, 'json') });
    }
    case 'examples':
      await examplesList();
      return 0;
    case 'test': {
      const failFast = flagEnabled(flags, 'fail-fast');
      const updateGoldens = flagEnabled(flags, 'update-goldens');
      if (flagEnabled(flags, 'report')) {
        if (flags.widget !== undefined || flagEnabled(flags, 'examples')
            || flags['fail-fast'] !== undefined || flags['update-goldens'] !== undefined) {
          throw new Error('usage: --report is standalone; run tests first, then archive');
        }
        if (flagEnabled(flags, 'latest')) {
          const dir = typeof flags.out === 'string' ? path.resolve(flags.out) : undefined;
          const file = latestReport(workspaceRoot(), dir);
          if (!file) throw new Error('no archived test report found');
          const archived = readArchivedReport(file);
          process.stdout.write(reportJson(archived));
          return archived.summary.FAIL ? 1 : 0;
        }
        const report = buildReport({ root: workspaceRoot() });
        const file = archiveReport(report, {
          root: workspaceRoot(),
          dir: typeof flags.out === 'string' ? path.resolve(flags.out) : undefined,
        });
        process.stdout.write(reportJson(report));
        process.stderr.write(`archived ${file}\n`);
        return report.summary.FAIL ? 1 : 0;
      }
      if (updateGoldens && flags.widget === undefined) {
        throw new Error('usage: --update-goldens requires --widget (it rewrites .wtest.json digests)');
      }
      if (flagEnabled(flags, 'examples')) {
        if (flags.filter === true) throw new Error('--filter requires a name');
        if (flags.concurrency !== undefined && flags.jobs !== undefined) {
          throw new Error('usage: --jobs and --concurrency/-j are aliases; pass only one');
        }
        const jobs = flags.concurrency ?? flags.jobs;
        const { exitCode } = await runExampleTests({
          filter: typeof flags.filter === 'string' ? flags.filter : undefined,
          jobs,
          verbose: flagEnabled(flags, 'verbose'),
          failFast,
        });
        return exitCode;
      }
      if (flags.concurrency !== undefined) {
        throw new Error('usage: --concurrency/-j applies only to --examples');
      }
      if (flags.widget !== undefined) {
        if (flags.widget === true) throw new Error('--widget requires a script file or directory');
        const target = path.resolve(flags.widget);
        const files = target.endsWith('.wtest.json') ? [target] : discoverScripts(target);
        if (files.length === 0) throw new Error(`no .wtest.json scripts found under ${target}`);
        const { exitCode } = runWidgetTests(files, {
          log: console.log,
          verbose: flagEnabled(flags, 'verbose'), failFast, updateGoldens,
        });
        return exitCode;
      }
      console.log('Opurom end-to-end tests');
      return (await runE2e({ failFast })).exitCode;
    }
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
