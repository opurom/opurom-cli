// DevTools aggregated visualization data. Flutter authority (3.50.0,
// flutter-golden @ ab2912035e160d9cad6306df307576da6128ebdb):
// - packages/flutter_tools/lib/src/resident_runner.dart:2012-2043 (serve returns
//   host/port; launch targets a specific service; ready/url are explicit)
// - packages/flutter_tools/lib/src/commands/daemon.dart:1636-1660
//   (devtools.serve returns host+port, never invents a service)
// - dev/devicelab/lib/framework/browser.dart:349-350 (a DevTools URI is a
//   connection target, not a fabricated observation)
// Opurom adaptation: collect the four existing read-only dev endpoints into a
// single deterministic snapshot so a UI can render panels without knowing
// their URLs. Missing data keeps its availability badge and reason.

export const DEVTOOLS_PANELS = Object.freeze(['frames', 'memory', 'network', 'logs']);

export function aggregatePanels({ frames = null, memory = null, network = null, logs = null } = {}) {
  const panels = {
    frames: frames ?? { availability: 'absent', reason: 'no frames payload supplied' },
    memory: memory ?? { availability: 'absent', reason: 'no memory payload supplied' },
    network: network ?? { availability: 'absent', reason: 'no network payload supplied' },
    logs: logs ?? { availability: 'absent', reason: 'no logs payload supplied' },
  };
  const versionValues = DEVTOOLS_PANELS
    .map((name) => Number(panels[name]?.version))
    .filter((value) => Number.isInteger(value) && value >= 0);
  const version = versionValues.length ? Math.min(...versionValues) : 0;
  const summary = {
    frames: panelStatus(panels.frames, 'frames'),
    memory: panelStatus(panels.memory, 'memory'),
    network: panelStatus(panels.network, 'network'),
    logs: panelStatus(panels.logs, 'logs'),
  };
  return { schema: 'opurom.devtools-panels/v1', version, panels, summary };
}

function panelStatus(panel, name) {
  const availability = panel?.availability ?? 'absent';
  const detail = availability === 'full' ? 'live'
    : availability === 'partial' ? 'limited'
      : availability === 'absent' ? 'no data source' : 'unknown';
  return { panel: name, availability, detail, reason: panel?.reason ?? null };
}

export function formatPanels(snapshot) {
  const lines = ['Opurom DevTools panels (read-only aggregate)', `schema: ${snapshot.schema}`, `version: ${snapshot.version}`];
  for (const item of Object.values(snapshot.summary)) {
    lines.push(`${item.panel}: ${item.availability} (${item.detail})${item.reason ? ` — ${item.reason}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

// Fetch with the same base URL: no service discovery beyond the session record.
export async function fetchPanels({ session, fetchImpl = fetch } = {}) {
  if (!session || typeof session !== 'object') throw new Error('devtools session is required');
  const read = async (url) => {
    const response = await fetchImpl(url);
    if (!response.ok) return { availability: 'absent', reason: `HTTP ${response.status} for ${url}` };
    return response.json();
  };
  const [frames, memory, network, logs] = await Promise.all([
    read(session.framesUri),
    read(session.memoryUri),
    read(session.networkUri),
    read(session.logsUri),
  ]);
  return aggregatePanels({ frames, memory, network, logs });
}
