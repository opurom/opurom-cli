import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CLI_ROOT, discoverBinary, findInPath, isExecutable, siblingRoot, specFile, workspaceRoot,
} from '../lib/paths.mjs';

test('workspace and sibling discovery are anchored to this repo', () => {
  const root = workspaceRoot();
  assert.equal(siblingRoot('opurom-lang', root), path.join(root, 'opurom-lang'));
  assert.equal(specFile('counter.opuir.json', root), path.join(root, 'opurom-spec', 'counter.opuir.json'));
  assert.equal(CLI_ROOT, path.resolve(path.join(import.meta.dirname, '..')));
  assert.equal(workspaceRoot(CLI_ROOT), path.dirname(CLI_ROOT));
});

test('findInPath and isExecutable find a real executable, skip non-executables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-path-'));
  try {
    const exe = path.join(dir, 'fake-opuromc');
    const plain = path.join(dir, 'notes.txt');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(plain, 'hello');
    assert.equal(findInPath('fake-opuromc', dir), path.resolve(exe));
    assert.equal(findInPath('missing-opuromc', dir), null);
    assert.equal(isExecutable(exe), true);
    assert.equal(isExecutable(plain), false);
    assert.equal(isExecutable(path.join(dir, 'absent')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverBinary prefers a sibling debug binary and returns null when absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-root-'));
  try {
    const binDir = path.join(root, 'opurom-lang', 'target', 'debug');
    fs.mkdirSync(binDir, { recursive: true });
    assert.equal(discoverBinary('opuromc', { root, repo: 'opurom-lang' }), null);
    const exe = path.join(binDir, 'opuromc');
    fs.writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    assert.equal(discoverBinary('opuromc', { root, repo: 'opurom-lang' }), path.resolve(exe));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
