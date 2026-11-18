// Tests for the Flutter source provenance contract gate.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'bin', 'flutter-provenance-contract.mjs');

function runGate(env = {}) {
  const run = spawnSync(process.execPath, [GATE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: '', ...env },
  });
  assert.equal(run.error, undefined);
  const json = JSON.parse(run.stdout);
  return { status: run.status, json };
}

const LOCAL_FLUTTER = process.env.OPUROM_FLUTTER_SRC
  ?? path.join(ROOT, '..', 'flutter-golden')
  ?? null;

test('the provenance gate verifies the pinned local Flutter tree and citations', {
  // CI checks out Flutter only in the dedicated provenance job. The whole
  // node-test matrix still runs the fail-closed drift test below.
  skip: !existsSync(path.join(LOCAL_FLUTTER, 'packages', 'flutter_test', 'lib', 'src', 'binding.dart')),
}, () => {
  const run = runGate();
  assert.equal(run.status, 0);
  assert.equal(run.json.schema, 'opurom.flutter-provenance-contract/v1');
  assert.equal(run.json.status, 'PASS');
  assert.equal(run.json.flutter.version, '3.50.0');
  assert.equal(run.json.flutter.goldenCommit, 'ab2912035e160d9cad6306df307576da6128ebdb');
  assert.equal(run.json.flutter.engineCommit, '371f77202a73e8dff57a8b3bff75bca55c090aee');
  assert.equal(run.json.contract.citationCount, 31);
  assert.equal(run.json.summary.total, 32);
  assert.equal(run.json.summary.fail, 0);
  assert.ok(run.json.checks.every((row) => row.status === 'PASS'));
});

test('the provenance gate fails closed when a cited source line is altered', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'opurom-provenance-gate-'));
  try {
    // Build a minimal fake Flutter tree with only the binding citation intact.
    const binding = path.join(dir, 'packages', 'flutter_test', 'lib', 'src');
    mkdirSync(binding, { recursive: true });
    const sourcePath = path.join(ROOT, '..', 'flutter-golden',
      'packages', 'flutter_test', 'lib', 'src', 'binding.dart');
    const source = existsSync(sourcePath)
      ? readFileSync(sourcePath, 'utf8')
      : 'line0\nline1\n/// 10 minutes for [AutomatedTestWidgetsFlutterBinding]\n';
    const lines = source.split('\n');
    lines[1326] = '/// citation drift';
    writeFileSync(path.join(binding, 'binding.dart'), lines.join('\n'));
    const run = runGate({ OPUROM_FLUTTER_SRC: dir });
    assert.equal(run.status, 1);
    assert.equal(run.json.status, 'FAIL');
    assert.ok(run.json.summary.fail >= 1);
    assert.ok(run.json.checks.some((row) => row.status === 'FAIL'
      && /source tree|binding\.dart/.test(row.name)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
