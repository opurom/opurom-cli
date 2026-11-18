// Coverage gate for the Node suites.
//
// The gate reads the report Node itself prints with
// `node --test --experimental-test-coverage` and turns it into a decision.
// Node's built-in report is the authority for the numbers (the same report
// `node --test --experimental-test-coverage` prints), so no third-party
// coverage tool is added to a zero-dependency repository.
//
// Flutter authority for the gate shape: Flutter's own coverage work is a
// hard threshold that fails the build, not a report that only informs
// (dev/benchmarks and dev/devicelab treat a threshold miss as a failed
// task). The Opurom contract follows that: below the threshold the command
// exits non-zero so CI blocks the merge.
import { spawnSync } from 'node:child_process';

export const DEFAULT_MIN_LINE_PERCENT = 80;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// The report rows look like this in the spec reporter and in the TAP one:
//   opurom.mjs          |  79.24 |    15.49 |  100.00 | 125 174 187-190
// The leading marker differs (the info sign or the TAP hash), so the parser
// accepts any single non-space prefix character.
const ROW = /^(?:[^\s]\s+)?(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|(.*)$/;

export function parseCoverageReport(text) {
  const files = [];
  const external = [];
  let all = null;
  let inExternalTree = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.includes('|')) continue;
    const match = ROW.exec(line.trim());
    if (!match) continue;
    const [, name, linePct, branchPct, funcPct, uncovered] = match;
    const trimmed = name.trim();
    // Node groups sibling repositories under a `..` section. Their files are
    // printed without that prefix, so track the section header explicitly.
    if (/^\.\.$/.test(trimmed)) {
      inExternalTree = true;
      continue;
    }
    if (!/^\d+(?:\.\d+)?$/.test(linePct.trim())) continue; // header/name row
    const entry = {
      file: trimmed,
      line: Number(linePct),
      branch: Number(branchPct),
      functions: Number(funcPct),
      uncovered: uncovered.trim() ? uncovered.trim().split(/\s+/) : [],
    };
    if (entry.file === 'all files') all = entry;
    // A sibling repository has its own CI and its own owner; counting it in
    // this repo's denominator would violate the one-bot-one-repo boundary.
    else if (inExternalTree || entry.file.startsWith('..')) external.push(entry);
    else files.push(entry);
  }
  return { files, external, all };
}

// Line mean over files owned by this repository. Node's "all files" row
// includes sibling modules loaded by child processes, so it is not the
// authoritative number for a one-repo gate.
export function repositoryCoverage(report) {
  if (!report.files?.length) return null;
  const sum = report.files.reduce((total, file) => total + file.line, 0);
  return Number((sum / report.files.length).toFixed(2));
}

export function coverageDecision({ report, min = DEFAULT_MIN_LINE_PERCENT, scope = null }) {
  if (!finite(min) || min < 0 || min > 100) {
    return {
      status: 'FAIL',
      reason: `invalid coverage threshold: ${String(min)}`,
      measured: null,
      min,
    };
  }
  const measured = repositoryCoverage(report);
  if (!Number.isFinite(measured)) {
    return {
      status: 'FAIL',
      reason: 'the coverage report has no repository-owned files',
      measured: null,
      min,
    };
  }
  const below = report.files
    .filter((file) => Number.isFinite(file.line) && file.line < min)
    .map((file) => ({ file: file.file, line: file.line }));
  const scoped = scope
    ? report.files.filter((file) => file.file.startsWith(scope))
    : report.files;
  const scopeMean = scoped.length
    ? scoped.reduce((sum, file) => sum + file.line, 0) / scoped.length
    : null;
  const belowTotal = measured < min;
  const belowScope = scopeMean !== null && scopeMean < min;
  const reason = belowTotal
    ? `line coverage ${measured.toFixed(2)}% is below the ${min}% gate`
    : belowScope
      ? `scoped coverage ${scopeMean.toFixed(2)}% is below the ${min}% gate`
      : null;
  const passed = reason === null;
  return {
    status: passed ? 'PASS' : 'FAIL',
    reason,
    measured,
    scopeMean,
    min,
    below,
    files: report.files.length,
    externalFiles: report.external?.length ?? 0,
    nodeAll: report.all?.line ?? null,
  };
}

// Runs the Node suite with the built-in coverage reporter and returns the
// parsed report plus the raw output, so a caller can archive both.
export function runCoverage({ cwd, args = ['--test'], env = process.env, log = () => {} } = {}) {
  const childEnv = { ...env, NODE_V8_COVERAGE: '' };
  // A nested `node --test` inherits NODE_TEST_CONTEXT and would skip every
  // test file, leaving no coverage rows. Clear it for a clean reporter run.
  delete childEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, [...args, '--experimental-test-coverage'], {
    cwd,
    encoding: 'utf8',
    env: childEnv,
  });
  const output = `${run.stdout || ''}${run.stderr || ''}`;
  const report = parseCoverageReport(output);
  log(`coverage: ${report.all ? `${report.all.line.toFixed(2)}%` : 'no report'}`);
  return { report, output, status: run.status };
}
