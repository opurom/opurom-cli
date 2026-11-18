// Build timing records for the Opurom CLI. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/build_system/build_system.dart:923,1016,1045-1057
//   (a Stopwatch per build target yields PerformanceMeasurement with target,
//   elapsedMilliseconds, skipped, succeeded and analyticsName)
// - packages/flutter_tools/lib/src/build_info.dart:186,436,459-460
//   (a performance measurement file is an explicit build artifact)
// Opurom adaptation: CLI build steps are the target names; timings are plain
// JSON written next to the artifact only when requested.

export const BUILD_TIMINGS_SCHEMA = 'opurom.build-timings/v1';

export function createTimer(now = () => process.hrtime.bigint()) {
  if (typeof now !== 'function') throw new Error('createTimer needs a clock');
  return {
    now,
    measure(label, work) {
      const start = now();
      let succeeded = false;
      try {
        const result = work();
        succeeded = true;
        return result;
      } finally {
        const end = now();
        const ns = Number(end - start);
        if (!Number.isFinite(ns) || ns < 0) throw new Error('timer clock moved backwards');
        this.last = {
          target: label,
          elapsedMilliseconds: Number((ns / 1e6).toFixed(3)),
          skipped: false,
          succeeded,
        };
        this.rows.push(this.last);
      }
    },
    rows: [],
    last: null,
  };
}

export function formatBuildTimings(rows) {
  const totalMs = Number(rows.reduce((sum, row) => sum + row.elapsedMilliseconds, 0).toFixed(3));
  const lines = [
    'Opurom build timings (measured on this host)',
    `schema: ${BUILD_TIMINGS_SCHEMA}`,
    ...rows.map((row) => `  ${row.target}: ${row.elapsedMilliseconds}ms (${row.succeeded ? 'succeeded' : 'failed'}${row.skipped ? ', skipped' : ''})`),
    `total: ${totalMs}ms across ${rows.length} step${rows.length === 1 ? '' : 's'}`,
  ];
  return `${lines.join('\n')}\n`;
}

export function buildTimingsJson(rows, extra = {}) {
  return `${JSON.stringify({
    schema: BUILD_TIMINGS_SCHEMA,
    steps: rows,
    totalMs: Number(rows.reduce((sum, row) => sum + row.elapsedMilliseconds, 0).toFixed(3)),
    ...extra,
  }, null, 2)}\n`;
}
