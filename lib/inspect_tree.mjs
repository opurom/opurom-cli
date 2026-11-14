import fs from 'node:fs';
import path from 'node:path';
import { ensureSiblingBinary, tmpDir, workspaceRoot } from './paths.mjs';
import { run } from './proc.mjs';

// Flutter's Widget Inspector exposes node ids, keys, computed bounds and
// visibility. This tree view reads a compiled OPUIR, asks the renderer for the
// authoritative bounds/a11y tree, and adds visible-only `when`/`unless`
// conditions and effect layers. No geometry is computed here: bounds come from
// `opurom-render --a11y` and effect counts from `--commands`, so identical IR
// yields byte-identical output.

const VIEWPORT = Object.freeze({ width: 800, height: 600 });

const stringProp = (props, key) => (typeof props?.[key] === 'string' ? props[key] : null);
const q = (value) => JSON.stringify(value);

export function readIr(irFile) {
  const abs = path.resolve(irFile);
  if (!fs.existsSync(abs)) throw new Error(`IR file not found: ${abs}`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    throw new Error(`invalid IR JSON in ${abs}: ${error.message}`);
  }
  if (parsed?.ir !== '0.1') throw new Error(`unsupported IR version: ${String(parsed?.ir)} (expected "0.1")`);
  if (!parsed.tree || typeof parsed.tree !== 'object') throw new Error(`invalid IR in ${abs}: missing tree`);
  return parsed;
}

// Validate ids/kind once and return the full id set; ids are unique and u32 by spec.
function nodeIds(tree) {
  const ids = new Set();
  const walk = (node) => {
    if (!Number.isInteger(node?.id) || node.id < 0) throw new Error('invalid IR: node id must be a non-negative integer');
    if (ids.has(node.id)) throw new Error(`invalid IR: duplicate node id ${node.id}`);
    if (typeof node.kind !== 'string') throw new Error(`invalid IR: node ${node.id} has no kind`);
    ids.add(node.id);
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child);
  };
  walk(tree);
  return ids;
}

function ancestorsOf(tree, id) {
  const path = [];
  const walk = (node) => {
    if (node.id === id) return true;
    for (const child of Array.isArray(node.children) ? node.children : []) {
      path.push(node.id);
      if (walk(child)) return true;
      path.pop();
    }
    return false;
  };
  return walk(tree) ? path : [];
}

// The node plus its ancestors (so a `--select` subtree can be read in context).
function selectedIds(tree, select) {
  const ids = nodeIds(tree);
  if (select === undefined) return ids;
  const numeric = /^\d+$/.test(String(select)) ? Number(select) : NaN;
  if (!ids.has(numeric)) throw new Error(`unknown node id: ${String(select)} (no such node in this IR)`);
  return new Set([numeric, ...ancestorsOf(tree, numeric)]);
}

export function effectKinds(node) {
  const kinds = [];
  const shadow = node.props?.shadow;
  if (Number.isFinite(shadow) && shadow > 0) kinds.push('shadow');
  if (node.props?.glass === true) kinds.push('glass');
  if (String(node.props?.gradient ?? '').includes(',')) kinds.push('gradient');
  if (Number.isFinite(node.props?.opacity) && node.props.opacity < 1) kinds.push('opacity');
  const custom = Array.isArray(node.props?.effects) ? node.props.effects : [];
  for (const effect of custom) {
    if (typeof effect?.kind === 'string' && !kinds.includes(effect.kind)) kinds.push(effect.kind);
  }
  return kinds;
}

// Subtree bounds: a node's own rect unioned with its descendants.
// Bounds reported by the a11y tree are absolute (same space for every node), so
// this is a plain rectangle union per node.
export function subtreeBounds(node, ownBounds, own = {}) {
  const ownRect = ownBounds ?? own[node.id]?.bounds ?? [0, 0, 0, 0];
  let [x0, y0] = ownRect;
  let x1 = x0 + ownRect[2];
  let y1 = y0 + ownRect[3];
  for (const child of Array.isArray(node.children) ? node.children : []) {
    const cb = subtreeBounds(child, undefined, own);
    x0 = Math.min(x0, cb[0]);
    y0 = Math.min(y0, cb[1]);
    x1 = Math.max(x1, cb[0] + cb[2]);
    y1 = Math.max(y1, cb[1] + cb[3]);
  }
  return [x0, y0, Math.max(0, x1 - x0), Math.max(0, y1 - y0)];
}

function effectCommandCount(commandsFile) {
  const commands = JSON.parse(fs.readFileSync(commandsFile, 'utf8'));
  const list = Array.isArray(commands) ? commands : commands?.commands;
  if (!Array.isArray(list)) throw new Error('renderer --commands output is not a command list');
  return list.filter((cmd) => typeof cmd?.kind === 'string' && cmd.kind.startsWith('effect_')).length;
}

function rendererBinary({ root, renderer }) {
  const found = renderer ?? ensureSiblingBinary('opurom-render', ['opurom-render', 'opurom_render'], { root }).path;
  if (!found) throw new Error('opurom-render unavailable: cannot compute widget bounds');
  return found;
}

function renderA11y(renderBin, irFile, tmp, tag) {
  const a11yFile = path.join(tmp, `a11y-${tag}.json`);
  const frame = path.join(tmp, `frame-${tag}.ppm`);
  const result = run(renderBin, [
    irFile, String(VIEWPORT.width), String(VIEWPORT.height), frame, '--a11y', a11yFile,
  ], { timeout: 30000 });
  const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.status !== 0 || !fs.existsSync(a11yFile)) {
    throw new Error(`opurom-render --a11y failed: ${detail || `exit ${result.status}`}`);
  }
  let nodes;
  try {
    nodes = JSON.parse(fs.readFileSync(a11yFile, 'utf8'));
  } catch (error) {
    throw new Error(`invalid a11y JSON: ${error.message}`);
  }
  if (!Array.isArray(nodes)) throw new Error('a11y tree is not an array');
  const match = /dirty[^\n]*?(\d+)/i.exec(`${result.stdout}${result.stderr}`);
  return { nodes, dirty: match ? Number(match[1]) : null };
}

function renderEffectCommandCount(renderBin, irFile, tmp) {
  const commandsFile = path.join(tmp, 'commands.json');
  const result = run(renderBin, [
    irFile, String(VIEWPORT.width), String(VIEWPORT.height), path.join(tmp, 'commands.ppm'),
    '--commands', commandsFile,
  ], { timeout: 30000 });
  return result.status === 0 && fs.existsSync(commandsFile) ? effectCommandCount(commandsFile) : null;
}

function collectRecords({ ir, a11y, only }) {
  const own = new Map(a11y.nodes.map((node) => [node.id, node]));
  const records = [];
  const children = new Map();
  const visit = (node, depth) => {
    const kids = Array.isArray(node.children) ? node.children : [];
    children.set(node.id, kids.map((child) => child.id));
    if (only.has(node.id)) {
      const bounds = own.get(node.id)?.bounds ?? [0, 0, 0, 0];
      records.push({
        id: node.id,
        depth,
        kind: node.kind,
        component: stringProp(node.props, 'component'),
        key: stringProp(node.props, 'key'),
        props: node.props ?? {},
        bounds,
        subtreeBounds: subtreeBounds(node, bounds, own),
        hidden: Boolean(own.get(node.id)?.hidden),
        when: stringProp(node, 'when'),
        unless: stringProp(node, 'unless'),
        events: Object.keys(node.events ?? {}).sort(),
        layers: effectKinds(node),
      });
    }
    for (const child of kids) visit(child, depth + 1);
  };
  visit(ir.tree, 0);
  return { records, children };
}

export function inspectTree({ ir, select = undefined, layers = false, json: jsonMode = false, root = workspaceRoot(), renderer = null, log = console.log } = {}) {
  const irAbs = path.resolve(ir);
  if (!fs.existsSync(irAbs)) throw new Error(`IR file not found: ${irAbs}`);
  const before = fs.readFileSync(irAbs);
  const parsed = readIr(irAbs);
  const only = selectedIds(parsed.tree, select);
  const renderBin = rendererBinary({ root, renderer });

  const tmp = tmpDir('inspect-tree-');
  try {
    const a11y = renderA11y(renderBin, irAbs, tmp, 'base');
    const { records, children } = collectRecords({ ir: parsed, a11y, only });
    let dirty = null;
    let effectCommands = null;
    if (layers) {
      const visual = renderA11y(renderBin, irAbs, tmp, 'visual');
      dirty = visual.dirty;
      effectCommands = renderEffectCommandCount(renderBin, irAbs, tmp);
    }
    const after = fs.readFileSync(irAbs);
    if (!before.equals(after)) throw new Error('IR file changed during inspection (read-only violation)');

    const view = { ir: parsed, records, children, dirty, effectCommands, selected: select ?? null, layers };
    log(jsonMode ? JSON.stringify(treeJson(view), null, 2) : formatTreeText(view));
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const boundsText = (bounds) => `[${bounds.join(',')}]`;

function conditionText(record) {
  const parts = [];
  if (record.when) parts.push(`when=${record.when}`);
  if (record.unless) parts.push(`unless=${record.unless}`);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

function scalarProps(record) {
  return Object.keys(record.props)
    .filter((key) => typeof record.props[key] !== 'object' || record.props[key] === null)
    .sort()
    .map((key) => `${key}=${q(record.props[key])}`)
    .join(' ');
}

function rowsFor(record) {
  const indent = '  '.repeat(record.depth);
  const inner = '  '.repeat(record.depth + 1);
  const named = record.component ? ` component=${record.component}` : '';
  const keyed = record.key ? ` key=${q(record.key)}` : '';
  const hidden = record.hidden ? ' hidden' : '';
  const rows = [
    `${indent}#${record.id} ${record.kind}${named}${keyed}`
      + ` bounds=${boundsText(record.bounds)} subtree=${boundsText(record.subtreeBounds)}${hidden}${conditionText(record)}`,
  ];
  const props = scalarProps(record);
  if (props) rows.push(`${inner}props: ${props}`);
  if (record.events.length) rows.push(`${inner}events: ${record.events.join(',')}`);
  return rows;
}

export function formatTreeText({ ir, records, dirty, effectCommands, layers }) {
  const dirtyText = Number.isInteger(dirty) ? `${dirty} rect${dirty === 1 ? '' : 's'}` : 'n/a (not requested)';
  const lines = [
    'OPUROM inspect widget tree (read-only; bounds from opurom-render --a11y)',
    `app: ${ir.app ?? '?'} (ir ${ir.ir})`,
    `viewport: ${VIEWPORT.width}x${VIEWPORT.height}`,
  ];
  for (const record of records) rowsFor(record).forEach((row) => lines.push(row));
  if (layers) {
    lines.push('');
    for (const record of records) {
      const indent = '  '.repeat(record.depth + 1);
      const list = record.layers.length ? record.layers.join(', ') : '(none)';
      lines.push(`${indent}layer #${record.id} ${record.kind}: ${list} dirty=${dirtyText}`);
    }
    const effects = Number.isInteger(effectCommands) ? `${effectCommands} effect command${effectCommands === 1 ? '' : 's'}` : 'n/a';
    lines.push(`layer summary: dirty-rects=${dirtyText} (frame-wide; the software renderer reports no per-node rect list)`);
    lines.push(`effect layers: ${effects} (whole-frame effect_* passes from --commands)`);
  }
  return lines.join('\n');
}

// Top-level keys in a fixed order so the JSON form is byte-stable.
export function treeJson({ ir, records, children, dirty, effectCommands, selected, layers }) {
  const kept = new Set(records.map((record) => record.id));
  const nodes = records.map((record) => ({
    id: record.id,
    depth: record.depth,
    kind: record.kind,
    component: record.component,
    key: record.key,
    children: (children.get(record.id) ?? []).filter((id) => kept.has(id)),
    props: record.props,
    bounds: record.bounds,
    subtreeBounds: record.subtreeBounds,
    hidden: record.hidden,
    conditions: { when: record.when, unless: record.unless },
    events: record.events,
    ...(layers ? { layers: record.layers, dirtyRects: Number.isInteger(dirty) ? dirty : null } : {}),
  }));
  return {
    command: 'inspect',
    mode: 'tree',
    app: ir.app ?? null,
    viewport: { width: VIEWPORT.width, height: VIEWPORT.height },
    ...(layers ? { dirtyRects: Number.isInteger(dirty) ? dirty : null, effectCommands } : {}),
    selected,
    nodes,
  };
}
