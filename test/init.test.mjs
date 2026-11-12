import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { CLI_ROOT } from '../lib/paths.mjs';
import { init } from '../lib/init.mjs';

test('init scaffolds a project and refuses to overwrite non-empty dirs', () => {
  fs.mkdirSync(path.join(CLI_ROOT, 'tmp'), { recursive: true });
  const base = fs.mkdtempSync(path.join(CLI_ROOT, 'tmp', 'init-test-'));
  const project = path.join(base, 'demo');
  try {
    assert.equal(init(project), project);
    assert.deepEqual(fs.readdirSync(project).sort(), ['.gitignore', 'README.md', 'opurom.json', 'src']);
    const config = JSON.parse(fs.readFileSync(path.join(project, 'opurom.json'), 'utf8'));
    assert.equal(config.name, 'demo');
    assert.equal(config.targets.length, 8);
    assert.match(fs.readFileSync(path.join(project, 'src', 'main.opu'), 'utf8'), /app Counter/);
    assert.throws(() => init(project), /refusing to overwrite non-empty directory/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
