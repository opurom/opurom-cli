// Static quality gate for Opurom projects. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/commands/analyze.dart:25-105 (one command,
//   current-package, machine output, write-to-file)
// - packages/flutter_tools/lib/src/commands/analyze_base.dart:66-82 (dumpErrors),
//   97-122 (generateErrorsMessage "No issues found!" / "N issues found")
// - packages/flutter_tools/lib/src/commands/validate_project.dart:16-100
//   (per-validator results, machine map, non-zero on crash)
// Opurom adaptation: the analyzer is the real `opuromc check`; the gate adds
// project-level rules Flutter gets from the analyzer (unused imports are not
// re-implemented here — they stay compiler diagnostics).

import fs from 'node:fs';
import path from 'node:path';
import { compilerPath, projectMain } from './build.mjs';
import { workspaceRoot } from './paths.mjs';
import { run } from './proc.mjs';

const SOURCE_EXTS = new Set(['.opu']);

export function discoverSources(dir, { followLinks = false } = {}) {
  const root = path.resolve(dir);
  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'tmp') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (followLinks || !entry.isSymbolicLink()) walk(full);
      } else if (SOURCE_EXTS.has(path.extname(entry.name))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

export function projectEntry(dir) {
  const resolved = path.resolve(dir);
  const main = path.join(resolved, 'main.opu');
  if (fs.existsSync(main)) return { project: resolved, entry: main, useProject: true };
  return { project: resolved, entry: null, useProject: false };
}

// One source file per opuromc check call, mirroring `dart analyze` file scope.
export function analyzeSources({ files, root = workspaceRoot(), env = process.env, environment = null, buildInfo = null, log = () => {} } = {}) {
  const opuromc = compilerPath({ root, log });
  const rows = [];
  for (const file of files) {
    const args = ['check', path.resolve(file)];
    if (environment) args.push('--dart-define', `Environment=${environment.name}`);
    if (buildInfo) {
      args.push('--dart-define', `BuildMode=${buildInfo.mode}`);
      if (buildInfo.target) args.push('--dart-define', `TargetFile=${buildInfo.target}`);
    }
    const result = run(opuromc, args, { env, timeout: 60000 });
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    rows.push({
      file: path.resolve(file),
      ok: result.status === 0,
      status: result.status === 0 ? 'pass' : 'error',
      detail,
    });
  }
  return rows;
}

export function formatAnalyzeRows(rows) {
  return rows.map((row) => row.ok
    ? `[pass] ${row.file}`
    : `[error] ${row.file}\n${row.detail.split('\n').map((line) => `       ${line}`).join('\n')}`);
}

export function analyzeSummary(rows, seconds) {
  const failed = rows.filter((row) => !row.ok);
  const head = failed.length
    ? `${failed.length} issue${failed.length === 1 ? '' : 's'} found.`
    : 'No issues found!';
  return `${head} analyzed ${rows.length} file${rows.length === 1 ? '' : 's'} (ran in ${seconds}s)`;
}

export function analyzeMachine(rows, seconds) {
  return JSON.stringify({
    schema: 'opurom.analyze/v1',
    files: rows.length,
    issues: rows.filter((row) => !row.ok).length,
    seconds,
    rows: rows.map((row) => ({ file: row.file, status: row.status, detail: row.detail })),
  }, null, 2);
}

export function analyze({
  path: targetPath = process.cwd(), root = workspaceRoot(), env = process.env,
  environment = null, buildInfo = null, machine = false, write = null, log = console.log,
} = {}) {
  const startedAt = process.hrtime.bigint();
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) throw new Error(`no such file or directory: ${resolved}`);
  const files = fs.statSync(resolved).isDirectory()
    ? discoverSources(resolved)
    : [resolved];
  if (!files.length) throw new Error(`no .opu sources under ${resolved}`);
  const rows = analyzeSources({ files, root, env, environment, buildInfo, log });
  const seconds = (Number(process.hrtime.bigint() - startedAt) / 1e9).toFixed(1);
  if (write) {
    const text = machine ? analyzeMachine(rows, seconds) : `${formatAnalyzeRows(rows).join('\n')}\n${analyzeSummary(rows, seconds)}\n`;
    fs.writeFileSync(path.resolve(write), text);
    log(`analysis written to ${path.resolve(write)}`);
  }
  if (machine) {
    // Flutter machine output replaces the human text (analyze.dart:81
    // addMachineOutputFlag), so the JSON must be the only stdout payload.
    log(analyzeMachine(rows, seconds));
  } else {
    log(formatAnalyzeRows(rows).join('\n'));
    log(analyzeSummary(rows, seconds));
  }
  return { rows, issues: rows.filter((row) => !row.ok).length, files: rows.length, seconds };
}
