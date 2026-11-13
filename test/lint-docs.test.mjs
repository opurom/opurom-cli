import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { lintDocs } from '../lib/lint-docs.mjs';

const CLI = fileURLToPath(new URL('../bin/opurom.mjs', import.meta.url));

function run(root, options = {}) {
  const args = [CLI, 'lint-docs'];
  if (root !== undefined) args.push(root);
  return spawnSync(process.execPath, args, { encoding: 'utf8', ...options });
}

function tempRoot(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('lint-docs passes a clean fixture and ignores commands and skipped directories', (t) => {
  const root = tempRoot(t, 'opurom-lint-clean-');
  const clean = [
    '# Overview',
    '',
    'The CLI exposes one command.',
    'The constant R10_KINDS remains in the registry.',
    '',
    '```sh',
    'cd /Users/example/project',
    'R10_KINDS=1 node bin/opurom.mjs test',
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'clean.md'), clean);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'notes.md'), 'The interface is described in English.\n');
  for (const name of ['.git', 'node_modules', 'target', 'tmp', 'dist']) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'ignored.md'), 'Path: /Users/example/project\n');
  }

  const explicit = run(root);
  assert.equal(explicit.status, 0, explicit.stderr);
  assert.equal(explicit.stdout.trim(), 'lint-docs ok: 2 Markdown files scanned');
  assert.equal(explicit.stderr, '');
  const implicit = run(undefined, { cwd: root });
  assert.equal(implicit.status, 0, implicit.stderr);
  assert.equal(implicit.stdout.trim(), 'lint-docs ok: 2 Markdown files scanned');
  assert.deepEqual(lintDocs(root), []);
});

test('lint-docs reports each rule with its line number and sorted file order', (t) => {
  const root = tempRoot(t, 'opurom-lint-rules-');
  const lines = [
    'Path: /Users/example/project',
    'Path: /mac/work/project',
    'Path: $HOME/.cargo/bin',
    'Path: /private/var/example',
    'Label: R1',
    'Label: round-2',
    'Label: Round 3',
    'Label: r7_widget r12_layout',
    '*Figure 4: Calculator screenshot',
    'All published source, comments and documentation are written in English.',
    String.fromCharCode(0x6587),
    'no invented results',
  ];
  fs.writeFileSync(path.join(root, 'a.md'), 'Prose\nPath: /Users/example/project\n');
  fs.writeFileSync(path.join(root, 'rules.md'), `${lines.join('\n')}\n`);

  const findings = lintDocs(root);
  const expected = [
    { file: 'a.md', line: 2, rule: 'local-path', text: 'Path: /Users/example/project' },
    ...lines.map((text, index) => ({
      file: 'rules.md',
      line: index + 1,
      rule: index < 4 ? 'local-path'
        : index < 8 ? 'codename'
          : index === 8 ? 'figure-caption'
            : index === 9 ? 'boilerplate'
              : index === 10 ? 'cjk' : 'self-deprecating',
      text,
    })),
  ];
  assert.deepEqual(findings, expected);

  const result = run(root);
  assert.equal(result.status, 1, result.stderr);
  for (const finding of expected) {
    assert.match(result.stdout, new RegExp(`^${finding.file}:${finding.line}: ${finding.rule}:`, 'm'));
  }
  assert.match(result.stdout, /^lint-docs: 13 findings in 2 Markdown files scanned$/m);
});

test('lint-docs accepts a directory path with spaces', (t) => {
  const base = tempRoot(t, 'opurom lint ');
  const root = path.join(base, 'folder with spaces');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'notes with spaces.md'), 'Label: R1\n');

  const result = run(root);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^notes with spaces\.md:1: codename: Label: R1$/m);
  assert.match(result.stdout, /^lint-docs: 1 finding in 1 Markdown file scanned$/m);
});
