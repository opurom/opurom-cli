// Plugin marketplace metadata validation and offline index.
// Flutter authority (3.50.0, flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb,
// vendored pubspec_parse 1.6.0 from the pinned pub cache):
// - .pub-cache/hosted/pub.dev/pubspec_parse-1.6.0/lib/src/pubspec.dart:14-80
//   (Pubspec requires a name and declares version, environment, dependencies,
//   devDependencies, dependencyOverrides)
// - .pub-cache/hosted/pub.dev/pubspec_parse-1.6.0/lib/src/dependency.dart:10-78
//   (a dependency is either a version constraint string or one source map;
//   more than one source is invalid)
// - .pub-cache/hosted/pub.dev/pubspec_parse-1.6.0/lib/src/semver.dart (via
//   pub_semver): caret ^x.y.z means >=x.y.z <next-breaking; prereleases need
//   an explicit same-core comparator; `any` accepts prereleases
// Opurom adaptation: the registry manifest stays JSON (opurom.json /
// opurom.lock) because IR remains the single source of truth; this library
// validates marketplace metadata and resolves one consistent version per
// package from an offline index, with no network and no runtime interpreter.

import fs from 'node:fs';
import path from 'node:path';

export const PLUGIN_INDEX_SCHEMA = 'opurom.plugin-index/v1';
export const PLUGIN_REPORT_SCHEMA = 'opurom.plugin-report/v1';

const NAME_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_RE.exec(value);
  if (!match) return null;
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  if (prerelease.some((id) => /^\d+$/.test(id) && id.length > 1 && id.startsWith('0'))) return null;
  return {
    raw: value,
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}

export function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new TypeError(`invalid SemVer version: ${left} / ${right}`);
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    if (a.prerelease.length === b.prerelease.length) return 0;
    return a.prerelease.length ? -1 : 1;
  }
  const n = Math.min(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < n; i++) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xn !== yn || x !== y) {
      return xn ? -1 : yn ? 1 : (x < y ? -1 : 1);
    }
  }
  return Math.sign(a.prerelease.length - b.prerelease.length);
}

export function parseRange(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const text = value.trim();
  if (text === 'any') return { raw: text, any: true, comparators: [] };
  if (parseVersion(text)) return { raw: text, exact: true, comparators: [{ operator: '=', version: text }] };
  if (text.startsWith('^')) {
    const inner = text.slice(1).trim();
    const v = parseVersion(inner);
    if (!v || v.raw !== inner) return null;
    const [major, minor] = v.core;
    const upper = major === 0 ? `${major}.${minor + 1}.0` : `${major + 1}.0.0`;
    return {
      raw: text,
      comparators: [
        { operator: '>=', version: v.raw },
        { operator: '<', version: upper },
      ],
    };
  }
  const tokens = text.split(/\s+/);
  const comparators = [];
  for (let i = 0; i < tokens.length; i++) {
    const bare = /^(>=|<=|>|<|=)$/.test(tokens[i]) ? tokens[i] : null;
    const match = bare ? null : /^(>=|<=|>|<|=)(.+)$/.exec(tokens[i]);
    const operator = bare ?? match?.[1] ?? null;
    const version = bare ? tokens[++i] : match?.[2];
    if (!operator || !parseVersion(version)) return null;
    comparators.push({ operator, version });
  }
  return comparators.length ? { raw: text, comparators } : null;
}

export function satisfies(version, range) {
  const v = parseVersion(version);
  const r = typeof range === 'string' ? parseRange(range) : range;
  if (!v || !r) return false;
  if (r.any) return true;
  if (v.prerelease.length && !r.comparators.some((c) => {
    const cv = parseVersion(c.version);
    return cv && cv.prerelease.length && cv.core.every((n, i) => n === v.core[i]);
  })) return false;
  return r.comparators.every((c) => {
    const order = compareVersions(version, c.version);
    switch (c.operator) {
      case '>=': return order >= 0;
      case '>': return order > 0;
      case '<=': return order <= 0;
      case '<': return order < 0;
      default: return order === 0;
    }
  });
}

export function validatePluginManifest(manifest, { label = 'plugin manifest' } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { status: 'FAIL', errors: [`${label} must be a JSON object`] };
  }
  if (typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) {
    errors.push('name must match ^[a-z][a-z0-9_]*$');
  }
  if (!parseVersion(manifest.version)) errors.push('version must be SemVer 2.0 x.y.z');
  for (const field of ['dependencies', 'devDependencies', 'dependencyOverrides']) {
    if (manifest[field] === undefined) continue;
    const value = manifest[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${field} must be an object`);
      continue;
    }
    for (const [name, contract] of Object.entries(value)) {
      if (!NAME_RE.test(name)) errors.push(`${field}.${name} has an invalid package name`);
      if (typeof contract !== 'string' || !parseRange(contract)) {
        errors.push(`${field}.${name} has an invalid version constraint`);
      }
    }
  }
  return {
    status: errors.length ? 'FAIL' : 'PASS',
    errors,
    name: typeof manifest.name === 'string' ? manifest.name : null,
    version: typeof manifest.version === 'string' ? manifest.version : null,
  };
}

export function readPluginIndex(file) {
  const resolved = path.resolve(String(file));
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read plugin index ${resolved}: ${error.message}`);
  }
  const packages = Array.isArray(parsed?.packages) ? parsed.packages : null;
  if (!packages) throw new Error(`plugin index must contain a packages array: ${resolved}`);
  const versions = new Map();
  const errors = [];
  for (const pkg of packages) {
    const check = validatePluginManifest(pkg, { label: `index entry ${pkg?.name ?? '?'}` });
    if (check.status === 'FAIL') {
      errors.push(...check.errors.map((e) => `${pkg?.name ?? '?'}: ${e}`));
      continue;
    }
    if (!versions.has(pkg.name)) versions.set(pkg.name, []);
    versions.get(pkg.name).push(pkg);
  }
  for (const list of versions.values()) list.sort((a, b) => compareVersions(a.version, b.version));
  return { file: resolved, schema: PLUGIN_INDEX_SCHEMA, versions, errors };
}

// One consistent version per package; a conflict is an explicit report row,
// never a silently chosen "highest" winner.
export function resolvePlugins({ manifest, index, includeDev = false } = {}) {
  const check = validatePluginManifest(manifest);
  if (check.status === 'FAIL') {
    return { schema: PLUGIN_REPORT_SCHEMA, status: 'FAIL', reason: 'invalid manifest', errors: check.errors, rows: [] };
  }
  const requirements = Object.entries(manifest.dependencies ?? {});
  if (includeDev) requirements.push(...Object.entries(manifest.devDependencies ?? {}));
  const rows = [];
  const errors = [];
  for (const [name, contract] of requirements) {
    const candidates = index.versions.get(name) ?? [];
    const matches = candidates.filter((pkg) => satisfies(pkg.version, contract));
    const selected = matches.at(-1) ?? null;
    rows.push({
      name,
      contract,
      status: selected ? 'PASS' : 'FAIL',
      selected: selected?.version ?? null,
      candidates: candidates.map((pkg) => pkg.version),
      reason: selected ? null : 'no offline index version satisfies this constraint',
    });
    if (!selected) errors.push(`${name}: no version satisfies ${contract}`);
  }
  return {
    schema: PLUGIN_REPORT_SCHEMA,
    status: errors.length ? 'FAIL' : 'PASS',
    manifest: `${check.name}@${check.version}`,
    index: index.file,
    errors,
    rows,
  };
}

export function formatPluginReport(report) {
  const lines = [
    'Opurom plugin resolution (offline index)',
    `schema: ${report.schema}`,
    `manifest: ${report.manifest ?? 'invalid'}`,
    `index: ${report.index ?? 'n/a'}`,
  ];
  for (const row of report.rows) {
    lines.push(`  ${row.status} ${row.name} ${row.contract} -> ${row.selected ?? 'n/a'}${row.reason ? ` (${row.reason})` : ''}`);
  }
  for (const err of report.errors ?? []) lines.push(`  error: ${err}`);
  lines.push(`result: ${report.status}`);
  return `${lines.join('\n')}\n`;
}
