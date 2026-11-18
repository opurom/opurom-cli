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

// Steps whose only input is tracked source. Lowering consumes the compiled IR
// and artifact post-processing consumes emitted files, so they stay required
// until those outputs also have recorded marks.
export const SOURCE_BOUND_STEPS = Object.freeze(['compile']);

export function decideIncremental({ dirty = [], steps = [] } = {}) {
  if (!Array.isArray(dirty) || !Array.isArray(steps)) {
    throw new Error('dirty and steps must be arrays');
  }
  const dirtyList = [...new Set(dirty.map(String))].sort();
  const rows = steps.map((raw) => {
    const label = typeof raw === 'string' ? raw : raw?.label;
    const wouldSkip = dirtyList.length === 0 && SOURCE_BOUND_STEPS.includes(label);
    return {
      step: String(label),
      action: wouldSkip ? 'would-skip' : 'run',
      executed: true,
      reason: wouldSkip
        ? 'all tracked inputs clean; source-bound step'
        : 'no clean-input skip policy for this step',
    };
  });
  return {
    schema: INCREMENTAL_DECISION_SCHEMA,
    status: 'OBSERVED',
    enforcement: 'none',
    dirty: dirtyList,
    steps: rows,
    summary: {
      dirtyInputs: dirtyList.length,
      executed: rows.length,
      wouldSkip: rows.filter((row) => row.action === 'would-skip').length,
    },
  };
}

export function formatIncrementalDecision(decision) {
  const lines = [
    'Opurom incremental decision (observation only)',
    `schema: ${decision.schema}`,
    `dirty (${decision.dirty.length}): ${decision.dirty.join(', ') || 'none'}`,
  ];
  for (const row of decision.steps) {
    lines.push(`  ${row.step}: ${row.action} (executed=${row.executed}) — ${row.reason}`);
  }
  lines.push(`result: ${decision.status}; enforcement: ${decision.enforcement}; executed ${decision.summary.executed} step(s), would skip ${decision.summary.wouldSkip}`);
  return `${lines.join('\n')}\n`;
}

export function incrementalDecisionJson(decision, extra = {}) {
  return `${JSON.stringify({ ...decision, ...extra }, null, 2)}\n`;
}
