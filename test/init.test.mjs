import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tmpDir } from '../lib/paths.mjs';
import { TEMPLATES, init } from '../lib/init.mjs';

test('init scaffolds a project and refuses to overwrite non-empty dirs', () => {
  const base = tmpDir('init-test-');
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

test('the particles template scaffolds a seeded particle field that the default omits', () => {
  const base = tmpDir('init-particles-');
  const project = path.join(base, 'field');
  try {
    assert.deepEqual([...TEMPLATES], ['counter', 'particles', 'project']);
    assert.equal(init(project, { template: 'particles' }), project);
    const source = fs.readFileSync(path.join(project, 'src', 'particles.opu'), 'utf8');
    assert.match(source, /app Particles/);
    assert.match(source, /particles: "count=64,seed=7/);
    assert.match(source, /animate: spring/);
    assert.doesNotMatch(fs.readFileSync(path.join(project, 'src', 'particles.opu'), 'utf8'), /app Counter/);
    assert.throws(() => init(path.join(base, 'other'), { template: 'unknown' }), /unknown template: unknown/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
