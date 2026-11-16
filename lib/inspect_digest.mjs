// Golden digest diff for the live IR: the IR is rendered by opurom-render at
// the golden viewport and the digest is the renderer's own `digest=` line, so
// the number is exactly the one the e2e gate prints (no second hashing
// scheme). The digest is a whole-frame value; the node diff tells you what
// moved, keyed by node id and compared field by field.

import fs from 'node:fs';
import path from 'node:path';
import { goldenFile, tmpDir } from './paths.mjs';
import { run } from './proc.mjs';

// The golden render is 320x240 (opurom-examples/test/cross-layer.mjs and the
// e2e gate both use it), not the inspector tree's 800x600.
export const GOLDEN_VIEWPORT = Object.freeze({ width: 320, height: 240 });

// The digest the golden suite pins for opurom-examples/golden/counter at the
// golden viewport (cross-layer.mjs:237). Kept so a live app equal to the golden
// app reports a match even before the baseline is rendered.
export const GOLDEN_DIGEST = '8d45f412996a99c6';

// Render an IR file and read the digest the renderer itself prints. The
// renderer hashes its in-memory RGBA pixel buffer, which is not the byte layout
// of the PPM file it writes (P6 header + packed channels), so we take its
// `digest=` line as the single source of truth.
export function renderDigest(renderBin, irFile, tmp, tag = 'live') {
  const frame = path.join(tmp, `digest-${tag}.ppm`);
  const result = run(renderBin, [
    irFile, String(GOLDEN_VIEWPORT.width), String(GOLDEN_VIEWPORT.height), frame,
  ], { timeout: 30000 });
  const text = `${result.stdout}${result.stderr}`;
  const match = /(?:^|\s)digest=([0-9a-f]{8,64})\b/i.exec(text);
  if (result.status !== 0 || !match) {
    throw new Error(`opurom-render printed no digest: ${text.trim() || `exit ${result.status}`}`);
  }
  return { digest: match[1].toLowerCase() };
}

export function goldenIrFile(root) {
  return goldenFile('counter.opuir.json', root);
}

// Index IR nodes by id: kind and key are the fields the diff compares.
function indexIr(ir) {
  const byId = new Map();
  const visit = (node, depth) => {
    byId.set(node.id, { id: node.id, kind: node.kind, key: node.props?.key ?? null, depth });
    for (const child of Array.isArray(node.children) ? node.children : []) visit(child, depth + 1);
  };
  if (ir?.tree) visit(ir.tree, 0);
  return byId;
}

// added/removed/changed over node ids. A node is changed when its kind or key
// differs; bounds are not in the IR, so they are not compared.
export function diffTrees(baselineIr, liveIr) {
  const before = indexIr(baselineIr);
  const after = indexIr(liveIr);
  const added = [];
  const removed = [];
  const changed = [];
  for (const [id, node] of after) if (!before.has(id)) added.push(node);
  for (const [id, node] of before) if (!after.has(id)) removed.push(node);
  for (const [id, node] of after) {
    const prev = before.get(id);
    if (!prev) continue;
    const fields = [];
    if (prev.kind !== node.kind) fields.push(`kind ${prev.kind}->${node.kind}`);
    if (prev.key !== node.key) fields.push(`key ${JSON.stringify(prev.key)}->${JSON.stringify(node.key)}`);
    if (fields.length) changed.push({ ...node, fields });
  }
  const byId = (a, b) => a.id - b.id;
  return { added: added.sort(byId), removed: removed.sort(byId), changed: changed.sort(byId) };
}

// Read the golden baseline: the compiled counter IR (for the node diff) and
// its renderer digest. A missing fixture degrades to a live-digest-only view.
export function readBaseline(root, renderBin) {
  const file = goldenIrFile(root);
  if (!fs.existsSync(file)) {
    return { missing: true, reason: `golden IR not found at ${file}` };
  }
  let ir;
  try {
    ir = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { missing: true, reason: `golden IR unreadable: ${error.message}` };
  }
  const dir = tmpDir('inspect-digest-base-');
  try {
    const { digest } = renderDigest(renderBin, file, dir, 'baseline');
    return { digest, ir };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function formatDigestText({ liveDigest, baseline, diff }) {
  const lines = ['Opurom inspect golden digest (live IR vs opurom-examples/golden/counter)', `live digest: ${liveDigest}`];
  if (!baseline || baseline.missing) {
    lines.push(`baseline: unavailable (${baseline?.reason ?? 'golden not readable'}); showing the live digest only, no diff`);
    return lines.join('\n');
  }
  lines.push(`baseline digest: ${baseline.digest}${liveDigest === baseline.digest ? ' (match)' : ' (differs)'}`);
  const { added, removed, changed } = diff;
  if (added.length === 0 && removed.length === 0 && changed.length === 0) {
    lines.push('nodes: identical to the baseline');
    return lines.join('\n');
  }
  lines.push(`nodes: +${added.length} -${removed.length} ~${changed.length}`);
  for (const node of added) lines.push(`  + #${node.id} ${node.kind}`);
  for (const node of removed) lines.push(`  - #${node.id} ${node.kind}`);
  for (const node of changed) lines.push(`  ~ #${node.id} ${node.kind} (${node.fields.join(', ')})`);
  return lines.join('\n');
}

// Top-level keys in a fixed order so the JSON form is byte-stable.
export function digestJson({ liveDigest, baseline, diff }) {
  const base = baseline && !baseline.missing
    ? { digest: baseline.digest, match: liveDigest === baseline.digest }
    : { digest: null, match: null, missing: true, reason: baseline?.reason ?? 'golden not readable' };
  return {
    command: 'inspect',
    mode: 'digest',
    viewport: { width: GOLDEN_VIEWPORT.width, height: GOLDEN_VIEWPORT.height },
    liveDigest,
    baseline: base,
    diff: diff && !baseline?.missing
      ? { added: diff.added.map((n) => n.id), removed: diff.removed.map((n) => n.id), changed: diff.changed.map((n) => n.id) }
      : null,
  };
}
