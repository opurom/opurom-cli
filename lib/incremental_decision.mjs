// Observable incremental-build decisions. No build step is skipped yet: this
// module only records which inputs are dirty and which steps would be skipped
// if the observed policy were enforced. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923-1016
//   (Stopwatch per node; PerformanceMeasurement records `skipped`)
// - packages/flutter_tools/lib/src/build_system/file_store.dart:162-230
//   (a dirty input invalidates dependent targets; missing files are dirty)
// Opurom adaptation: a deterministic report that separates observation from
// enforcement, so the decision can be proven stable before skipping work.

export const INCREMENTAL_DECISION_SCHEMA = 'opurom.incremental-decision/v1';

// Steps are still executed (enforcement: none). The decision only describes
// what a future enforcement policy could skip. With no dirty tracked input,
// every step is reported as would-skip; lower/postprocess would become safe
// once their own outputs are tracked in the file store.
export const INCREMENTAL_DECISION_FIELDS = Object.freeze([
  'schema', 'status', 'enforcement', 'dirty', 'skipped', 'steps', 'summary',
]);
const DETERMINISTIC_EXTRA_FIELDS = Object.freeze(['src', 'target', 'out', 'executedSteps']);

export function decideIncremental({ dirty = [], steps = [] } = {}) {
  if (!Array.isArray(dirty) || !Array.isArray(steps)) {
    throw new Error('dirty and steps must be arrays');
  }
  const dirtyList = [...new Set(dirty.map(String))].sort();
  const rows = steps.map((raw) => {
    const label = typeof raw === 'string' ? raw : raw?.label;
    const wouldSkip = dirtyList.length === 0;
    return {
      step: String(label),
      action: wouldSkip ? 'would-skip' : 'run',
      executed: true,
      reason: wouldSkip
        ? 'all tracked inputs clean; observation-only skip'
        : 'dirty tracked inputs require a rebuild',
    };
  });
  const skipped = rows.filter((row) => row.action === 'would-skip').map((row) => row.step);
  return {
    schema: INCREMENTAL_DECISION_SCHEMA,
    status: 'OBSERVED',
    enforcement: 'none',
    dirty: dirtyList,
    skipped,
    steps: rows,
    summary: {
      dirtyInputs: dirtyList.length,
      executed: rows.length,
      skipped: skipped.length,
    },
  };
}

export function formatIncrementalDecision(decision) {
  const lines = [
    'Opurom incremental decision (observation only)',
    `schema: ${decision.schema}`,
    `dirty (${decision.dirty.length}): ${decision.dirty.join(', ') || 'none'}`,
  ];
  lines.push(`skipped (proposed): ${decision.skipped.join(', ') || 'none'}`);
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
