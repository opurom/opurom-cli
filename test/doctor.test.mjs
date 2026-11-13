import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { collectDoctor, runDoctor } from '../lib/doctor.mjs';
import { tmpDir } from '../lib/paths.mjs';

// A doctor report must read the tree, never change it: a cargo build started
// here would make two runs over the same workspace disagree.
function stubCargo(base) {
  const log = path.join(base, 'cargo-invocations.log');
  fs.writeFileSync(
    path.join(base, 'cargo'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nprintf 'cargo 0.0.0-stub\\n'\n`,
    { mode: 0o755 },
  );
  return log;
}

function writeExecutable(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

function writeManifest(root, repo) {
  fs.mkdirSync(path.join(root, repo), { recursive: true });
  fs.writeFileSync(path.join(root, repo, 'Cargo.toml'), '[package]\nname = "stub"\n');
}

function withStubCargo(base, fn) {
  const previous = process.env.PATH;
  process.env.PATH = [base, previous].filter(Boolean).join(path.delimiter);
  try {
    return fn();
  } finally {
    process.env.PATH = previous;
  }
}

function rowNamed(rows, name) {
  const row = rows.find((entry) => entry.name === name);
  assert.ok(row, `no doctor row named ${name}`);
  return row;
}

test('doctor reports renderer and GPU availability identically across runs', () => {
  const base = tmpDir('doctor-bins-');
  const log = stubCargo(base);
  try {
    const root = path.join(base, 'workspace');
    writeManifest(root, 'opurom-render');
    writeManifest(root, 'opurom-gpu');
    const renderBin = path.join(root, 'opurom-render', 'target', 'debug', 'opurom-render');
    const gpuBin = path.join(root, 'opurom-gpu', 'target', 'debug', 'opurom-gpu');
    writeExecutable(renderBin);
    writeExecutable(gpuBin);

    const rows = withStubCargo(base, () => collectDoctor({ root, log: () => {} }));
    const render = rowNamed(rows, 'opurom-render');
    assert.equal(render.ok, true);
    assert.equal(render.detail, renderBin);
    const gpu = rowNamed(rows, 'opurom-gpu');
    assert.equal(gpu.ok, true);
    assert.equal(gpu.required, false);
    assert.equal(gpu.detail, gpuBin);
    assert.equal(gpu.hint, '');

    const second = withStubCargo(base, () => collectDoctor({ root, log: () => {} }));
    assert.deepEqual(second, rows);
    const invocations = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(invocations, /(^|\s)build\s/m, invocations);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('an unbuilt GPU backend is reported with a build hint and no build attempt', () => {
  const base = tmpDir('doctor-gpu-missing-');
  const log = stubCargo(base);
  try {
    const root = path.join(base, 'workspace');
    writeManifest(root, 'opurom-gpu');
    writeExecutable(path.join(root, 'opurom-render', 'target', 'debug', 'opurom-render'));

    const rows = withStubCargo(base, () => collectDoctor({ root, log: () => {} }));
    const gpu = rowNamed(rows, 'opurom-gpu');
    assert.equal(gpu.ok, false);
    assert.equal(gpu.required, false);
    assert.match(gpu.detail, /not built .*bench --compare/);
    assert.equal(gpu.hint, `cargo build --manifest-path ${path.join(root, 'opurom-gpu', 'Cargo.toml')}`);
    const invocations = fs.readFileSync(log, 'utf8');
    assert.doesNotMatch(invocations, /(^|\s)build\s/m, invocations);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('runDoctor prints the GPU row and its remediation hint', () => {
  const base = tmpDir('doctor-gpu-output-');
  const log = stubCargo(base);
  try {
    const root = path.join(base, 'workspace');
    writeManifest(root, 'opurom-gpu');
    writeExecutable(path.join(root, 'opurom-render', 'target', 'debug', 'opurom-render'));

    const lines = [];
    withStubCargo(base, () => runDoctor({ root, log: (line) => lines.push(String(line)) }));
    const gpuLine = lines.find((line) => line.includes('opurom-gpu'));
    assert.ok(gpuLine, lines.join('\n'));
    assert.match(gpuLine, /\[info\] opurom-gpu/);
    const hintLine = lines.find((line) => line.startsWith('         hint: cargo build'));
    assert.ok(hintLine, lines.join('\n'));
    assert.ok(hintLine.includes(path.join(root, 'opurom-gpu', 'Cargo.toml')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
