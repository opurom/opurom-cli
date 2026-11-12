import { spawnSync } from 'node:child_process';

export function run(cmd, args = [], opts = {}) {
  const { cwd, input, inherit = false, env = process.env, timeout } = opts;
  const result = spawnSync(cmd, args.map(String), {
    cwd,
    input,
    env,
    timeout,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`failed to run ${cmd}: ${result.error.message}`);
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

export function runOrThrow(cmd, args = [], opts = {}) {
  const result = run(cmd, args, opts);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})${detail ? `:\n${detail}` : ''}`);
  }
  return result;
}

export function command(cmd, args = []) {
  return `${cmd} ${args.map((a) => (/\s/.test(String(a)) ? JSON.stringify(String(a)) : a)).join(' ')}`.trim();
}
