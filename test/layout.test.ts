/**
 * Layout is a pure function of the state being drawn, so it is tested here,
 * before anything paints it. Stability is the load-bearing property: a node
 * that flashes *and* moves teaches nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignLanes, layout, objectGraph, M } from '../src/layout.js';
import { DEFAULT_VIEW, type Commit, type Snapshot, type View } from '../src/types.js';

const oid = (n: string) => n.padEnd(40, '0');

function fakeSnapshot(commits: Record<string, string[]>, extra: Partial<Snapshot> = {}): Snapshot {
  const order = Object.keys(commits);
  const asCommit = (o: string): Commit => ({
    oid: oid(o),
    tree: oid('t' + o),
    parents: commits[o].map(oid),
    author: 'A <a@b>',
    authorDate: 0,
    committer: 'A <a@b>',
    subject: `commit ${o}`,
    message: `commit ${o}`,
  });
  return {
    seq: 1,
    time: 0,
    repo: 'fake',
    gitDir: '/tmp/fake/.git',
    head: { ref: 'refs/heads/main', oid: oid(order[0]), detached: false, unborn: false },
    refs: [
      {
        name: 'refs/heads/main',
        oid: oid(order[0]),
        objectType: 'commit',
        packed: false,
      },
    ],
    objects: {},
    commits: Object.fromEntries(order.map((o) => [oid(o), asCommit(o)])),
    trees: {},
    tags: {},
    index: [],
    unreachable: [],
    caps: {
      objectCount: 10,
      looseCount: 10,
      refCount: 1,
      fullLoad: true,
      indexNodes: true,
      commitGraph: false,
      limits: { fullLoad: 60_000, indexNodes: 400 },
    },
    window: { commits: order.map(oid), totalCommits: order.length, more: false, refsOutside: 0 },
    view: DEFAULT_VIEW,
    notes: [],
    ...extra,
  };
}

describe('lanes', () => {
  it('keeps a linear history in one lane', () => {
    const { lane, laneCount } = assignLanes(['a', 'b', 'c'], (o) => (o === 'c' ? [] : [String.fromCharCode(o.charCodeAt(0) + 1)]));
    assert.equal(laneCount, 1);
    assert.deepEqual([lane.get('a'), lane.get('b'), lane.get('c')], [0, 0, 0]);
  });

  it('fans a merge out and lets the lane close again', () => {
    // m -> (x, y) -> both -> base
    const parents: Record<string, string[]> = { m: ['x', 'y'], x: ['base'], y: ['base'], base: [] };
    const { lane, laneCount } = assignLanes(['m', 'x', 'y', 'base'], (o) => parents[o]);
    assert.equal(lane.get('m'), 0);
    assert.notEqual(lane.get('x'), lane.get('y'));
    assert.equal(laneCount, 2);
  });

  it('releases a lane whose parent is outside the window', () => {
    const { laneCount } = assignLanes(['a', 'b'], (o) => (o === 'a' ? ['gone'] : []));
    assert.equal(laneCount, 1);
  });
});

describe('a commit\'s objects', () => {
  const trees = {
    root: [
      { name: 'a.txt', oid: 'shared', mode: '100644', type: 'blob' },
      { name: 'lib', oid: 'lib', mode: '40000', type: 'tree' },
    ],
    lib: [{ name: 'c.txt', oid: 'shared', mode: '100644', type: 'blob' }],
  };

  it('places a shared blob at its deepest column so no arrow points backwards', () => {
    const g = objectGraph('root', trees);
    assert.equal(g.depth.get('root'), 0);
    assert.equal(g.depth.get('lib'), 1);
    assert.equal(g.depth.get('shared'), 2, 'the longest path from the root wins');
    assert.equal(g.columns[2].length, 1, 'and it is placed once');
  });

  it('keeps the entries in the order git lists them', () => {
    const g = objectGraph('root', trees);
    assert.deepEqual(
      g.edges.filter((e) => e.from === 'root').map((e) => e.label),
      ['a.txt', 'lib'],
    );
  });

  it('marks an executable and a symlink on the arrow', () => {
    const g = objectGraph('r', {
      r: [
        { name: 'run.sh', oid: 'x', mode: '100755', type: 'blob' },
        { name: 'link', oid: 'y', mode: '120000', type: 'blob' },
      ],
    });
    assert.deepEqual(g.edges.map((e) => e.label), ['run.sh +x', 'link ->']);
  });
});

describe('the scene', () => {
  const snap = fakeSnapshot({ c: ['b'], b: ['a'], a: [] });

  it('is the same picture every time it is drawn', () => {
    assert.deepEqual(layout(snap, DEFAULT_VIEW), layout(snap, DEFAULT_VIEW));
  });

  it('does not move anything sideways when a commit lands on top', () => {
    const before = layout(snap, DEFAULT_VIEW);
    const after = layout(fakeSnapshot({ d: ['c'], c: ['b'], b: ['a'], a: [] }), DEFAULT_VIEW);
    for (const n of before.nodes) {
      const same = after.nodes.find((m) => m.id === n.id);
      if (!same) continue;
      assert.equal(same.x, n.x, `${n.id} stayed in its lane`);
    }
  });

  it('accordions a row open, pushing everything below down by a predictable amount', () => {
    const withTrees = fakeSnapshot({ c: ['b'], b: ['a'], a: [] });
    withTrees.trees[oid('tc')] = [
      { name: 'a.txt', oid: oid('blob1'), mode: '100644', type: 'blob' },
      { name: 'b.txt', oid: oid('blob2'), mode: '100644', type: 'blob' },
      { name: 'c.txt', oid: oid('blob3'), mode: '100644', type: 'blob' },
    ];
    const folded = layout(withTrees, DEFAULT_VIEW);
    const view: View = { ...DEFAULT_VIEW, expanded: [oid('c')] };
    const open = layout(withTrees, view);

    assert.equal(folded.rows[0].h, M.rowH);
    assert.ok(open.rows[0].h > folded.rows[0].h, 'the row grew');
    const grew = open.rows[0].h - folded.rows[0].h;
    assert.equal(open.rows[1].y - folded.rows[1].y, grew, 'and the row below shifted by exactly that');
    assert.ok(open.nodes.some((n) => n.id === oid('blob1')));
  });

  it('draws a parent outside the window as an arrow into "history continues"', () => {
    const s = fakeSnapshot({ c: ['b'], b: ['gone'] });
    const scene = layout(s, DEFAULT_VIEW);
    assert.ok(scene.nodes.some((n) => n.kind === 'more'));
    assert.ok(scene.edges.some((e) => e.from === oid('b') && e.to === 'more'));
    assert.ok(!scene.edges.some((e) => e.to === oid('gone')), 'never an edge to a node that is not there');
  });

  it('puts HEAD outside the ref it names, pointing at it', () => {
    const scene = layout(snap, DEFAULT_VIEW);
    const head = scene.nodes.find((n) => n.kind === 'head')!;
    const ref = scene.nodes.find((n) => n.kind === 'ref')!;
    assert.ok(head.x < ref.x, 'HEAD sits outside the ref');
    assert.ok(scene.edges.some((e) => e.from === 'HEAD' && e.to === ref.id));
    assert.ok(scene.edges.some((e) => e.from === ref.id && e.to === oid('c')));
  });

  it('points a detached HEAD straight at the commit', () => {
    const s = fakeSnapshot({ c: ['b'], b: [] }, {});
    s.head = { oid: oid('c'), detached: true, unborn: false };
    s.refs = [];
    const scene = layout(s, DEFAULT_VIEW);
    assert.ok(scene.edges.some((e) => e.from === 'HEAD' && e.to === oid('c')));
  });

  it('leaves a ref pointing outside the window out of the drawing', () => {
    const s = fakeSnapshot({ c: ['b'], b: [] });
    s.refs.push({ name: 'refs/heads/old', oid: oid('gone'), objectType: 'commit', packed: true });
    const scene = layout(s, DEFAULT_VIEW);
    assert.equal(scene.nodes.filter((n) => n.kind === 'ref').length, 1);
  });

  it('hides the index outright when it is switched off', () => {
    const s = fakeSnapshot({ a: [] });
    s.index = [{ path: 'a.txt', oid: oid('blob1'), mode: '100644', stage: 0 }];
    assert.ok(layout(s, DEFAULT_VIEW).nodes.some((n) => n.kind === 'index'));
    const off = layout(s, { ...DEFAULT_VIEW, showIndex: false });
    assert.ok(!off.nodes.some((n) => n.kind === 'index'), 'taken out of the drawing, not merely invisible');
    assert.ok(!off.bands.some((b) => b.key === 'index'));
  });

  it('marks a conflict entry differently from a clean one', () => {
    const s = fakeSnapshot({ a: [] });
    s.index = [
      { path: 'a.txt', oid: oid('blob1'), mode: '100644', stage: 0 },
      { path: 'b.txt', oid: oid('blob2'), mode: '100644', stage: 2 },
    ];
    const scene = layout(s, DEFAULT_VIEW);
    const entries = scene.nodes.filter((n) => n.kind === 'index');
    assert.deepEqual(entries.map((e) => e.conflict), [false, true]);
  });

  it('draws an orphan nothing points at, never silently dropping it', () => {
    const s = fakeSnapshot({ a: [] });
    s.objects[oid('lost')] = { oid: oid('lost'), type: 'blob', size: 7 };
    s.unreachable = [oid('lost')];
    const scene = layout(s, DEFAULT_VIEW);
    const lost = scene.nodes.find((n) => n.id === oid('lost'))!;
    assert.ok(lost);
    assert.equal(lost.unreachable, true);
  });

  it('lets a pin override a position without disturbing anything else', () => {
    const free = layout(snap, DEFAULT_VIEW);
    const pinned = layout(snap, DEFAULT_VIEW, { [oid('b')]: { x: 999, y: 888 } });
    const moved = pinned.nodes.find((n) => n.id === oid('b'))!;
    assert.deepEqual([moved.x, moved.y], [999, 888]);
    const other = pinned.nodes.find((n) => n.id === oid('a'))!;
    assert.deepEqual(other, free.nodes.find((n) => n.id === oid('a')));
  });

  it('is fast enough on twenty thousand commits', () => {
    const many: Record<string, string[]> = {};
    for (let i = 0; i < 20_000; i++) many[`c${i}`] = i === 19_999 ? [] : [`c${i + 1}`];
    const s = fakeSnapshot(many);
    const t0 = performance.now();
    const scene = layout(s, DEFAULT_VIEW);
    const ms = performance.now() - t0;
    assert.equal(scene.rows.length, 20_000);
    assert.ok(ms < 100, `deciding where 20,000 commits go took ${ms.toFixed(1)}ms`);
  });
});
