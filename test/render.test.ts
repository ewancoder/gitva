/**
 * The painter. What it draws is checked by looking at it — but what it *picks*
 * is not: which nodes a selection lights, what is under the pointer, and which
 * hue each thing gets are decisions, and a decision belongs in a test.
 *
 * `path` has already been got wrong once — hover had pre-lit neighbours the
 * parent pass then treated as its own, so parents came out two levels deep.
 */

import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Scene, SceneEdge, SceneNode } from '../src/layout.js';
import { EMPTY_CHANGE } from '../src/diff.js';
import { draw, hitTest, path, snapPositions, type Paint } from '../web/render.js';
import { chipHue, hueFor, theme } from '../web/theme.js';

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

// ---------------------------------------------------------------------------

const node = (over: Partial<SceneNode> & Pick<SceneNode, 'id' | 'kind'>): SceneNode => ({
  x: 0,
  y: 0,
  w: 40,
  h: 20,
  label: over.id,
  ...over,
});

describe('what is under the pointer', () => {
  const hits = {
    nodes: [node({ id: 'a', kind: 'blob' }), node({ id: 'b', kind: 'commit', x: 100, y: 100 })],
    edges: [],
    bands: [],
    width: 200,
    height: 200,
    rows: [],
  } satisfies Scene;

  it('finds the node the point is inside', () => {
    assert.equal(hitTest(hits, 110, 110)?.id, 'b');
  });

  it('finds nothing in the space between nodes', () => {
    assert.equal(hitTest(hits, 70, 70), null);
  });

  it('forgives three pixels, so a small chip can still be clicked', () => {
    assert.equal(hitTest(hits, -2, -2)?.id, 'a');
    assert.equal(hitTest(hits, -4, -4), null);
  });

  it('takes the last one drawn, which is the one on top', () => {
    const stacked = { ...hits, nodes: [node({ id: 'under', kind: 'blob' }), node({ id: 'over', kind: 'tree' })] };
    assert.equal(hitTest(stacked, 5, 5)?.id, 'over');
  });
});

describe('hues', () => {
  it('gives the three object kinds the three hues, and everything else ink', () => {
    assert.deepEqual(
      ['commit', 'tree', 'blob', 'ref'].map(hueFor),
      [theme.commit, theme.tree, theme.blob, theme.ink],
    );
  });

  it('tells the kinds of pointer apart by their outline', () => {
    assert.equal(chipHue('head', 'HEAD'), theme.head);
    assert.equal(chipHue('tag', 'g1'), theme.tagObject);
    assert.equal(chipHue('ref', 'ref:refs/heads/main'), theme.refLocal);
    assert.equal(chipHue('ref', 'ref:refs/remotes/origin/main'), theme.refRemote);
    assert.equal(chipHue('ref', 'ref:refs/tags/v1'), theme.refTag);
    assert.equal(chipHue('index', 'index:0:a.txt'), theme.muted);
  });
});

/**
 * A canvas that records nothing and refuses nothing. Painting is checked by
 * looking at it; this is only here so the branches that decide *what* to paint
 * — every shape, every tier of label, ghosts, marks, flashes — are walked, and
 * so the easing that tells the client whether to ask for another frame is.
 */
function fakeCtx(): CanvasRenderingContext2D {
  const it = {
    globalAlpha: 1,
    lineWidth: 1,
    font: '',
    fillStyle: '',
    strokeStyle: '',
    textAlign: 'left',
    measureText: (s: string) => ({ width: s.length * 7 }),
  } as unknown as Record<string, unknown>;
  return new Proxy(it, {
    get: (t, k) => (k in t ? t[k as string] : () => {}),
    set: (t, k, v) => ((t[k as string] = v), true),
  }) as unknown as CanvasRenderingContext2D;
}

describe('painting', () => {
  const full = {
    nodes: [
      node({ id: 'c1', kind: 'commit', oid: 'c1', sub: 'a subject', y: 0 }),
      node({ id: 'c0', kind: 'commit', oid: 'c0', y: 100, unreachable: true }),
      node({ id: 'c2', kind: 'commit', oid: 'c2', x: 80, y: 200 }), // another lane
      node({ id: 't1', kind: 'tree', oid: 't1', x: 100 }),
      node({ id: 'b1', kind: 'blob', oid: 'b1', x: 200, staged: true, origin: 't1' }),
      node({ id: 'g1', kind: 'tag', oid: 'g1', x: 240 }),
      node({ id: 'ref:refs/heads/main', kind: 'ref', x: 300, y: 60, sub: 'aaaaaaa' }),
      node({ id: 'HEAD', kind: 'head', x: 360, y: 60 }),
      node({ id: 'index:0:a.txt', kind: 'index', x: 400, y: 60, conflict: true }),
      node({ id: 'more', kind: 'more', x: 450, y: 60 }),
      node({ id: 'sub', kind: 'submodule', x: 500, y: 60 }),
    ],
    edges: [
      { id: 'p', from: 'c1', to: 'c0', kind: 'parent' },
      { id: 'p2', from: 'c0', to: 'c1', kind: 'parent' }, // a child dragged above its parent
      { id: 'p3', from: 'c0', to: 'c2', kind: 'parent' }, // a parent in another lane: an elbow
      { id: 't', from: 'c1', to: 't1', kind: 'tree' },
      { id: 'e', from: 't1', to: 'b1', kind: 'entry', label: 'a.txt' },
      { id: 'ptr', from: 'ref:refs/heads/main', to: 'c1', kind: 'pointer' },
      { id: 's', from: 'index:0:a.txt', to: 'b1', kind: 'stage' },
    ] satisfies SceneEdge[],
    bands: [
      { key: 'commits' as const, label: 'commits', x: 0, w: 90 },
      { key: 'index' as const, label: 'index', x: 400, w: 90 },
    ],
    width: 700,
    height: 200,
    rows: [],
  } satisfies Scene;

  const paint = (over: Partial<Paint> = {}): Paint => ({
    camera: { x: 0, y: 0, scale: 1.5 },
    width: 800,
    height: 400,
    dpr: 2,
    change: EMPTY_CHANGE,
    flash: 0,
    hover: null,
    selected: null,
    marked: new Set<string>(),
    enter: 1,
    ghosts: [],
    motion: true,
    ...over,
  });

  /** Draw until nothing is still moving; the frame count, or a failure. */
  function settle(s: Scene, p: Paint = paint()): number {
    let frames = 1;
    while (draw(fakeCtx(), s, p)) assert.ok(++frames < 200, 'easing has to converge');
    return frames;
  }

  const dragged = (s: Scene) => ({
    ...s,
    nodes: [node({ id: 'c1', kind: 'commit', x: 0, y: 900 }), ...s.nodes.slice(1)],
  });

  it('draws every kind, at every tier of detail, without falling over', () => {
    for (const scale of [0.3, 0.6, 1.2, 1.5]) {
      snapPositions();
      settle(full, paint({ camera: { x: 0, y: 0, scale } }));
    }
  });

  it('draws what is arriving, what is going, and what is picked out', () => {
    snapPositions();
    settle(
      full,
      paint({
        change: { added: new Set(['b1']), removed: new Set(['old']), updated: new Set(['c1']), moved: new Set() },
        flash: 1,
        enter: 0.5,
        hover: 'c1',
        selected: 'b1',
        marked: new Set(['b1']),
        ghosts: [node({ id: 'old', kind: 'blob', x: 50 })],
      }),
    );
  });

  it('keeps asking for frames while a node is still travelling, and stops when it arrives', () => {
    snapPositions();
    settle(full);
    assert.equal(draw(fakeCtx(), dragged(full), paint()), true, 'it has somewhere to get to');
    settle(dragged(full));
  });

  it('snaps rather than eases when the reader asked for no motion', () => {
    snapPositions();
    const still = paint({ motion: false });
    draw(fakeCtx(), full, still);
    assert.equal(draw(fakeCtx(), dragged(full), still), false);
  });

  it('draws nothing that is off screen', () => {
    snapPositions();
    // The camera is miles away: every node and every edge is culled, and the
    // frame still comes out settled.
    assert.equal(draw(fakeCtx(), full, paint({ camera: { x: -50_000, y: -50_000, scale: 1 } })), false);
  });
});
