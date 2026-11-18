// OPUROM quality profile resolution shared by the CLI commands.
// Product quality is the default for normal build/dev/serve/export flows;
// degraded rendering is only reachable through explicit flags.
//
// The CLI never changes the IR itself: it records the requested profile in the
// build environment so compile/lower/render stages can apply the same policy.
// Compat keeps the historical golden digest path and is opt-in only.

export const QUALITY_PROFILES = Object.freeze(['product', 'compat']);

export const QUALITY_DEFINES = Object.freeze({
  quality: 'Quality',
  legacyGolden: 'LegacyGolden',
  noMotion: 'Motion',
  lowPower: 'LowPower',
  edgeAa: 'EdgeAA',
  fontMetrics: 'FontMetrics',
});

function explicit(value) {
  return value !== undefined && value !== false && value !== '';
}

/// Resolves the requested quality profile from parsed CLI flags.
/// Unknown or conflicting requests fail closed instead of silently degrading.
export function resolveQualityOptions(flags = {}) {
  const quality = explicit(flags.quality) ? String(flags.quality) : 'product';
  if (!QUALITY_PROFILES.includes(quality)) {
    throw new Error(`invalid --quality: ${quality} (expected ${QUALITY_PROFILES.join(', ')})`);
  }
  const fontMetrics = explicit(flags['font-metrics']) ? String(flags['font-metrics']) : null;
  if (fontMetrics !== null && !['fixed', 'proportional'].includes(fontMetrics)) {
    throw new Error(`invalid --font-metrics: ${fontMetrics} (expected fixed, proportional)`);
  }
  const edgeFlag = flags['edge-aa'];
  if (explicit(edgeFlag) && !['true', '1', 'on', 'false', '0', 'off'].includes(String(edgeFlag))) {
    throw new Error(`invalid --edge-aa: ${edgeFlag} (expected a boolean flag)`);
  }
  const edgeAa = explicit(edgeFlag)
    ? ['true', '1', 'on'].includes(String(edgeFlag))
    : quality === 'product';
  const legacyGolden = explicit(flags['legacy-golden']);
  const noMotion = explicit(flags['no-motion']);
  const lowPower = explicit(flags['low-power']);
  if (quality === 'compat' && fontMetrics && fontMetrics !== 'fixed') {
    throw new Error('--font-metrics proportional is incompatible with --quality compat');
  }
  if (quality === 'compat' && edgeAa && explicit(edgeFlag)) {
    throw new Error('--edge-aa is incompatible with --quality compat');
  }
  if (legacyGolden && quality !== 'compat') {
    throw new Error('--legacy-golden requires --quality compat');
  }
  // Explicit font metrics win; otherwise product uses proportional metrics and
  // compat keeps fixed metrics. Always emit the value so downstream stages see
  // one deterministic default without parsing the profile name.
  const effectiveFontMetrics = fontMetrics ?? (quality === 'product' ? 'proportional' : 'fixed');
  const defines = [
    `${QUALITY_DEFINES.quality}=${quality}`,
    `${QUALITY_DEFINES.legacyGolden}=${legacyGolden}`,
    `${QUALITY_DEFINES.noMotion}=${noMotion}`,
    `${QUALITY_DEFINES.lowPower}=${lowPower}`,
    `${QUALITY_DEFINES.edgeAa}=${edgeAa}`,
    `${QUALITY_DEFINES.fontMetrics}=${effectiveFontMetrics}`,
  ];
  return {
    profile: quality,
    edgeAa,
    fontMetrics: effectiveFontMetrics,
    legacyGolden,
    noMotion,
    lowPower,
    defines,
    degraded: quality === 'compat' || legacyGolden || noMotion || lowPower || !edgeAa || fontMetrics === 'fixed',
  };
}

/// Quality defines are compile-time values, so they travel with the environment.
export function qualityEnv(options) {
  const env = {};
  for (const define of options.defines) {
    const index = define.indexOf('=');
    env[`OPR_DEFINE_${define.slice(0, index)}`] = define.slice(index + 1);
  }
  env.OPR_QUALITY_PROFILE = options.profile;
  return env;
}

/// Stable one-line report used by build/dev/serve/export summaries.
export function describeQuality(options) {
  const label = options.degraded ? 'degraded' : 'product';
  return `quality=${options.profile} tier=${label} edge-aa=${options.edgeAa} font-metrics=${options.fontMetrics} motion=${options.noMotion ? 'off' : 'on'} power=${options.lowPower ? 'low' : 'full'}`;
}
