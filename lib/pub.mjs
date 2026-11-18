// Unified dependency command: the Opurom counterpart of `flutter pub`
// (Flutter 3.50.0, flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/commands/packages.dart:30-100 (subcommand table:
//   get/upgrade/add/remove/test/publish/downgrade/deps/run/cache/version/
//   outdated/global/...)
// - packages/flutter_tools/lib/src/commands/packages.dart:277-380 (forward args
//   to the pub tool inside the project context, preserve user flags, report
//   elapsed time, pass through failures)
// - packages/flutter_tools/lib/src/dart/pub.dart:57-73 (PubContext per command)
// Opurom adaptation: no Dart pub; the implementation is the sibling
// `opurom-pkg` binary. This module owns only the CLI surface and forwarding
// contract, never another repo's package logic.

import fs from 'node:fs';
import path from 'node:path';
import { findInPath, workspaceRoot } from './paths.mjs';
import { run } from './proc.mjs';

// Mirrors the Flutter `flutter pub` subcommand table. Commands unknown to the
// CLI are forwarded verbatim, matching PackagesForwardCommand's permissive
// behavior (packages.dart:90-130).
export const PUB_SUBCOMMANDS = Object.freeze([
  'add', 'remove', 'list', 'show', 'outdated', 'verify', 'lock', 'install',
  'update', 'search', 'info', 'sign', 'channel-sign', 'channel-verify',
  'publish', 'registry-server', 'github-registry-server',
]);

// Opurom command contexts, named after the Flutter PubContext categories
// (dart/pub.dart:57-73) but mapped to the actual opurom-pkg verbs.
export const PUB_CONTEXT = Object.freeze({
  add: 'add',
  remove: 'remove',
  list: 'deps',
  show: 'deps',
  outdated: 'outdated',
  verify: 'verify',
  lock: 'get',
  install: 'get',
  update: 'upgrade',
});

export function resolvePkgBinary({ root = workspaceRoot(), envPath = process.env.PATH ?? '' } = {}) {
  const sibling = path.join(root, 'opurom-pkg', 'bin', 'opurom-pkg.mjs');
  if (fs.existsSync(sibling)) return sibling;
  return findInPath('opurom-pkg', envPath);
}

export function parsePubArgs(argv = []) {
  const args = argv.map(String);
  const subcommand = args[0];
  if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
    return { help: true, subcommand: null, rest: [] };
  }
  if (subcommand.startsWith('-')) {
    throw new Error(`pub requires a subcommand before ${subcommand}`);
  }
  return { help: false, subcommand, rest: args.slice(1) };
}

export function pubUsage() {
  return [
    'opurom pub <subcommand> [arguments...]',
    '',
    'Subcommands:',
    ...PUB_SUBCOMMANDS.map((name) => `  ${name}`),
    '',
    'Arguments are forwarded verbatim to opurom-pkg.',
  ].join('\n');
}

export function pub({
  argv = [], cwd = process.cwd(), root = workspaceRoot(), env = process.env,
  log = console.log, binary = null,
} = {}) {
  const parsed = parsePubArgs(argv);
  if (parsed.help) {
    log(pubUsage());
    return { code: 0, help: true, subcommand: null };
  }
  const pkg = binary ?? resolvePkgBinary({ root });
  if (!pkg) {
    throw new Error('opurom-pkg not found: check out the sibling opurom-pkg repo or put opurom-pkg on PATH');
  }
  const subcommand = parsed.subcommand;
  const allowed = PUB_SUBCOMMANDS.includes(subcommand);
  const executable = pkg;
  const args = [subcommand, ...parsed.rest];
  const started = process.hrtime.bigint();
  const result = run(executable, args, { cwd, env, inherit: true });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  log(`pub ${subcommand}${allowed ? '' : ' (forwarded)'}: exit ${result.status} (${ms.toFixed(1)} ms)`);
  return { code: result.status, help: false, subcommand, context: PUB_CONTEXT[subcommand] ?? 'forward' };
}
