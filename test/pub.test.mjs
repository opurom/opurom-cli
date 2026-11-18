// Dependency CLI tests. Flutter authority (3.50.0):
// - packages/flutter_tools/lib/src/commands/packages.dart:30-100 (pub subcommand table)
// - packages/flutter_tools/lib/src/commands/packages.dart:277-380 (arg forwarding,
//   project context, pass-through exit code)
// - packages/flutter_tools/lib/src/dart/pub.dart:57-73 (PubContext per command)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { run } from '../lib/proc.mjs';
import { parsePubArgs, PUB_CONTEXT, PUB_SUBCOMMANDS, pub, pubUsage, resolvePkgBinary } from '../lib/pub.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

test('pub subcommand table maps to the real opurom-pkg verbs', () => {
  for (const name of ['add', 'remove', 'list', 'show', 'outdated', 'verify', 'lock', 'install', 'update']) {
    assert.ok(PUB_SUBCOMMANDS.includes(name), name);
  }
  assert.deepEqual(PUB_CONTEXT, {
    add: 'add', remove: 'remove', list: 'deps', show: 'deps', outdated: 'outdated',
    verify: 'verify', lock: 'get', install: 'get', update: 'upgrade',
  });
  assert.match(pubUsage(), /opurom pub <subcommand>/);
});

test('pub args preserve user flags and reject bare options', () => {
  assert.deepEqual(parsePubArgs(['get', '--offline', '--directory', 'app']), {
    help: false, subcommand: 'get', rest: ['--offline', '--directory', 'app'],
  });
  assert.deepEqual(parsePubArgs(['help']), { help: true, subcommand: null, rest: [] });
  assert.throws(() => parsePubArgs(['--offline']), /requires a subcommand/);
});

test('pub forwards to a stub package binary and passes its exit code', () => {
  const base = tmpDir('pub-cli-');
  try {
    const stub = path.join(base, 'list');
    fs.writeFileSync(stub, [
      '#!/usr/bin/env node',
      'import fs from "node:fs";',
      'fs.writeFileSync(process.argv[3], JSON.stringify(process.argv.slice(2)));',
      'process.exit(process.argv[2] === "fail" ? 7 : 0);',
    ].join('\n'), { mode: 0o755 });
    const seen = path.join(base, 'args.json');
    const lines = [];
    const result = pub({
      argv: ['list', seen, '--offline'],
      cwd: base,
      binary: stub,
      log: (line) => lines.push(String(line)),
    });
    assert.equal(result.code, 0);
    assert.equal(result.subcommand, 'list');
    assert.equal(result.context, 'deps');
    assert.deepEqual(JSON.parse(fs.readFileSync(seen, 'utf8')), ['list', seen, '--offline']);
    assert.match(lines.join('\n'), /pub list: exit 0/);

    const failStub = path.join(base, 'fail');
    fs.copyFileSync(stub, failStub);
    fs.chmodSync(failStub, 0o755);
    const failed = pub({ argv: ['fail', path.join(base, 'fail-args.json')], cwd: base, binary: failStub, log: () => {} });
    assert.equal(failed.code, 7);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('pub CLI help and missing subcommand behave like a command group', () => {
  const help = run(process.execPath, [CLI, 'pub', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /opurom pub <subcommand>/);
  const bad = run(process.execPath, [CLI, 'pub', '--offline']);
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /requires a subcommand/);
});

test('pub resolves the sibling opurom-pkg binary by default', () => {
  const binary = resolvePkgBinary();
  assert.ok(binary, 'sibling opurom-pkg binary should be available in this workspace');
  assert.equal(path.basename(binary), 'opurom-pkg.mjs');
});
