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

// The report rows look like this in the spec reporter and in the TAP one:
//   opurom.mjs          |  79.24 |    15.49 |  100.00 | 125 174 187-190
// The leading marker differs (the info sign or the TAP hash), so the parser
// accepts any single non-space prefix character.
const ROW = /^(?:[^\s]\s+)?(.+?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|(.*)$/;

export function parseCoverageReport(text) {
  const files = [];
  let all = null;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.includes('|')) continue;
    const match = ROW.exec(line.trim());
    if (!match) continue;
    const [, name, linePct, branchPct, funcPct, uncovered] = match;
    const entry = {
      file: name.trim(),
      line: Number(linePct),
      branch: Number(branchPct),
      functions: Number(funcPct),
      uncovered: uncovered.trim() ? uncovered.trim().split(/\s+/) : [],
    };
    if (!Number.isFinite(entry.line)) continue;
    if (entry.file === 'all files') all = entry;
    else files.push(entry);
  }
  return { files, all };
}

export function coverageDecision({ report, min = DEFAULT_MIN_LINE_PERCENT, scope = null }) {
  const measured = report.all?.line;
  if (!Number.isFinite(measured)) {
    return {
      status: 'FAIL',
      reason: 'the coverage report has no "all files" row',
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
  const passed = measured >= min && (scopeMean === null || scopeMean >= min);
  return {
    status: passed ? 'PASS' : 'FAIL',
    reason: passed ? null : `line coverage ${measured.toFixed(2)}% is below the ${min}% gate`,
    measured,
    scopeMean,
    min,
    below,
    files: report.files.length,
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
