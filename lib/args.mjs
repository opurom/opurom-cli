// Minimal flag parser: --key value, --key=value, -o value, --flag, --, positionals.
export function parseArgs(argv = []) {
  const aliases = { o: 'out', h: 'help', p: 'port' };
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const token = String(argv[i]);
    if (token === '--') {
      positionals.push(...argv.slice(i + 1).map(String));
      break;
    }
    if (token.startsWith('-') && token !== '-') {
      const long = token.startsWith('--');
      const body = long ? token.slice(2) : token.slice(1);
      const eq = body.indexOf('=');
      const raw = eq === -1 ? body : body.slice(0, eq);
      const key = aliases[raw] ?? raw;
      if (!key) throw new Error(`invalid option: ${token}`);
      if (eq !== -1) {
        flags[key] = body.slice(eq + 1);
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith('-')) {
        flags[key] = true;
      } else {
        flags[key] = String(next);
        i++;
      }
    } else {
      positionals.push(token);
    }
  }
  return { flags, positionals };
}

export function requireFlags(flags, keys) {
  const out = {};
  for (const key of keys) {
    const value = flags[key];
    if (value === undefined || value === true || value === '') {
      throw new Error(`missing required option --${key}`);
    }
    out[key] = String(value);
  }
  return out;
}

export function parsePort(value, fallback = 5178) {
  if (value === undefined || value === true) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port: ${value} (expected 1..65535)`);
  }
  return port;
}
