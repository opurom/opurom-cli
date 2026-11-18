#!/usr/bin/env node
// Coverage gate command: run the repository's Node suites with the built-in
// reporter, enforce the 80% line threshold and print a stable JSON result.
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_MIN_LINE_PERCENT, coverageDecision, runCoverage,
} from '../lib/coverage_gate.mjs';

const CLI_ROOT = fileURLToPath(new URL('../', import.meta.url));

const minimum = process.env.OPUROM_COVERAGE_MIN
  ? Number(process.env.OPUROM_COVERAGE_MIN) : DEFAULT_MIN_LINE_PERCENT;
if (!Number.isFinite(minimum) || minimum < 0 || minimum > 100) {
  console.error(`invalid OPUROM_COVERAGE_MIN: ${process.env.OPUROM_COVERAGE_MIN}`);
  process.exit(2);
}

const { report, output } = runCoverage({ cwd: CLI_ROOT, log: () => {} });
const decision = coverageDecision({ report, min: minimum });
process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`);
if (process.env.OPUROM_COVERAGE_VERBOSE === '1') process.stderr.write(output);
process.exit(decision.status === 'PASS' ? 0 : 1);
