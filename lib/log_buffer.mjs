// Dev server log ring: Flutter logger parity (flutter-golden ab2912035e /
// 3.50-candidate.0):
// - packages/flutter_tools/lib/src/base/logger.dart:29-64 (Logger quiet/isVerbose/
//   isMachine/hadErrorOutput), 68-121 (printError), 123-165 (printWarning),
//   167-215 (printStatus), 217-260 (printTrace), 931+ (VerboseLogger).
// Opurom adaptation: one bounded in-memory ring per dev session; levels are
// trace/info/warn/error, filters are deterministic, and exports are plain
// JSON/NDJSON/text. No Flutter logger class structure is copied.

export const LOG_LEVELS = Object.freeze(['trace', 'info', 'warn', 'error']);
export const DEFAULT_LOG_LIMIT = 500;

const RANK = Object.freeze({ trace: 0, info: 1, warn: 2, error: 3 });

export function parseLogLevel(value, fallback = 'trace') {
  if (value === undefined || value === null || value === '') return fallback;
  const raw = String(value).toLowerCase();
  const level = raw === 'warning' ? 'warn' : raw === 'verbose' ? 'trace' : raw;
  if (!LOG_LEVELS.includes(level)) {
    throw new Error(`invalid log level: ${value} (expected ${LOG_LEVELS.join(', ')})`);
  }
  return level;
}

export function createLogRing({ limit = DEFAULT_LOG_LIMIT, now = () => Date.now() } = {}) {
  const size = Number(limit);
  if (!Number.isInteger(size) || size < 1 || size > 10000) {
    throw new Error(`invalid log limit: ${limit} (expected 1..10000)`);
  }
  const records = [];
  let seq = 0;
  let clock = 0;
  const tick = typeof now === 'function' ? now : () => 0;
  const errors = { count: 0 };

  return {
    add(level, message, { source = 'dev' } = {}) {
      const normalized = parseLogLevel(level);
      seq += 1;
      clock += 1;
      const record = {
        seq,
        at: tick(),
        order: clock,
        level: normalized,
        source: String(source ?? 'dev'),
        message: String(message ?? ''),
      };
      records.push(record);
      while (records.length > size) records.shift();
      if (normalized === 'error') errors.count += 1;
      return record;
    },
    get size() { return records.length; },
    get errorCount() { return errors.count; },
    query({ level, source, q = '', since = 0, limit: max = size } = {}) {
      const floorLevel = RANK[parseLogLevel(level)];
      const needle = String(q ?? '').toLowerCase();
      const top = Number(max);
      const count = Number.isInteger(top) && top > 0 ? Math.min(top, size) : size;
      const from = Number(since);
      const sinceSeq = Number.isInteger(from) && from > 0 ? from : 0;
      const matched = records.filter((record) =>
        RANK[record.level] >= floorLevel
        && record.seq >= sinceSeq
        && (!source || record.source === String(source))
        && (!needle || `${record.level} ${record.source} ${record.message}`.toLowerCase().includes(needle)));
      return matched.slice(-count);
    },
    export({ format = 'json', ...filters } = {}) {
      const rows = this.query(filters);
      if (format === 'ndjson') return `${rows.map((row) => JSON.stringify(row)).join('\n')}${rows.length ? '\n' : ''}`;
      if (format === 'text') return `${rows.map((row) => `[${row.level.toUpperCase()}] ${row.source}: ${row.message}`).join('\n')}${rows.length ? '\n' : ''}`;
      if (format !== 'json') throw new Error(`invalid log export format: ${format} (expected json, ndjson, text)`);
      return `${JSON.stringify({ schema: 'opurom.dev-log/v1', count: rows.length, errorCount: errors.count, rows }, null, 2)}\n`;
    },
    clear() {
      records.length = 0;
      errors.count = 0;
      return { cleared: true };
    },
  };
}

export function makeDevLogger({ ring, log = console.log, source = 'dev' } = {}) {
  const write = typeof log === 'function' ? log : console.log;
  const emit = (level, args) => {
    const message = args.map((part) => String(part)).join(' ');
    const record = ring.add(level, message, { source });
    write(message);
    return record;
  };
  return {
    trace: (...args) => emit('trace', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}
