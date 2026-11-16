// Rule-for-rule mirror of the render-side frame budget state machine
// (opurom-render src/perf.rs): a rolling window of WINDOW_FRAMES integer
// samples evaluated once per window, integer nearest-rank percentiles
// ceil(percent * len / 100), a strict `p95 > target` degrade and a strict
// `p95 < target * PROMOTION_NUM/PROMOTION_DEN` promotion after
// PROMOTION_WINDOWS consecutive good windows. A neutral window resets the
// streak. No wall clock anywhere, so the page-agent tier is byte-comparable
// with the Rust decision; the golden vectors in test/fixtures pin the rules.

export const WINDOW_FRAMES = 20;
export const PROMOTION_WINDOWS = 3;
export const PROMOTION_NUM = 3;
export const PROMOTION_DEN = 4;
export const TIER_ORDER = ['full', 'reduced', 'minimal'];
export const TIERS = TIER_ORDER;

// Target frame time: 16 ms at 60 fps, 8 ms at 120 fps.
export function frameTargetMs(hz) {
  return hz === 120 ? 8 : 16;
}

// Nearest rank on ascending values: index `ceil(percent * len / 100)`, so the
// p95 of 20 samples is its 19th value.
export function nearestRank(sorted, percent) {
  if (sorted.length === 0) return 0;
  const position = Math.floor((percent * sorted.length + 99) / 100);
  return sorted[Math.min(Math.max(position, 1), sorted.length) - 1];
}

// Plain nearest rank for report percentiles: index `ceil(percent * len / 100)`
// without the division guard, matching consumer-side percentile helpers.
export function rankPercentile(sorted, percent) {
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil((percent * sorted.length) / 100) - 1];
}

export function percentiles(values) {
  const sorted = [...values].map((ms) => Math.max(0, Math.trunc(ms))).sort((a, b) => a - b);
  return { p50Ms: rankPercentile(sorted, 50), p95Ms: rankPercentile(sorted, 95) };
}

// Pure integer report over injected samples; the tier is carried, not
// recomputed (perf.rs perf_report).
export function perfReport(samples, tier) {
  const sorted = [...values(samples)].map((ms) => ms).sort((a, b) => a - b);
  const total = sorted.reduce((sum, ms) => sum + ms, 0);
  return { ...percentiles(sorted), fpsX10: total <= 0 ? 0 : Math.trunc((10000 * sorted.length) / total), tier };
}

function values(samples) {
  return [...samples].map((ms) => Math.max(0, Math.trunc(ms)));
}

// One stateful budget per measured stream. `push(frameMs, startMs)` injects
// one frame and returns the spec record shape with the tier decided by any
// window that just closed, so consumers never re-derive a tier.
export function createFrameTier({ hz = 60, startMs = 0 } = {}) {
  const budgetMs = frameTargetMs(hz);
  const promoteMs = Math.trunc((budgetMs * PROMOTION_NUM) / PROMOTION_DEN);
  let tierIndex = 0;
  let samples = [];
  let frames = 0;
  let goodWindows = 0;
  let seq = 0;
  const machine = {
    get tier() { return TIER_ORDER[tierIndex]; },
    budgetMs,
    push(frameMs, at) {
      const ms = Math.max(0, Math.trunc(Number(frameMs) || 0));
      if (samples.length === WINDOW_FRAMES) samples.shift();
      samples.push(ms);
      frames += 1;
      if (samples.length === WINDOW_FRAMES && frames % WINDOW_FRAMES === 0) machine.evaluate();
      const record = {
        seq,
        startMs: Math.max(0, Math.trunc(Number(at ?? startMs + seq) || 0)),
        frameMs: ms,
        budgetMs,
        phaseMs: null,
        tier: TIER_ORDER[tierIndex],
        nodes: null,
        effects: null,
      };
      seq += 1;
      return record;
    },
    evaluate() {
      const { p95Ms } = percentiles(samples);
      if (p95Ms > budgetMs) {
        tierIndex = Math.min(tierIndex + 1, TIER_ORDER.length - 1);
        goodWindows = 0;
      } else if (p95Ms < promoteMs && tierIndex !== 0) {
        goodWindows += 1;
        if (goodWindows >= PROMOTION_WINDOWS) {
          tierIndex = Math.max(tierIndex - 1, 0);
          goodWindows = 0;
        }
      } else {
        goodWindows = 0;
      }
    },
    report: () => ({ ...percentiles(samples), tier: TIER_ORDER[tierIndex] }),
    window: () => [...samples],
  };
  return machine;
}

// Tier-index view over the same machine for callers that only need the tier
// decision per injected frame (the injected page agent uses this form).
export function createFrameBudget({ targetMs = 16 } = {}) {
  const machine = createFrameTier({ hz: targetMs === 8 ? 120 : 60 });
  return {
    get tier() { return machine.tier; },
    targetMs: machine.budgetMs,
    push(durationMs) {
      machine.push(durationMs);
      return machine.tier;
    },
    evaluate: machine.evaluate,
    report: machine.report,
    window: machine.window,
  };
}
