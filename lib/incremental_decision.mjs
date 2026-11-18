// Incremental-build decisions: observation by default, enforcement only when
// explicitly requested. Observation records which inputs are dirty and which
// steps would be skipped; enforcement actually skips those steps and exposes
// a full-rebuild fallback for errors. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923-1016
//   (Stopwatch per node; PerformanceMeasurement records `skipped`)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (a dirty input invalidates dependent targets; missing files are dirty)
// Opurom adaptation: a deterministic report separating observation from
// enforcement. Observation stays the default so the policy can be proven
// byte-stable; enforcement is opt-in and still builds from a clean cache on
// the first run or after any error.

export const INCREMENTAL_DECISION_SCHEMA = 'opurom.incremental-decision/v1';

// Observation executes every step (`enforcement: none`). Enforcement
// (`enforcement: enforced`) skips steps only when all tracked inputs and
// outputs are clean and a complete prior build is recorded.
export const INCREMENTAL_ENFORCEMENT = Object.freeze(['none', 'enforced']);
export const INCREMENTAL_DECISION_FIELDS = Object.freeze([
  'schema', 'status', 'enforcement', 'dirty', 'skipped', 'steps', 'summary',
]);
const DETERMINISTIC_EXTRA_FIELDS = Object.freeze([
  'src', 'target', 'out', 'executedSteps', 'lastExecutedSteps',
]);

export function decideIncremental({ dirty = [], steps = [], enforcement = 'none' } = {}) {
  if (!Array.isArray(dirty) || !Array.isArray(steps)) {
    throw new Error('dirty and steps must be arrays');
  }
  if (!INCREMENTAL_ENFORCEMENT.includes(enforcement)) {
    throw new Error(`invalid incremental enforcement: ${enforcement}`);
  }
  const enforced = enforcement === 'enforced';
  const dirtyList = [...new Set(dirty.map(String))].sort();
  const skip = enforced && dirtyList.length === 0;
  const rows = steps.map((raw) => {
    const label = typeof raw === 'string' ? raw : raw?.label;
    return {
      step: String(label),
      action: skip ? 'skipped' : 'run',
      executed: !skip,
      reason: skip
        ? 'all tracked inputs clean; enforced skip from recorded build'
        : enforced
          ? 'dirty tracked inputs require a rebuild'
          : 'all tracked inputs clean; observation-only skip',
    };
  });
  // Observation keeps `would-skip` for the stable report contract; enforcement
  // marks the same clean decision as actually skipped.
  if (!enforced && dirtyList.length === 0) {
    for (const row of rows) {
      row.action = 'would-skip';
      row.reason = 'all tracked inputs clean; observation-only skip';
    }
  }
  const skipped = rows.filter((row) => row.action === 'skipped' || row.action === 'would-skip')
    .map((row) => row.step);
  return {
    schema: INCREMENTAL_DECISION_SCHEMA,
    status: enforced ? 'ENFORCED' : 'OBSERVED',
    enforcement,
    dirty: dirtyList,
    skipped,
    steps: rows,
    summary: {
      dirtyInputs: dirtyList.length,
      executed: !enforced ? rows.length : rows.filter((row) => row.executed).length,
      skipped: skipped.length,
    },
  };
}

export function formatIncrementalDecision(decision) {
  const enforced = decision.enforcement === 'enforced';
  const lines = [
    `Opurom incremental decision (${enforced ? 'enforcement' : 'observation only'})`,
    `schema: ${decision.schema}`,
    `dirty (${decision.dirty.length}): ${decision.dirty.join(', ') || 'none'}`,
  ];
  lines.push(`skipped (${enforced ? 'actual' : 'proposed'}): ${decision.skipped.join(', ') || 'none'}`);
  for (const row of decision.steps) {
    lines.push(`  ${row.step}: ${row.action} (executed=${row.executed}) — ${row.reason}`);
  }
  lines.push(`result: ${decision.status}; enforcement: ${decision.enforcement}; executed ${decision.summary.executed} step(s), proposed skip ${decision.summary.skipped}`);
  return `${lines.join('\n')}\n`;
}

export function incrementalDecisionJson(decision, extra = {}) {
  const record = {};
  for (const field of INCREMENTAL_DECISION_FIELDS) record[field] = decision[field];
  for (const field of DETERMINISTIC_EXTRA_FIELDS) {
    if (extra[field] !== undefined) record[field] = extra[field];
  }
  const unknown = Object.keys(extra).filter((field) => !DETERMINISTIC_EXTRA_FIELDS.includes(field));
  if (unknown.length) {
    throw new Error(`non-deterministic incremental report field: ${unknown.join(', ')}`);
  }
  return `${JSON.stringify(record, null, 2)}\n`;
}
