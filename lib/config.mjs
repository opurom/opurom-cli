// Flutter config parity (Flutter 3.50-candidate.0):
// - packages/flutter_tools/lib/src/commands/config.dart:45-93 (--list/--machine/clear semantics)
// - packages/flutter_tools/lib/src/base/config.dart:20-36, 113-165 (XDG_CONFIG_HOME/YAML-free JSON store, set/remove)
// - packages/flutter_tools/lib/src/build_info.dart:993-1000 (kBuildMode/kTargetPlatform/kTargetFile/kDartDefines)
// - packages/flutter_tools/packages/flutter_tools_core/lib/src/build.dart:22-58 (debug/profile/release BuildMode)
// - packages/flutter_tools/lib/src/runner/flutter_command.dart:49-63, 1307-1322, 1345-1445 (--dart-define / --dart-define-from-file / .env rules)
// Opurom adaptation: same precedence and file shapes, no Flutter object model copied.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONFIG_DIR_ENV = 'XDG_CONFIG_HOME';
export const OPUR_CONFIG_ENV = 'OPUR_CONFIG';
export const DEFAULT_SETTINGS_FILE = 'settings.json';
export const DEFAULT_ENV_NAME = 'default';

export const BUILD_MODES = Object.freeze(['debug', 'profile', 'release']);
export const RESERVED_DEFINE_KEYS = Object.freeze([
  'BuildMode', 'TargetPlatform', 'TargetFile', 'DartDefines',
]);

function configHome(env = process.env) {
  if (typeof env[OPUR_CONFIG_ENV] === 'string' && env[OPUR_CONFIG_ENV]) {
    return path.resolve(env[OPUR_CONFIG_ENV]);
  }
  const xdg = env[CONFIG_DIR_ENV];
  const base = typeof xdg === 'string' && xdg ? path.resolve(xdg) : path.join(os.homedir(), '.config');
  return path.join(base, 'opurom');
}

export function globalSettingsPath({ env = process.env } = {}) {
  return path.join(configHome(env), DEFAULT_SETTINGS_FILE);
}

export function projectSettingsPath(dir, { env = process.env } = {}) {
  if (typeof env[OPUR_CONFIG_ENV] === 'string' && env[OPUR_CONFIG_ENV]) {
    return path.join(path.resolve(env[OPUR_CONFIG_ENV]), 'project-settings.json');
  }
  return path.join(path.resolve(dir), '.opurom', DEFAULT_SETTINGS_FILE);
}

function readJsonObject(file, { clearInvalid = false } = {}) {
  if (!fs.existsSync(file)) return {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    if (clearInvalid) {
      try { fs.unlinkSync(file); } catch { /* read-only or racing: keep the in-memory empty view */ }
    }
    return {};
  }
}

function writeJsonObject(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(values, null, 2)}\n`);
  return file;
}

export function createSettings(file) {
  let values = readJsonObject(file, { clearInvalid: true });
  return {
    file,
    keys() { return Object.keys(values).sort(); },
    all() { return { ...values }; },
    getValue(key) { return values[key]; },
    setValue(key, value) {
      if (typeof key !== 'string' || !key.trim()) throw new Error('config key must be a non-empty string');
      values[key] = value;
      writeJsonObject(file, values);
      return value;
    },
    removeValue(key) {
      const removed = Object.prototype.hasOwnProperty.call(values, key);
      delete values[key];
      if (removed) writeJsonObject(file, values);
      return removed;
    },
    clear() {
      values = {};
      writeJsonObject(file, values);
    },
  };
}

export function globalSettings(env = process.env) {
  return createSettings(globalSettingsPath({ env }));
}

export function projectSettings(dir, env = process.env) {
  return createSettings(projectSettingsPath(dir, { env }));
}

// Flutter's `--config-key=value` writes a value; an empty string removes it.
// Mirrors ConfigCommand._updateConfig (config.dart:333-346).
export function applyConfigOptions(settings, options) {
  const changes = [];
  for (const [key, raw] of Object.entries(options ?? {})) {
    if (raw === undefined || raw === true) continue;
    const value = String(raw);
    if (value === '') {
      settings.removeValue(key);
      changes.push(`Removing "${key}" value.`);
    } else {
      settings.setValue(key, value);
      changes.push(`Setting "${key}" value to "${value}".`);
    }
  }
  return changes;
}

export function formatSettings(settings) {
  const keys = settings.keys();
  const lines = keys.map((key) => `  ${key}: ${settings.getValue(key) ?? '(Not set)'}`);
  return ['All Settings:', ...(lines.length ? lines : ['  No configs have been configured.'])].join('\n');
}

export { LOG_LEVELS, createLogRing, makeDevLogger, parseLogLevel } from './log_buffer.mjs';

export function configCommand({
  options = {}, list = false, machine = false, cwd = process.cwd(), env = process.env,
  global = globalSettings(env), project = projectSettings(cwd, env), log = () => {},
} = {}) {
  const changes = applyConfigOptions(global, options);
  for (const line of changes) log(line);
  if (list || machine) {
    const merged = { ...global.all(), ...project.all() };
    if (machine) {
      log(JSON.stringify(merged, null, 2));
      return { code: 0, merged, changes };
    }
    log(formatSettings(global));
    const projectKeys = project.keys();
    if (projectKeys.length) {
      log('Project Settings:');
      for (const key of projectKeys) log(`  ${key}: ${project.getValue(key) ?? '(Not set)'}`);
    }
    return { code: 0, merged, changes };
  }
  if (changes.length) log('You may need to restart any open editors for them to read new settings.');
  return { code: 0, merged: { ...global.all(), ...project.all() }, changes };
}

// --- multi-environment configuration
// Flutter extractDartDefineConfigJsonMap (flutter_command.dart:1345-1445): files are
// merged in order (JSON literal or .env lines), then --dart-define entries win.

const KEY_VALUE = /^\s*([a-zA-Z_]+[a-zA-Z0-9_]*)\s*=\s*(.*)?$/;
const QUOTED = [
  /^"(.*)"\s*(?:#\s*.*)?$/,
  /^'(.*)'\s*(?:#\s*.*)?$/,
  /^`(.*)`\s*(?:#\s*.*)?$/,
];
const UNQUOTED = /^([^#\n\s]*)\s*(?:\s*#\s*(.*))?$/;

export function parseEnvFile(raw, file = '<env>') {
  const values = {};
  for (const sourceLine of String(raw).split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (/^\s*([a-zA-Z_]+[a-zA-Z0-9_]*)\s*=\s*"""\s*(.*)$/.test(line)) {
      throw new Error(`${file}: multiline env values are not supported`);
    }
    const match = KEY_VALUE.exec(line);
    if (!match) throw new Error(`${file}: invalid env line: ${line}`);
    const [, key, rawValue = ''] = match;
    let value = rawValue;
    for (const quote of QUOTED) {
      const quoted = quote.exec(rawValue);
      if (quoted) { value = quoted[1]; break; }
    }
    if (value === rawValue) {
      const unquoted = UNQUOTED.exec(rawValue);
      if (unquoted) value = unquoted[1] ?? '';
    }
    values[key] = value;
  }
  return values;
}

export function readDefineFile(file) {
  if (!fs.existsSync(file)) throw new Error(`define file not found: ${file}`);
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.trim().startsWith('{')) {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`define file must contain a JSON object: ${file}`);
    }
    return parsed;
  }
  return parseEnvFile(raw, file);
}

export function parseCliDefines(values) {
  const result = {};
  const list = Array.isArray(values) ? values : values == null ? [] : [values];
  for (const value of list) {
    if (typeof value !== 'string' || value === '') continue;
    const at = value.indexOf('=');
    if (at <= 0) throw new Error(`invalid --dart-define: ${value} (expected KEY=VALUE)`);
    result[value.slice(0, at)] = value.slice(at + 1);
  }
  return result;
}

export function formatDefines(defines) {
  return Object.entries(defines)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`);
}

function defineFilesFor(envName, { cwd = process.cwd(), defineFromFile = [] } = {}) {
  const files = Array.isArray(defineFromFile) ? defineFromFile : defineFromFile == null ? [] : [defineFromFile];
  const list = files.map((file) => (path.isAbsolute(String(file)) ? String(file) : path.resolve(cwd, String(file))));
  if (envName && envName !== DEFAULT_ENV_NAME) {
    for (const name of [`.env.${envName}`, `env/${envName}.json`, `env/${envName}.env`]) {
      const candidate = path.resolve(cwd, name);
      if (fs.existsSync(candidate)) list.push(candidate);
    }
  }
  const fallback = path.resolve(cwd, '.env');
  if (fs.existsSync(fallback) && !list.includes(fallback)) list.push(fallback);
  return list;
}

export function resolveEnvironment({
  cwd = process.cwd(), envName = DEFAULT_ENV_NAME, dartDefine = [], defineFromFile = [],
  env = process.env, settings = null,
} = {}) {
  const local = projectSettings(cwd, env);
  const store = settings ?? globalSettings(env);
  const globalEnvs = store.getValue('environments');
  const globalEnv = globalEnvs && typeof globalEnvs === 'object' && !Array.isArray(globalEnvs)
    ? globalEnvs[envName] : null;
  const projectEnvs = local.getValue('environments');
  const projectEnv = projectEnvs && typeof projectEnvs === 'object' && !Array.isArray(projectEnvs)
    ? projectEnvs[envName] : null;
  const files = defineFilesFor(envName, { cwd, defineFromFile });
  const defines = {};
  for (const file of files) Object.assign(defines, readDefineFile(file));
  if (globalEnv && typeof globalEnv === 'object' && !Array.isArray(globalEnv)) Object.assign(defines, globalEnv);
  if (projectEnv && typeof projectEnv === 'object' && !Array.isArray(projectEnv)) Object.assign(defines, projectEnv);
  Object.assign(defines, parseCliDefines(dartDefine));
  defines.Environment ??= envName;
  return {
    name: envName,
    defines,
    entries: formatDefines(defines),
    files,
    configFile: projectSettingsPath(cwd, { env }),
    globalSettingsFile: globalSettingsPath({ env }),
  };
}

export function buildEnvironmentArgs(resolved) {
  const out = [];
  for (const entry of resolved.entries) out.push('--dart-define', entry);
  return out;
}

export function environmentProcessEnv(resolved, base = process.env) {
  const next = { ...base };
  for (const [key, value] of Object.entries(resolved.defines)) {
    next[`OPR_DEFINE_${key}`] = String(value);
  }
  next.OPR_ENV = resolved.name;
  return next;
}

export function parseBuildMode(value) {
  const mode = value === undefined || value === true || value === '' ? 'debug' : String(value);
  if (!BUILD_MODES.includes(mode)) {
    throw new Error(`invalid --mode: ${mode} (expected ${BUILD_MODES.join(', ')})`);
  }
  return mode;
}

// Flutter BuildInfo.toEnvironment/buildEnvironmentWithDefine (build_info.dart:390-450):
// mode/target/defines are compile-time constants of one build, never runtime flags.
export function buildInfoFor({ mode = 'debug', target = null, environment = null } = {}) {
  const buildMode = parseBuildMode(mode);
  const defines = { ...(environment?.defines ?? {}) };
  for (const key of RESERVED_DEFINE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(defines, key)) {
      throw new Error(`reserved --dart-define key: ${key}`);
    }
  }
  defines.BuildMode = buildMode;
  if (target) defines.TargetFile = target;
  return {
    mode: buildMode,
    isRelease: buildMode === 'release',
    isProfile: buildMode === 'profile',
    isDebug: buildMode === 'debug',
    target,
    environment: environment?.name ?? DEFAULT_ENV_NAME,
    defines,
    entries: formatDefines(defines),
  };
}
