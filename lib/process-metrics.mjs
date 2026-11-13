// Renderer process resource measurement: peak resident set size and user/sys
// CPU time. The renderer is a short-lived child spawned per frame, so the
// metrics come from the host's resource reporter rather than from instrumenting
// the renderer. `/usr/bin/time` is preferred (BSD `-l` or GNU `-v`); when it is
// absent the child pid is polled with `ps` while it runs. Node builtins only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const TIME_BIN = '/usr/bin/time';
export const PS_FIELDS = 'rss,cputime';

// The ps poll is bounded by the child's lifetime and this iteration cap, so a
// renderer that never exits cannot pin the poller indefinitely.
const POLL_MAX_ITERATIONS = 100000;

const PS_POLL_SCRIPT = `#!/bin/sh
# Launch the renderer in the background so its pid is known, then poll ps until
# it exits and report the peak RSS and the last cputime to stderr.
cmd="$1"
shift
"$cmd" "$@" &
pid=$!
peak=0
lastcpu=""
seen=0
iterations=0
while kill -0 "$pid" 2>/dev/null; do
  iterations=$((iterations + 1))
  [ "$iterations" -gt ${POLL_MAX_ITERATIONS} ] && break
  out=$(ps -o rss=,cputime= -p "$pid" 2>/dev/null) || break
  set -- $out
  [ -n "$1" ] || break
  if [ "$1" -gt "$peak" ] 2>/dev/null; then peak=$1; fi
  if [ -n "$2" ]; then lastcpu=$2; fi
  seen=1
done
wait "$pid"
status=$?
if [ "$seen" = 1 ]; then
  echo "__OPUROM_METRICS__ rss=$peak cpu=$lastcpu" >&2
fi
exit $status
`;

// A `H:MM:SS.ss` or `MM:SS.ss` cputime string, in milliseconds.
export function parseCpuTime(text) {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(String(text ?? '').trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const ms = ((hours * 60 + minutes) * 60 + seconds) * 1000;
  return Number.isFinite(ms) ? ms : null;
}

// BSD `time -l` prints "N maximum resident set size"; GNU `time -v` prints
// "Maximum resident set size (kbytes): N". The BSD form reports the value in
// bytes on macOS while GNU reports it in kB, so both are normalized to kB here
// rather than reported at whatever unit the host happens to use.
export function parseTimeReport(text, variant) {
  const source = String(text ?? '');
  const rssMatch = variant === 'gnu'
    ? /Maximum resident set size \(kbytes\):\s*(\d+)/i.exec(source)
    : /(\d+)\s+maximum resident set size/i.exec(source);
  const peakRssKb = rssMatch
    ? (variant === 'gnu' ? Number(rssMatch[1]) : Number(rssMatch[1]) / 1024)
    : null;

  let cpuUserMs = null;
  let cpuSystemMs = null;
  if (variant === 'gnu') {
    const user = /User time \(seconds\):\s*([\d.]+)/i.exec(source);
    const system = /System time \(seconds\):\s*([\d.]+)/i.exec(source);
    cpuUserMs = user ? Number(user[1]) * 1000 : null;
    cpuSystemMs = system ? Number(system[1]) * 1000 : null;
  } else {
    const bsd = /([\d.]+)\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/.exec(source);
    if (bsd) {
      cpuUserMs = Number(bsd[2]) * 1000;
      cpuSystemMs = Number(bsd[3]) * 1000;
    }
    if (cpuUserMs === null) {
      const user = /User time\s*:\s*([\d.]+)/i.exec(source);
      const system = /System time\s*:\s*([\d.]+)/i.exec(source);
      cpuUserMs = user ? Number(user[1]) * 1000 : null;
      cpuSystemMs = system ? Number(system[1]) * 1000 : null;
    }
  }
  return { peakRssKb, cpuUserMs, cpuSystemMs };
}

// The ps poller emits its marker on stderr; it reports total CPU only, because
// ps has no user/sys split.
export function parsePsMetrics(text) {
  const match = /__OPUROM_METRICS__\s+rss=(\S*)\s+cpu=(\S*)/.exec(String(text ?? ''));
  if (!match) return null;
  const rssKb = Number(match[1]);
  const cpuTotalMs = parseCpuTime(match[2]);
  if (!Number.isFinite(rssKb) || rssKb < 0) return null;
  if (cpuTotalMs === null) return { peakRssKb: rssKb, cpuUserMs: null, cpuSystemMs: null, cpuTotalMs: null };
  return { peakRssKb: rssKb, cpuUserMs: null, cpuSystemMs: null, cpuTotalMs };
}

function normalize(result) {
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function spawn(cmd, args, timeout) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw new Error(`failed to run ${cmd}: ${result.error.message}`);
  return normalize(result);
}

// Probes `/usr/bin/time` once per process with a no-op child and keeps the
// variant, so a host that reports the fields in only one form is not guessed.
let cachedProbe = null;

function probeVariant(flags) {
  try {
    const result = spawnSync(TIME_BIN, [...flags, '/bin/sh', '-c', 'exit 0'], {
      encoding: 'utf8',
      timeout: 10000,
      env: process.env,
    });
    if (result.error || result.status !== 0) return false;
    return /maximum resident set size/i.test(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  } catch {
    return false;
  }
}

export function detectTimeBinary() {
  if (cachedProbe !== null) return cachedProbe;
  if (!fs.existsSync(TIME_BIN)) {
    cachedProbe = { path: null, variant: null, reason: `${TIME_BIN} not found` };
    return cachedProbe;
  }
  if (probeVariant(['-l'])) {
    cachedProbe = { path: TIME_BIN, variant: 'bsd', reason: null };
  } else if (probeVariant(['-v'])) {
    cachedProbe = { path: TIME_BIN, variant: 'gnu', reason: null };
  } else {
    cachedProbe = {
      path: null, variant: null,
      reason: `${TIME_BIN} did not report a resident set size for a no-op child`,
    };
  }
  return cachedProbe;
}

function unavailableResource(reason) {
  return {
    mechanism: null,
    peakRssKb: null,
    cpuUserMs: null,
    cpuSystemMs: null,
    cpuTotalMs: null,
    reason,
  };
}

function resourceFromTime(parsed, variant) {
  const { peakRssKb, cpuUserMs, cpuSystemMs } = parsed;
  if (peakRssKb === null && cpuUserMs === null && cpuSystemMs === null) {
    return unavailableResource(`time ${variant} did not report RSS or CPU time`);
  }
  return {
    mechanism: `time-${variant}`,
    peakRssKb,
    cpuUserMs,
    cpuSystemMs,
    cpuTotalMs: cpuUserMs !== null && cpuSystemMs !== null
      ? cpuUserMs + cpuSystemMs
      : null,
    reason: null,
  };
}

function resourceFromPs(parsed) {
  if (!parsed) {
    return unavailableResource(`ps -o ${PS_FIELDS} reported no fields for the renderer pid`);
  }
  return {
    mechanism: 'ps-poll',
    peakRssKb: parsed.peakRssKb,
    cpuUserMs: parsed.cpuUserMs,
    cpuSystemMs: parsed.cpuSystemMs,
    cpuTotalMs: parsed.cpuTotalMs,
    reason: null,
  };
}

function writePollScript(directory) {
  const file = path.join(directory, 'poll.sh');
  fs.writeFileSync(file, PS_POLL_SCRIPT, { mode: 0o755 });
  return file;
}

/**
 * Runs `renderBin args` and returns the child result plus its resource metrics.
 * `time` can override the detection for tests; the default is the cached probe.
 */
export function measureRendererResources({
  renderBin, args = [], timeout = 30000, time = null,
}) {
  const detected = time ?? detectTimeBinary();
  if (detected.path && detected.variant) {
    const flag = detected.variant === 'gnu' ? '-v' : '-l';
    const result = spawn(detected.path, [flag, renderBin, ...args], timeout);
    const parsed = parseTimeReport(result.stderr, detected.variant);
    return { result, resource: resourceFromTime(parsed, detected.variant) };
  }

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-metrics-'));
  try {
    const script = writePollScript(directory);
    const result = spawn('/bin/sh', [script, renderBin, ...args], timeout);
    const parsed = parsePsMetrics(result.stderr);
    return { result, resource: resourceFromPs(parsed) };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

export function unavailableMemory(reason = 'not measured by this command') {
  return { peakRssKb: null, peakRssMb: null, reason };
}

export function unavailableCpu(reason = 'not measured by this command') {
  return { userMs: null, systemMs: null, totalMs: null, maxTotalMs: null, reason };
}

export const MEMORY_KEYS = Object.freeze(['peakRssKb', 'peakRssMb', 'reason']);
export const CPU_KEYS = Object.freeze(['userMs', 'systemMs', 'totalMs', 'maxTotalMs', 'reason']);

function finiteOrNull(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Aggregates per-frame resource measurements into the peak RSS and the
 * total/max CPU time over the measured runs. A metric with no usable sample
 * keeps its numbers null and carries the honest reason instead.
 */
export function aggregateResources(runs) {
  const usable = Array.isArray(runs) ? runs.filter((run) => run && typeof run === 'object') : [];
  const rss = usable.map((run) => finiteOrNull(run.peakRssKb)).filter((v) => v !== null);
  const user = usable.map((run) => finiteOrNull(run.cpuUserMs)).filter((v) => v !== null);
  const system = usable.map((run) => finiteOrNull(run.cpuSystemMs)).filter((v) => v !== null);
  const total = usable.map((run) => finiteOrNull(run.cpuTotalMs)).filter((v) => v !== null);

  const reason = usable.length
    ? usable.find((run) => typeof run.reason === 'string' && run.reason.length)?.reason
      ?? 'renderer resource measurement unavailable'
    : 'no measured render runs';

  const peakRssKb = rss.length ? Math.max(...rss) : null;
  return {
    memory: {
      peakRssKb,
      peakRssMb: peakRssKb === null ? null : Number((peakRssKb / 1024).toFixed(2)),
      reason: rss.length ? null : reason,
    },
    cpu: {
      userMs: user.length ? user.reduce((sum, ms) => sum + ms, 0) : null,
      systemMs: system.length ? system.reduce((sum, ms) => sum + ms, 0) : null,
      totalMs: total.length ? total.reduce((sum, ms) => sum + ms, 0) : null,
      maxTotalMs: total.length ? Math.max(...total) : null,
      reason: (user.length || system.length || total.length) ? null : reason,
    },
  };
}

export function formatMemory(memory) {
  if (!memory || memory.peakRssKb === null) return undefined;
  return `${memory.peakRssMb} MB (${memory.peakRssKb} kB)`;
}

export function formatCpu(cpu) {
  if (!cpu || cpu.totalMs === null) return undefined;
  const ms = (value) => Number.isFinite(value) ? `${value} ms` : 'n/a';
  return `user=${ms(cpu.userMs)}, sys=${ms(cpu.systemMs)}, total=${ms(cpu.totalMs)}, max=${ms(cpu.maxTotalMs)}`;
}
