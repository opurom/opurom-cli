import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../lib/paths.mjs';
import { formatTreeText, inspectTree, subtreeBounds, treeJson } from '../lib/inspect_tree.mjs';

// The fixture was compiled with the real `opuromc 0.2.0` and its `.a11y.json`
// written by the real `opurom-render`; the stub below replays those exact bytes,
// so the bounds asserted here are the renderer's real numbers, not invented.
const IR_FIXTURE = fileURLToPath(new URL('./fixtures/widget-inspect.opuir.json', import.meta.url));
const A11Y_FIXTURE = fileURLToPath(new URL('./fixtures/widget-inspect.a11y.json', import.meta.url));
const A11Y_LINES = fs.readFileSync(A11Y_FIXTURE, 'utf8').trimEnd().split('\n');

const RENDERER_STUB = `#!/bin/sh
cat <<'EOF'
digest=577bcf14bcbac5f0
dirty=1
EOF
a11y=""
commands=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--a11y" ]; then a11y="$arg"; fi
  if [ "$prev" = "--commands" ]; then commands="$arg"; fi
  prev="$arg"
done
if [ -n "$a11y" ]; then
  cat <<'EOF' > "$a11y"
${A11Y_LINES.join('\n')}
EOF
fi
if [ -n "$commands" ]; then
  printf '%s' '[]' > "$commands"
fi
printf 'P6\\n1 1\\n255\\n' > "$4"
`;

function workspaceWithRenderer() {
  const base = tmpDir('inspect-tree-test-');
  const renderer = path.join(base, 'opurom-render');
  fs.writeFileSync(renderer, RENDERER_STUB, { mode: 0o755 });
  return { base, renderer };
}

function runTree(options = {}) {
  const { base, renderer } = workspaceWithRenderer();
  const lines = [];
  try {
    const code = inspectTree({ ir: IR_FIXTURE, root: base, renderer, log: (line) => lines.push(String(line)), ...options });
    assert.equal(code, 0);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  return lines.join('\n');
}

function runTreeJson(options = {}) {
  return JSON.parse(runTree({ json: true, ...options }));
}

test('the widget tree shows ids, kinds, computed bounds and real visibility conditions', () => {
  const text = runTree();
  assert.match(text, /^OPUROM inspect widget tree \(read-only; bounds from opurom-render --a11y\)/);
  assert.match(text, /^app: WidgetInspectorFixture \(ir 0\.1\)$/m);
  // Real bounds from the fixture's .a11y.json, not fabricated.
  assert.match(text, /^#0 Column bounds=\[0,0,800,600\] subtree=\[0,0,800,600\]$/m);
  assert.match(text, /^    #2 Text bounds=\[320,16,160,28\] subtree=\[320,16,160,28\]$/m);
  assert.match(text, /^      #5 Text bounds=\[32,68,72,24\] subtree=\[32,68,72,24\]$/m);
  // `if/else` lowers to visible-only when/unless; the taken branch is not hidden.
  assert.match(text, /^ {2}#6 Container .* hidden when=dark$/m);
  assert.match(text, /^ {2}#8 Container .* unless=dark$/m);
  assert.doesNotMatch(text, /#9 Text .*hidden/);
  // Key props and events are listed under each node.
  assert.match(text, /^ {2}#3 Card bounds=\[20,56,760,193\] subtree=\[0,0,780,249\]$/m);
  assert.match(text, /props: .*glass=true .*shadow=2/);
  assert.match(text, /^ {2}#10 Button bounds=\[352,289,96,142\] subtree=\[352,289,96,142\]$/m);
  assert.match(text, /events: tap/);
});

test('--select returns the chosen subtree with its ancestor path and rejects unknown ids', () => {
  const text = runTree({ select: '3' });
  assert.match(text, /^#0 Column bounds=/m);
  assert.match(text, /^  #3 Card bounds=\[20,56,760,193\] subtree=\[0,0,780,249\]$/m);
  // Siblings and the selected node's own children are not part of the path.
  assert.doesNotMatch(text, /^  #4 Container/m);
  assert.doesNotMatch(text, /^  #1 Container/m);
  assert.throws(() => runTree({ select: '99' }), /unknown node id: 99/);
  assert.throws(() => runTree({ select: 'x' }), /unknown node id: x/);
});

test('--layers lists effect layers per node and the frame-wide dirty-rect count', () => {
  const text = runTree({ layers: true });
  assert.match(text, /^    layer #3 Card: shadow, glass, gradient, opacity dirty=1 rect$/m);
  assert.match(text, /^  layer #0 Column: \(none\) dirty=1 rect$/m);
  assert.match(text, /^layer summary: dirty-rects=1 rect/m);
  assert.match(text, /^effect layers: 0 effect commands/m);
});

test('identical IR gives byte-identical text and JSON output', () => {
  assert.equal(runTree(), runTree());
  assert.equal(runTree({ layers: true }), runTree({ layers: true }));
  assert.equal(runTree({ json: true }), runTree({ json: true }));
  assert.equal(runTree({ select: '3', json: true }), runTree({ select: '3', json: true }));
});

test('the JSON form keeps a stable key order and schema', () => {
  const full = runTreeJson();
  assert.equal(Object.keys(full).join(','), 'command,mode,app,viewport,selected,nodes');
  assert.deepEqual(full.viewport, { width: 800, height: 600 });
  assert.equal(full.command, 'inspect');
  assert.equal(full.mode, 'tree');
  assert.equal(full.selected, null);
  const first = full.nodes[0];
  assert.equal(Object.keys(first).join(','),
    'id,depth,kind,component,key,children,props,bounds,subtreeBounds,hidden,conditions,events');
  assert.deepEqual(first.children, [1, 3, 6, 8, 10]);
  assert.deepEqual(first.bounds, [0, 0, 800, 600]);
  // --layers adds the layer fields after the stable keys, in a fixed order.
  const withLayers = runTreeJson({ layers: true });
  assert.equal(Object.keys(withLayers).join(','), 'command,mode,app,viewport,dirtyRects,effectCommands,selected,nodes');
  assert.equal(withLayers.dirtyRects, 1);
  assert.equal(withLayers.effectCommands, 0);
  const card = withLayers.nodes.find((node) => node.id === 3);
  assert.deepEqual(Object.keys(card).slice(-2), ['layers', 'dirtyRects']);
  assert.deepEqual(card.layers, ['shadow', 'glass', 'gradient', 'opacity']);
});

test('the text and JSON forms are derived from the same record view', () => {
  const json = runTreeJson({ layers: true });
  const text = runTree({ layers: true });
  const node = json.nodes.find((entry) => entry.id === 5);
  assert.match(text, new RegExp(`#5 Text bounds=\\[${node.bounds.join(',')}\\]`));
  assert.equal(node.hidden, false);
  assert.equal(node.conditions.when, null);
});

test('subtree bounds union a node with its descendants in absolute coordinates', () => {
  const own = { 0: { bounds: [0, 0, 100, 100] }, 1: { bounds: [10, 10, 20, 20] }, 2: { bounds: [15, 15, 10, 10] } };
  const tree = {
    id: 0,
    kind: 'Column',
    children: [{ id: 1, kind: 'Card', children: [{ id: 2, kind: 'Text', children: [] }] }],
  };
  assert.deepEqual(subtreeBounds(tree, own[0].bounds, own), [0, 0, 100, 100]);
  assert.deepEqual(subtreeBounds(tree.children[0], own[1].bounds, own), [10, 10, 20, 20]);

  // A container whose child sits outside it still unions the child.
  const wide = { 0: { bounds: [0, 0, 10, 10] }, 1: { bounds: [40, 40, 5, 5] } };
  const outer = { id: 0, kind: 'Column', children: [{ id: 1, kind: 'Text', children: [] }] };
  assert.deepEqual(subtreeBounds(outer, wide[0].bounds, wide), [0, 0, 45, 45]);
});
