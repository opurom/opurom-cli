import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { CLI_ROOT } from '../lib/paths.mjs';
import {
  defaultRegistry, exampleRows, expandCmd, formatExamples, loadRegistry, resolveJobs,
  resolveTool, runExampleTests, runPool, selectApps, summarize, validateRegistry,
} from '../lib/examples.mjs';

const SAMPLE_APPS = ['counter', 'profile', 'todo', 'showcase', 'gallery', 'calculator', 'photos'];

function fakeRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-registry-'));
  fs.writeFileSync(path.join(dir, 'ok.opu'), 'app Ok {}\n');
  fs.writeFileSync(path.join(dir, 'bad.opu'), 'app Bad {}\n');
  const data = {
    version: 1,
    apps: [
      {
        name: 'ok', source: 'ok.opu', required: true, targets: ['web'],
        tests: [
          { id: 'ok.one', cmd: ['node', '-e', 'process.exit(0)'], description: 'first passing command' },
          { id: 'ok.two', cmd: ['node', '-e', 'console.log("hello")'], description: 'second passing command' },
        ],
      },
      {
        name: 'bad', source: 'bad.opu', required: true, targets: ['web'],
        tests: [
          { id: 'bad.one', cmd: ['node', '-e', 'console.error("boom"); process.exit(2)'], description: 'failing command' },
        ],
      },
      {
        name: 'later', source: 'later.opu', required: false, reason: 'not written yet', targets: ['web'],
        tests: [
          { id: 'later.one', cmd: ['node', '-e', 'process.exit(0)'], description: 'planned command' },
          { id: 'later.two', cmd: ['node', '-e', 'process.exit(0)'], description: 'another planned command' },
        ],
      },
    ],
  };
  const file = path.join(dir, 'examples.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return { dir, file, data };
}

test('the shipped registry is valid and covers the planned apps', () => {
  const file = defaultRegistry();
  if (!fs.existsSync(file)) return; // sibling repo absent: unit suite stays standalone
  const data = loadRegistry(file);
  for (const name of SAMPLE_APPS) assert.ok(data.apps.some((app) => app.name === name), `missing app: ${name}`);
  for (const name of ['calculator', 'photos']) {
    assert.equal(data.apps.find((app) => app.name === name).source, `${name}.opu`);
  }
  const ids = data.apps.flatMap((app) => app.tests.map((entry) => entry.id));
  assert.equal(new Set(ids).size, ids.length, 'duplicate test id');
});

test('registry validation rejects malformed schemas', () => {
  const base = () => ({
    version: 1,
    apps: [{
      name: 'a', source: 'a.opu', required: true, targets: ['web'],
      tests: [{ id: 'a.one', cmd: ['node', '-e', '0'], description: 'a command' }],
    }],
  });
  assert.doesNotThrow(() => validateRegistry(base()));
  assert.throws(() => validateRegistry(null), /must be an object/);
  assert.throws(() => validateRegistry({ version: 2, apps: [] }), /unsupported version/);
  assert.throws(() => validateRegistry({ version: 1, apps: [] }), /non-empty array/);
  let data = base(); data.apps[0].name = '';
  assert.throws(() => validateRegistry(data), /needs a "name"/);
  data = base(); delete data.apps[0].required;
  assert.throws(() => validateRegistry(data), /"required" must be/);
  data = base(); data.apps[0].required = false;
  assert.throws(() => validateRegistry(data), /needs a "reason"/);
  data = base(); data.apps[0].targets = ['nosuch'];
  assert.throws(() => validateRegistry(data), /unknown target/);
  data = base(); data.apps[0].tests[0].cmd = [];
  assert.throws(() => validateRegistry(data), /"cmd" must be/);
  data = base(); data.apps[0].tests[0].description = '';
  assert.throws(() => validateRegistry(data), /needs a "description"/);
  data = base(); data.apps[0].tests.push({ ...data.apps[0].tests[0] });
  assert.throws(() => validateRegistry(data), /duplicate test id/);
  data = base(); data.apps.push({ ...data.apps[0] });
  assert.throws(() => validateRegistry(data), /duplicate app name/);
});

test('listing rows report source presence and test counts', () => {
  const { dir, file, data } = fakeRegistry();
  try {
    const rows = exampleRows(data, dir);
    assert.equal(rows[0].exists, true);
    assert.equal(rows[0].tests, 2);
    assert.equal(rows[2].exists, false);
    assert.equal(rows[2].sourcePath, path.join(dir, 'later.opu'));
    const out = formatExamples(rows, file);
    assert.match(out, /^app\s+source\s+tests  source$/m);
    assert.match(out, /^ok\s+ok\.opu\s+2  present$/m);
    assert.match(out, /^later\s+later\.opu\s+2  missing \(required: false\)$/m);
    assert.match(out, /3 apps, 5 tests \(2 sources present, 1 missing\)/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('filter selects matching app names', () => {
  const apps = [{ name: 'counter' }, { name: 'calculator' }, { name: 'todo' }];
  assert.equal(selectApps(apps, undefined).length, 3);
  assert.deepEqual(selectApps(apps, 'calc').map((app) => app.name), ['calculator']);
  assert.deepEqual(selectApps(apps, 'nope'), []);
});

test('jobs default is capped at 4 and explicit values are validated', () => {
  assert.equal(resolveJobs(undefined, 1), 1);
  assert.equal(resolveJobs(undefined, 2), 2);
  assert.equal(resolveJobs(undefined, 8), 4);
  assert.equal(resolveJobs('6', 2), 6);
  for (const value of ['0', '-1', '2.5', 'nope', true]) {
    assert.throws(() => resolveJobs(value), /invalid --jobs/);
  }
});

test('runPool never exceeds the jobs cap and drains every item', async () => {
  let active = 0;
  let max = 0;
  let done = 0;
  await runPool([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
    active++;
    max = Math.max(max, active);
    done++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
  });
  assert.equal(done, 8);
  assert.equal(max, 3);
});

test('summary math counts statuses, lists failures and sets the exit code', () => {
  const results = [
    { id: 'a', status: 'PASS' }, { id: 'b', status: 'FAIL' }, { id: 'c', status: 'SKIP' },
    { id: 'd', status: 'PASS' }, { id: 'e', status: 'FAIL' },
  ];
  assert.deepEqual(summarize(results), {
    passed: 2, failed: 2, skipped: 1, total: 5, failedIds: ['b', 'e'], exitCode: 1,
  });
  assert.equal(summarize([{ status: 'PASS' }, { status: 'SKIP' }]).exitCode, 0);
});

test('cmd placeholders and tool aliases resolve without machine paths', () => {
  assert.deepEqual(
    expandCmd(['opuromc', 'check', '{source}', '-o', '{tmp}/app.json'], { source: '/a/b.opu', tmp: '/t' }),
    ['opuromc', 'check', '/a/b.opu', '-o', '/t/app.json'],
  );
  assert.equal(resolveTool('node'), process.execPath);
});

test('runner reports PASS/FAIL/SKIP, the summary and the exit code', async () => {
  const { dir, file } = fakeRegistry();
  try {
    const lines = [];
    const result = await runExampleTests({ registry: file, jobs: 2, log: (line) => lines.push(line) });
    assert.equal(result.summary.passed, 2);
    assert.equal(result.summary.failed, 1);
    assert.equal(result.summary.skipped, 2);
    assert.deepEqual(result.summary.failedIds, ['bad.one']);
    assert.equal(result.exitCode, 1);
    const out = lines.join('\n');
    assert.match(out, /PASS {2}ok\.one\s+0\.\d+s {2}first passing command/);
    assert.match(out, /FAIL {2}bad\.one\s+0\.\d+s {2}failing command — exit 2: boom/);
    assert.match(out, /SKIP {2}later\.one.*source not present yet/);
    assert.match(out, /      boom/); // captured failure output
    assert.match(out, /tests passed: 2, failed: 1, skipped: 2, time \d+\.\ds/);
    assert.match(out, /failed tests:\n {2}bad\.one/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runner filter limits the tests and a no-match filter is not a failure', async () => {
  const { dir, file } = fakeRegistry();
  try {
    const filtered = await runExampleTests({ registry: file, filter: 'ok', log: () => {} });
    assert.equal(filtered.exitCode, 0);
    assert.deepEqual(filtered.results.map((result) => result.id).sort(), ['ok.one', 'ok.two']);
    const lines = [];
    const none = await runExampleTests({ registry: file, filter: 'nope', log: (line) => lines.push(line) });
    assert.equal(none.exitCode, 0);
    assert.deepEqual(none.results, []);
    assert.match(lines.join('\n'), /no tests matched filter: nope/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a required-but-missing source fails; --jobs is validated', async () => {
  const { dir, file } = fakeRegistry();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.apps = [{ name: 'gone', source: 'gone.opu', required: true, targets: ['web'],
      tests: [{ id: 'gone.one', cmd: ['node', '-e', 'process.exit(0)'], description: 'never runs' }] }];
    fs.writeFileSync(file, JSON.stringify(data));
    const result = await runExampleTests({ registry: file, log: () => {} });
    assert.equal(result.exitCode, 1);
    assert.equal(result.results[0].status, 'FAIL');
    assert.match(result.results[0].reason, /source missing/);
    await assert.rejects(() => runExampleTests({ registry: file, jobs: '0', log: () => {} }), /invalid --jobs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('opurom examples lists every registered sample app', () => {
  if (!fs.existsSync(defaultRegistry())) return;
  const bin = path.join(CLI_ROOT, 'bin', 'opurom.mjs');
  const result = spawnSync(process.execPath, [bin, 'examples'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const listed = new Set(result.stdout.trim().split('\n').map((line) => line.split(/\s+/)[0]));
  for (const name of SAMPLE_APPS) assert.ok(listed.has(name), `${name} missing from listing`);
  assert.match(result.stdout, /\d+ apps, \d+ tests/);
});
