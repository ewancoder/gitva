/**
 * The one bit of the painter that is not "check it by looking at it": which
 * nodes a selection lights. It is pure set arithmetic over the scene's edges,
 * and it has already been got wrong once — hover had pre-lit neighbours the
 * parent pass then treated as its own, so parents came out two levels deep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import type { Scene, SceneEdge } from '../src/layout.js';
import { path } from '../web/render.js';

/** c2 → c1 → c0, and c2 holds a tree holding a blob. */
const edges: SceneEdge[] = [
  { id: 'p:c2:c1', from: 'c2', to: 'c1', kind: 'parent' },
  { id: 'p:c1:c0', from: 'c1', to: 'c0', kind: 'parent' },
  { id: 't:c2', from: 'c2', to: 't2', kind: 'tree' },
  { id: 'e:t2:b', from: 't2', to: 'b', kind: 'entry' },
];
const scene = { nodes: [], edges, bands: [], width: 0, height: 0, rows: [] } satisfies Scene;

function lit(start: string, already: string[] = []) {
  const nodes = new Set(already);
  path(scene, start, nodes, new Set());
  return nodes;
}

test('a selected commit lights its parents, one level only', () => {
  assert.deepEqual([...lit('c2')].sort(), ['b', 'c1', 'c2', 't2']);
});

test('a commit reached from a blob brings its parents too', () => {
  assert.ok(lit('b').has('c1'));
});

test('hover does not extend the parent walk past one level', () => {
  // Hovering c2 lights c1 through the parent edge before the selection walk
  // runs. c1's own parent is not on the selection's path and must stay dark.
  assert.ok(!lit('c2', ['c1']).has('c0'));
});
