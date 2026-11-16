// Relay for the inspector data plane (opurom-spec/INSPECTOR_DATA_PLANE.md):
// three bounded rings (frames, memory, network) with server-side monotonic
// seq, availability badges, a version that bumps on every hot-reload reset so
// consumers can see the gap, and pull views that stay byte-stable. The relay
// never fabricates 0: a channel without a data source is `absent` with a
// reason, and absent fields inside a record are null.

import { perfReport } from './frame_tier.mjs';

const FRAME_RING_LIMIT = 200;
const MEMORY_HISTORY_LIMIT = 50;
const NETWORK_RING_LIMIT = 200;

export const AVAILABILITY = Object.freeze({
  frames: {
    absent: { availability: 'absent', reason: 'no frame source attached (open the web-dom preview; the page agent reports rAF deltas)' },
    partial: { availability: 'partial', reason: 'frameMs measured via rAF deltas; tier mirrored in-page; no phase split' },
    full: { availability: 'full', reason: 'the kernel FrameBudget feeds the records' },
  },
  memory: {
    absent: { availability: 'absent', reason: 'no state reported yet' },
    partial: { availability: 'partial', reason: 'state bytes computed from the reported snapshot; cache/layers/images not exposed by the web-dom host' },
    full: { availability: 'full', reason: 'the kernel cache and image ledgers feed the records' },
  },
  network: {
    absent: { availability: 'absent', reason: 'no request proxy on the dev server (page fetches do not transit it)' },
  },
});

export function createInspectRelay() {
  let version = 0;
  let frameSeq = 0;
  let frameSource = null;
  let memorySource = null;
  const frames = [];
  const memory = { current: null, history: [] };
  const network = [];

  const clamp = (list, limit) => { while (list.length > limit) list.shift(); };
  const framesBadge = () => (frameSource === 'kernel' ? AVAILABILITY.frames.full
    : frameSource ? AVAILABILITY.frames.partial : AVAILABILITY.frames.absent);
  const memoryBadge = () => (memorySource === 'kernel' ? AVAILABILITY.memory.full
    : memorySource ? AVAILABILITY.memory.partial : AVAILABILITY.memory.absent);

  return {
    get version() { return version; },

    // The page agent batches rAF deltas; the kernel feeds full records from
    // its FrameBudget. seq is stamped server-side either way, so the view
    // never trusts a remote clock.
    addFrames(samples, { source = 'agent' } = {}) {
      frameSource = source;
      for (const sample of Array.isArray(samples) ? samples : []) {
        if (!sample || typeof sample !== 'object') continue;
        const frameMs = Number(sample.frameMs);
        if (!Number.isFinite(frameMs) || frameMs < 0) continue;
        frames.push({
          seq: frameSeq,
          startMs: Number.isFinite(Number(sample.startMs)) ? Math.max(0, Math.floor(Number(sample.startMs))) : null,
          frameMs,
          budgetMs: Number(sample.budgetMs) || 16,
          phaseMs: sample.phaseMs ?? null,
          tier: typeof sample.tier === 'string' ? sample.tier : null,
          nodes: Number.isInteger(sample.nodes) ? sample.nodes : null,
          effects: Number.isInteger(sample.effects) ? sample.effects : null,
        });
        frameSeq += 1;
      }
      clamp(frames, FRAME_RING_LIMIT);
      return framesBadge();
    },

    // One entry per state dispatch; absent mirrors stay null, never 0.
    addMemory({ state } = {}) {
      if (state === null || state === undefined) return memoryBadge();
      const stateBytes = Buffer.byteLength(JSON.stringify(state));
      memory.current = {
        cache: null,
        stateBytes,
        layersBytes: null,
        images: null,
        history: [{ version, totalBytes: stateBytes }],
      };
      memorySource = 'agent';
      memory.history.push({ version, totalBytes: stateBytes });
      clamp(memory.history, MEMORY_HISTORY_LIMIT);
      return memoryBadge();
    },

    // The kernel answers `memory` with the whole record shape; it is stored
    // as-is so core owns the ledger numbers.
    addMemoryRecord(record) {
      if (!record || typeof record !== 'object') return memoryBadge();
      memory.current = {
        cache: record.cache ?? null,
        stateBytes: Number.isInteger(record.stateBytes) ? record.stateBytes : null,
        layersBytes: Number.isInteger(record.layersBytes) ? record.layersBytes : null,
        images: record.images ?? null,
        history: Array.isArray(record.history) ? record.history.slice(-MEMORY_HISTORY_LIMIT) : [],
      };
      memorySource = 'kernel';
      return memoryBadge();
    },

    addNetwork(record) {
      if (!record || typeof record !== 'object') return AVAILABILITY.network.absent;
      network.push({
        id: Number.isInteger(record.id) ? record.id : network.length,
        method: String(record.method ?? ''),
        url: String(record.url ?? ''),
        status: Number.isInteger(record.status) ? record.status : null,
        requestBytes: Number.isInteger(record.requestBytes) ? record.requestBytes : null,
        responseBytes: Number.isInteger(record.responseBytes) ? record.responseBytes : null,
        startMs: Number.isFinite(Number(record.startMs)) ? Math.max(0, Math.floor(Number(record.startMs))) : null,
        durationMs: Number.isFinite(Number(record.durationMs)) ? Math.max(0, Math.floor(Number(record.durationMs))) : null,
      });
      clamp(network, NETWORK_RING_LIMIT);
      return AVAILABILITY.network.absent;
    },

    // A hot reload drops the rings and republishes the baselines; version
    // makes the gap visible to every consumer.
    reset() {
      version += 1;
      frames.length = 0;
      frameSeq = 0;
      memory.current = null;
      memory.history = [];
      network.length = 0;
    },

    pullFrames({ since = 0 } = {}) {
      const floor = Number(since);
      const from = Number.isInteger(floor) && floor >= 0 ? floor : 0;
      const slice = frames.filter((record) => record.seq >= from);
      const report = slice.length
        ? perfReport(slice.map((record) => record.frameMs), slice[slice.length - 1].tier)
        : null;
      return {
        ...framesBadge(),
        version,
        frames: slice,
        report,
      };
    },

    pullMemory() {
      return {
        ...memoryBadge(),
        version,
        memory: memory.current,
        history: memory.history.slice(),
      };
    },

    pullNetwork() {
      return {
        ...AVAILABILITY.network.absent,
        version,
        network: network.slice(),
      };
    },
  };
}
