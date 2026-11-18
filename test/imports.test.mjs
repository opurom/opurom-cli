// Incremental multi-input dependency graph tests. Flutter authority:
// - packages/flutter_tools/lib/src/build_system/dependency_graph.dart
//   (a target's inputs are the transitive source closure)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (missing inputs are dirty; every tracked file gets a mark)
// The import syntax follows the compiler's rules in opurom-lang
// src/modules.rs:375-475: relative first, then moduleRoots, no '..' or
// absolute paths, cycles rejected, .opu and theme token JSON tracked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectInputFiles, InputGraphError, resolveImportPath } from '../lib/imports.mjs';

const CLI = new URL('../bin/opurom.mjs', import.meta.url).pathname;

function project() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'import-graph-'));
  const app = path.join(base, 'app');
  fs.mkdirSync(path.join(app, 'models'), { recursive: true });
  fs.mkdirSync(path.join(app, 'views'), { recursive: true });
  return { base, app };
}

test('collectInputFiles returns the sorted transitive closure and token JSON', () => {
  const { base, app } = project();
  try {
    fs.writeFileSync(path.join(app, 'main.opu'), [
      'import "models/a.opu"',
      'import "models/b.opu"',
      '',
      'app A { Column { Text("x") } }',
      'theme { import "theme/tokens.json" }',
    ].join('\n'));
    fs.writeFileSync(path.join(app, 'models', 'a.opu'), 'state a = 1\nimport "b.opu"\n');
    fs.writeFileSync(path.join(app, 'models', 'b.opu'), 'state b = 2\n');
    fs.mkdirSync(path.join(app, 'theme'));
    fs.writeFileSync(path.join(app, 'theme', 'tokens.json'), JSON.stringify({ accent: '#111111' }));
    const graph = collectInputFiles(path.join(app, 'main.opu'));
    assert.deepEqual(graph.files, [
      path.join(app, 'main.opu'),
      path.join(app, 'models', 'a.opu'),
      path.join(app, 'models', 'b.opu'),
    ]);
    assert.deepEqual(graph.tokenFiles, [path.join(app, 'theme', 'tokens.json')]);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('import cycles and missing modules fail closed with compiler-style errors', () => {
  const { base, app } = project();
  try {
    fs.writeFileSync(path.join(app, 'main.opu'), 'import "models/a.opu"\n\napp A { Column { Text("x") } }\n');
    fs.writeFileSync(path.join(app, 'models', 'a.opu'), 'import "b.opu"\nstate a = 1\n');
    fs.writeFileSync(path.join(app, 'models', 'b.opu'), 'import "a.opu"\nstate b = 2\n');
    assert.throws(() => collectInputFiles(path.join(app, 'main.opu')), /import cycle detected: models\/a\.opu -> models\/b\.opu/);

    fs.writeFileSync(path.join(app, 'main.opu'), 'import "models/missing.opu"\n\napp A { Column { Text("x") } }\n');
    assert.throws(() => collectInputFiles(path.join(app, 'main.opu')), /cannot read imported module 'models\/missing\.opu': file not found/);

    fs.writeFileSync(path.join(app, 'main.opu'), 'import "../outside.opu"\n\napp A { Column { Text("x") } }\n');
    assert.throws(() => collectInputFiles(path.join(app, 'main.opu')), /may not be absolute or contain '\.\.'/);

    fs.writeFileSync(path.join(app, 'main.opu'), 'import "models/a.opu"\n\napp A { Column { Text("x") } }\n');
    fs.writeFileSync(path.join(app, 'models', 'a.opu'), 'state a = 1\n');
    fs.writeFileSync(path.join(app, 'models', 'b.opu'), 'state b = 2\n');
    fs.writeFileSync(path.join(app, 'main.opu'), 'import "models/a.opu"\nimport "models/b.opu"\n\napp A { Column { Text("x") } }\n');
    const graph = collectInputFiles(path.join(app, 'main.opu'));
    assert.equal(graph.files.length, 3);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('moduleRoots resolve shared imports and reject absolute or escaping entries', () => {
  const { base, app } = project();
  try {
    const shared = path.join(base, 'shared');
    fs.mkdirSync(shared, { recursive: true });
    fs.writeFileSync(path.join(shared, 'tokens.opu'), 'state shared = 1\n');
    fs.writeFileSync(path.join(app, 'opurom.json'), JSON.stringify({ moduleRoots: ['../shared'] }));
    fs.writeFileSync(path.join(app, 'main.opu'), 'import "tokens.opu"\n\napp A { Column { Text("x") } }\n');
    // The compiler's moduleRoots also reject '..'; this graph follows that
    // rule, so a shared directory must live inside the project.
    fs.writeFileSync(path.join(app, 'opurom.json'), JSON.stringify({ moduleRoots: ['shared'] }));
    fs.mkdirSync(path.join(app, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(app, 'shared', 'tokens.opu'), 'state shared = 1\n');
    const graph = collectInputFiles(path.join(app, 'main.opu'), { root: app });
    assert.deepEqual(graph.files, [path.join(app, 'main.opu'), path.join(app, 'shared', 'tokens.opu')]);

    fs.writeFileSync(path.join(app, 'opurom.json'), JSON.stringify({ moduleRoots: ['../shared'] }));
    assert.throws(() => collectInputFiles(path.join(app, 'main.opu'), { root: app }), /moduleRoots entry '\.\.\/shared' may not be absolute or contain '\.\.'/);

    fs.writeFileSync(path.join(app, 'opurom.json'), JSON.stringify({ moduleRoots: ['/absolute'] }));
    assert.throws(() => collectInputFiles(path.join(app, 'main.opu'), { root: app }), /moduleRoots entry '\/absolute' may not be absolute or contain '\.\.'/);

    fs.writeFileSync(path.join(app, 'opurom.json'), JSON.stringify({ moduleRoots: 'shared' }));
    assert.throws(() => collectInputFiles(path.join(app, 'main.opu'), { root: app }), /moduleRoots must be an array of relative path strings/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('resolveImportPath rejects absolute and traversal paths with a single message', () => {
  const { base, app } = project();
  try {
    assert.throws(() => resolveImportPath('/tmp/x.opu', path.join(app, 'main.opu')), /may not be absolute or contain '\.\.'/);
    assert.throws(() => resolveImportPath('../../x.opu', path.join(app, 'main.opu')), /may not be absolute or contain '\.\.'/);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
