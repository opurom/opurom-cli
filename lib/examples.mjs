// ctest-style example test runner. The registry is opurom-examples/examples.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ensureSiblingBinary, tmpDir, workspaceRoot } from './paths.mjs';
import { compilerPath } from './build.mjs';
import { BUILD_TARGETS } from './targets.mjs';

const TEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 512 * 1024;

export function defaultRegistry(root = workspaceRoot()) {
  return path.join(root, 'opurom-examples', 'examples.json');
}

export function validateRegistry(data, label = 'examples registry') {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label}: top level must be an object`);
  if (data.version !== 1) throw new Error(`${label}: unsupported version: ${data.version} (expected 1)`);
  if (!Array.isArray(data.apps) || !data.apps.length) throw new Error(`${label}: "apps" must be a non-empty array`);
  const names = new Set();
  const ids = new Set();
  data.apps.forEach((app, i) => {
    const at = `${label}: apps[${i}]`;
    if (!app || typeof app !== 'object' || Array.isArray(app)) throw new Error(`${at} must be an object`);
    if (typeof app.name !== 'string' || !app.name) throw new Error(`${at} needs a "name"`);
    if (names.has(app.name)) throw new Error(`${label}: duplicate app name: ${app.name}`);
    names.add(app.name);
    if (typeof app.source !== 'string' || !app.source) throw new Error(`${at} needs a "source"`);
    if (typeof app.required !== 'boolean') throw new Error(`${app.name}: "required" must be true or false`);
    if (!app.required && (typeof app.reason !== 'string' || !app.reason)) {
      throw new Error(`${app.name}: required:false needs a "reason"`);
    }
    if (!Array.isArray(app.targets) || !app.targets.length) throw new Error(`${app.name}: "targets" must be a non-empty array`);
    for (const target of app.targets) {
      if (!BUILD_TARGETS.includes(target)) throw new Error(`${app.name}: unknown target: ${target}`);
    }
    if (!Array.isArray(app.tests) || !app.tests.length) throw new Error(`${app.name}: "tests" must be a non-empty array`);
    app.tests.forEach((entry, j) => {
      const where = `${app.name}.tests[${j}]`;
      if (typeof entry?.id !== 'string' || !entry.id) throw new Error(`${where} needs an "id"`);
      if (ids.has(entry.id)) throw new Error(`${label}: duplicate test id: ${entry.id}`);
      ids.add(entry.id);
      if (!Array.isArray(entry.cmd) || !entry.cmd.length || entry.cmd.some((arg) => typeof arg !== 'string')) {
        throw new Error(`${entry.id}: "cmd" must be a non-empty array of strings`);
      }
      if (typeof entry.description !== 'string' || !entry.description) {
        throw new Error(`${entry.id} needs a "description"`);
      }
    });
  });
  return data;
}

export function loadRegistry(file) {
  if (!fs.existsSync(file)) throw new Error(`examples registry not found: ${file}`);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid examples registry JSON in ${file}: ${error.message}`);
  }
  return validateRegistry(data, file);
}

export function exampleRows(data, registryDir) {
  return data.apps.map((app) => {
    const sourcePath = path.resolve(registryDir, app.source);
    return {
      name: app.name,
      source: app.source,
      sourcePath,
      targets: app.targets,
      tests: app.tests.length,
      exists: fs.existsSync(sourcePath),
      required: app.required,
    };
  });
}

export function formatExamples(rows, registryFile) {
  const nameW = Math.max(4, ...rows.map((row) => row.name.length));
  const srcW = Math.max(6, ...rows.map((row) => row.source.length));
  const lines = [
    `OPUROM examples registry: ${registryFile}`,
    `${'app'.padEnd(nameW)}  ${'source'.padEnd(srcW)}  tests  source`,
  ];
  for (const row of rows) {
    const presence = row.exists ? 'present' : (row.required ? 'missing' : 'missing (required: false)');
    lines.push(`${row.name.padEnd(nameW)}  ${row.source.padEnd(srcW)}  ${String(row.tests).padStart(5)}  ${presence}`);
  }
  const tests = rows.reduce((sum, row) => sum + row.tests, 0);
  const present = rows.filter((row) => row.exists).length;
  lines.push(`${rows.length} apps, ${tests} tests (${present} sources present, ${rows.length - present} missing)`);
  return lines.join('\n');
}

export function examplesList({ root = workspaceRoot(), registry = defaultRegistry(root), log = console.log } = {}) {
  const data = loadRegistry(registry);
  const rows = exampleRows(data, path.dirname(registry));
  log(formatExamples(rows, registry));
  return rows;
}

export function selectApps(apps, filter) {
  return filter ? apps.filter((app) => app.name.includes(String(filter))) : apps;
}

export function resolveJobs(value, cpus = os.cpus().length) {
  if (value === undefined) return Math.max(1, Math.min(4, cpus));
  const jobs = Number(value);
  if (value === true || !Number.isInteger(jobs) || jobs < 1) {
    throw new Error(`invalid --jobs: ${value} (expected an integer >= 1)`);
  }
  return jobs;
}

// Tool aliases keep the registry free of machine-specific binary paths.
export function resolveTool(token, root = workspaceRoot()) {
  if (token === 'node') return process.execPath;
  if (token === 'opuromc') return compilerPath({ root, log: () => {} });
  if (token === 'opurom-render') {
    const found = ensureSiblingBinary('opurom-render', ['opurom-render', 'opurom_render'], { root });
    if (!found.path) throw new Error(`opurom-render unavailable: ${found.reason}`);
    return found.path;
  }
  return token.includes('/') ? path.resolve(root, token) : token;
}

export function expandCmd(cmd, { source, tmp }) {
  return cmd.map((arg) => String(arg).replaceAll('{source}', source).replaceAll('{tmp}', tmp));
}

export function runPool(items, jobs, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  return Promise.all(runners);
}

export function summarize(results) {
  const failedIds = results.filter((result) => result.status === 'FAIL').map((result) => result.id);
  return {
    passed: results.filter((result) => result.status === 'PASS').length,
    failed: failedIds.length,
    skipped: results.filter((result) => result.status === 'SKIP').length,
    total: results.length,
    failedIds,
    exitCode: failedIds.length ? 1 : 0,
  };
}

function exec(cmd, args, { cwd, timeout }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ status: null, stdout, stderr: `${stderr}\ntimed out after ${timeout} ms`, timedOut: true });
    }, timeout);
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_OUTPUT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < MAX_OUTPUT) stderr += chunk; });
    child.on('error', (error) => finish({ status: 1, stdout, stderr: `${stderr}${error.message}` }));
    child.on('close', (status) => finish({ status: status ?? 1, stdout, stderr }));
  });
}

function resolveTools(tests, root) {
  const tools = new Map();
  for (const test of tests) {
    const token = test.cmd[0];
    if (tools.has(token)) continue;
    try {
      tools.set(token, { cmd: resolveTool(token, root) });
    } catch (error) {
      tools.set(token, { error: error.message });
    }
  }
  return tools;
}

async function runOne(test, { source, tmp, root, tools }) {
  const started = performance.now();
  const base = { id: test.id, description: test.description, output: '' };
  const tool = tools.get(test.cmd[0]);
  if (tool.error) {
    return { ...base, status: 'SKIP', ms: 0, reason: `tool unavailable: ${tool.error}` };
  }
  try {
    const result = await exec(tool.cmd, expandCmd(test.cmd.slice(1), { source, tmp }), {
      cwd: root, timeout: TEST_TIMEOUT_MS,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    const ms = performance.now() - started;
    if (result.status === 0) return { ...base, status: 'PASS', ms, output };
    const first = output.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
    return {
      ...base, status: 'FAIL', ms, output,
      reason: `exit ${result.status}${result.timedOut ? ' (timeout)' : ''}: ${first || 'no output'}`,
    };
  } catch (error) {
    return { ...base, status: 'FAIL', ms: performance.now() - started, reason: `failed to run: ${error.message}` };
  }
}

function firstLines(text, count = 10) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const shown = lines.slice(0, count).map((line) => `      ${line}`);
  if (lines.length > count) shown.push(`      ... (${lines.length - count} more lines)`);
  return shown.join('\n');
}

function statusLine(result, idWidth) {
  const seconds = (result.ms / 1000).toFixed(2);
  const detail = result.status === 'SKIP' ? result.reason
    : result.status === 'FAIL' ? `${result.description} — ${result.reason}`
      : result.description;
  return `${result.status}  ${result.id.padEnd(idWidth)}  ${seconds}s  ${detail}`;
}

export async function runExampleTests({
  root = workspaceRoot(), registry = defaultRegistry(root), filter, jobs,
  verbose = false, log = console.log,
} = {}) {
  const data = loadRegistry(registry);
  const registryDir = path.dirname(registry);
  const apps = selectApps(data.apps, filter);
  const plan = apps.flatMap((app) => app.tests.map((test) => test));
  const concurrency = resolveJobs(jobs);
  const idWidth = Math.max(4, ...plan.map((test) => test.id.length));
  log('OPUROM example tests (ctest-style)');
  const counts = `${apps.length} app${apps.length === 1 ? '' : 's'}, ${plan.length} test${plan.length === 1 ? '' : 's'}`;
  log(`registry: ${registry} (${counts})${filter ? ` [filter: ${filter}]` : ''}`);
  log(`jobs: ${concurrency}`);
  log('');
  const results = new Array(plan.length);
  const started = performance.now();
  if (plan.length) {
    const tools = resolveTools(plan, root);
    const emit = (index, result) => {
      results[index] = result;
      log(statusLine(result, idWidth));
      if (result.output && (verbose || result.status === 'FAIL')) log(firstLines(result.output));
    };
    let next = 0;
    const appPlans = apps.map((app) => ({ app, indices: app.tests.map(() => next++) }));
    // Apps run in parallel; an app's tests run in registry order so render can
    // consume the IR its compile test wrote into the same temp dir.
    await runPool(appPlans, concurrency, async ({ app, indices }) => {
      const source = path.resolve(registryDir, app.source);
      if (!fs.existsSync(source)) {
        const reason = app.required
          ? `source missing: ${source}`
          : `source not present yet: ${source} (${app.reason})`;
        app.tests.forEach((test, i) => emit(indices[i], {
          id: test.id, status: app.required ? 'FAIL' : 'SKIP', ms: 0,
          description: test.description, reason, output: '',
        }));
        return;
      }
      const tmp = tmpDir('examples-');
      try {
        for (let i = 0; i < app.tests.length; i++) {
          emit(indices[i], await runOne(app.tests[i], { source, tmp, root, tools }));
        }
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
  } else {
    log(`no tests matched filter: ${filter}`);
  }
  const seconds = (performance.now() - started) / 1000;
  const filled = results.filter(Boolean);
  const summary = summarize(filled);
  log('');
  log(`tests passed: ${summary.passed}, failed: ${summary.failed}, skipped: ${summary.skipped}, time ${seconds.toFixed(1)}s`);
  if (summary.failed) {
    log('failed tests:');
    for (const id of summary.failedIds) log(`  ${id}`);
  }
  return { results: filled, summary, seconds, exitCode: summary.exitCode };
}
