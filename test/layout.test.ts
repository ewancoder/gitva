/**
 * Layout is a pure function of the state being drawn, so it is tested here,
 * before anything paints it. Stability is the load-bearing property: a node
 * that flashes *and* moves teaches nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignLanes, layout, objectGraph, M } from '../src/layout.js';
import { explain } from '../src/explain.js';
import { DEFAULT_VIEW, type Commit, type Snapshot, type View } from '../src/types.js';

// The separator matters: without it `c1`, `c10` and `c100` all pad to the same
// forty characters, and the twenty-thousand-commit case stops being a chain.
const oid = (n: string) => (n + '-').padEnd(40, '0');

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

  it('frees the lane of a branch whose parent another lane already holds', () => {
    // a and b both fork off base: b's lane has nothing left to carry, so the
    // next tip reuses it instead of the graph creeping one lane rightwards.
    const parents: Record<string, string[]> = { a: ['base'], b: ['base'], base: ['root'], c: [], root: [] };
    const { lane, laneCount } = assignLanes(['a', 'b', 'base', 'c', 'root'], (o) => parents[o]);
    assert.equal(lane.get('c'), lane.get('b'));
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

  it('explains the ref chips it draws — the scene keys them, the panel looks them up', () => {
    const chip = layout(snap, DEFAULT_VIEW).nodes.find((n) => n.kind === 'ref')!;
    const facts = explain(snap, 'ref', chip.id).facts;
    assert.deepEqual(facts.find(([k]) => k === 'name'), ['name', 'refs/heads/main']);
    assert.ok(facts.some(([k, v]) => k === 'contains' && v === oid('c')));
  });

  it('draws a parent outside the window as an arrow into "history continues"', () => {
    const s = fakeSnapshot({ c: ['b'], b: ['gone'] });
    const scene = layout(s, DEFAULT_VIEW);
    assert.ok(scene.nodes.some((n) => n.kind === 'more'));
    assert.ok(scene.edges.some((e) => e.from === oid('b') && e.to === 'more'));
    assert.ok(!scene.edges.some((e) => e.to === oid('gone')), 'never an edge to a node that is not there');
  });

  it('offers no "history continues" under a search — those parents did not match', () => {
    const view = { ...DEFAULT_VIEW, question: { kind: 'search', text: 'x', in: 'content' } as const };
    const s = fakeSnapshot({ c: ['b'], b: ['gone'] }, { view });
    const scene = layout(s, view);
    assert.ok(!scene.nodes.some((n) => n.kind === 'more'));
    assert.ok(!scene.edges.some((e) => e.to === 'more'));
  });

  it('puts HEAD outside the ref it names, pointing at it', () => {
    const scene = layout(snap, DEFAULT_VIEW);
    const head = scene.nodes.find((n) => n.kind === 'head')!;
    const ref = scene.nodes.find((n) => n.kind === 'ref')!;
    assert.ok(head.x < ref.x, 'HEAD sits outside the ref');
    assert.ok(scene.edges.some((e) => e.from === 'HEAD' && e.to === ref.id));
    assert.ok(scene.edges.some((e) => e.from === ref.id && e.to === oid('c')));
  });

  it('writes a remote as origin/branch, not remotes/origin/branch', () => {
    // 72px chips cannot hold the longer form, and "remotes/" is already the band.
    const s = fakeSnapshot({ a: [] });
    s.refs = [
      { name: 'refs/heads/main', oid: oid('a'), objectType: 'commit', packed: false },
      { name: 'refs/remotes/origin/main', oid: oid('a'), objectType: 'commit', packed: false },
    ];
    const scene = layout(s, DEFAULT_VIEW);
    const labels = scene.nodes.filter((n) => n.kind === 'ref').map((n) => n.label).sort();
    assert.deepEqual(labels, ['main', 'origin/main']);
  });

  it('points a detached HEAD straight at the commit', () => {
    const s = fakeSnapshot({ c: ['b'], b: [] }, {});
    s.head = { oid: oid('c'), detached: true, unborn: false };
    s.refs = [];
    const scene = layout(s, DEFAULT_VIEW);
    assert.ok(scene.edges.some((e) => e.from === 'HEAD' && e.to === oid('c')));
  });

  it('still draws HEAD on a repo with nothing in it yet', () => {
    const s = fakeSnapshot({}, {});
    s.head = { ref: 'refs/heads/main', detached: false, unborn: true };
    s.refs = [];
    const scene = layout(s, DEFAULT_VIEW);
    const head = scene.nodes.find((n) => n.kind === 'head')!;
    assert.ok(head, 'a fresh git init is not an empty screen');
    assert.equal(head.sub, 'main');
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

  it('keeps the arrows between objects that were orphaned together', () => {
    // A discarded commit -> its tree -> its blob, all lost at the same moment,
    // plus one still-reachable blob the lost tree also names.
    const s = fakeSnapshot({ a: [] });
    const [lost, tree, blob, kept] = ['lost', 'tlost', 'blost', 'kept'].map(oid);
    s.commits[lost] = { ...s.commits[oid('a')], oid: lost, tree, parents: [] };
    s.trees[tree] = [
      { mode: '100644', name: 'gone.txt', oid: blob, type: 'blob' },
      { mode: '100644', name: 'here.txt', oid: kept, type: 'blob' },
    ];
    for (const [o, type] of [[lost, 'commit'], [tree, 'tree'], [blob, 'blob'], [kept, 'blob']] as const)
      s.objects[o] = { oid: o, type, size: 1 };
    s.unreachable = [lost, tree, blob];

    const scene = layout(s, DEFAULT_VIEW);
    const between = scene.edges.filter((e) => e.from === lost || e.from === tree);
    assert.deepEqual(
      between.map((e) => [e.from, e.to, e.label]),
      [
        [lost, tree, undefined],
        [tree, blob, 'gone.txt'],
      ],
      'the orphaned set keeps its own links, and drops the one out to a live blob',
    );
    assert.ok(!scene.nodes.some((n) => n.id === kept), 'the live blob is not dragged down here');

    // Drawn in the bands everything else uses: the ghost commit under the live
    // ones, its tree and blob fanning out to the right in the object band.
    const node = (o: string) => scene.nodes.find((n) => n.id === o)!;
    const live = node(oid('a'));
    assert.equal(node(lost).x, live.x, 'the orphan is in the commit band');
    assert.ok(node(lost).y > live.y, 'below the live history');
    assert.ok(live.x < node(tree).x && node(tree).x < node(blob).x);
    assert.deepEqual(node(tree).y, node(lost).y, 'the tree sits on its commit row');
  });

  it('dangles an orphan with no orphaned parent below, out of the commit band', () => {
    const s = fakeSnapshot({ a: [] });
    const [tree, blob] = ['tlost', 'blost'].map(oid);
    s.trees[tree] = [{ mode: '100644', name: 'gone.txt', oid: blob, type: 'blob' }];
    s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
    s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
    s.unreachable = [tree, blob];

    const scene = layout(s, DEFAULT_VIEW);
    const node = (o: string) => scene.nodes.find((n) => n.id === o)!;
    const commits = scene.bands.find((b) => b.key === 'commits')!;
    const objects = scene.bands.find((b) => b.key === 'objects')!;
    assert.equal(node(tree).x, objects.x, 'the rootless tree starts the object band');
    assert.ok(node(tree).x >= commits.x + commits.w, 'and never where the commits are');
    assert.ok(node(blob).x > node(tree).x);
    assert.ok(node(tree).y > node(oid('a')).y);
  });

  it('puts an orphaned tag in the pointer gutter, beside what it still names', () => {
    const s = fakeSnapshot({ a: [] });
    const [lost, tagged, adrift] = ['lost', 'tagged', 'adrift'].map(oid);
    s.commits[lost] = { ...s.commits[oid('a')], oid: lost, tree: oid('none'), parents: [] };
    const tag = (o: string, target: string) => ({
      oid: o, target, targetType: 'commit' as const, name: 'v1', tagger: 'A <a@b>', message: '',
    });
    s.tags[tagged] = tag(tagged, lost);
    s.tags[adrift] = tag(adrift, oid('a')); // still-reachable target: link dropped
    for (const o of [lost, tagged, adrift]) s.objects[o] = { oid: o, type: o === lost ? 'commit' : 'tag', size: 1 };
    s.unreachable = [lost, tagged, adrift];

    const scene = layout(s, DEFAULT_VIEW);
    const node = (o: string) => scene.nodes.find((n) => n.id === o)!;
    const gutter = scene.bands.find((b) => b.key === 'pointers')!;
    assert.equal(node(tagged).kind, 'tag');
    assert.ok(node(tagged).x >= gutter.x && node(tagged).x < gutter.x + gutter.w);
    assert.equal(node(tagged).y, node(lost).y);
    assert.ok(scene.edges.some((e) => e.from === tagged && e.to === lost && e.kind === 'pointer'));
    // Nothing orphaned left to point at, so it joins the danglers instead.
    assert.ok(node(adrift).x >= scene.bands.find((b) => b.key === 'objects')!.x);
    assert.ok(!scene.edges.some((e) => e.from === adrift));
  });

  it('draws a blob only the index holds above the history, not below it', () => {
    // `git add` is the first thing the tutorial does, and below a page of
    // history the blob it wrote is off the bottom of the screen.
    const s = fakeSnapshot({ a: ['b'], b: [] });
    const blob = oid('added');
    s.objects[blob] = { oid: blob, type: 'blob', size: 3 };
    s.stagedOnly = [blob];
    s.index = [{ path: 'added.txt', oid: blob, mode: '100644', stage: 0 }];

    const scene = layout(s, DEFAULT_VIEW);
    const node = (o: string) => scene.nodes.find((n) => n.id === o)!;
    const objects = scene.bands.find((b) => b.key === 'objects')!;
    assert.equal(node(blob).x, objects.x, 'in the object band, where objects go');
    assert.equal(node(blob).staged, true);
    assert.ok(node(blob).y < node(oid('a')).y, 'above the newest commit');
    const chip = scene.nodes.find((n) => n.kind === 'index')!;
    assert.ok(chip.y <= node(blob).y, 'and the chip holding it comes up beside it');
  });

  it('leaves a staged tree below, where its fan-out has room', () => {
    // Only a gitlink can put a tree in the index's reach, and a tree is a row
    // of its own — the top of the page is for the loose blobs `git add` writes.
    const s = fakeSnapshot({ a: [] });
    const [tree, blob] = ['tstaged', 'bstaged'].map(oid);
    s.trees[tree] = [{ mode: '100644', name: 'x.txt', oid: blob, type: 'blob' }];
    s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
    s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
    s.stagedOnly = [tree, blob];

    const scene = layout(s, DEFAULT_VIEW);
    const node = (o: string) => scene.nodes.find((n) => n.id === o)!;
    assert.ok(node(tree).y > node(oid('a')).y, 'below the history, with the strays');
    assert.ok(node(blob).x > node(tree).x, 'and its blob still fans out beside it');
    assert.ok(scene.edges.some((e) => e.from === tree && e.to === blob));
  });

  it('lets a pinned orphan stay where it was drawn, reserving no room below', () => {
    const s = fakeSnapshot({ a: ['b'], b: ['c'], c: ['d'], d: ['e'], e: [] });
    s.objects[oid('lost')] = { oid: oid('lost'), type: 'blob', size: 7 };
    s.unreachable = [oid('lost')];
    const dropped = layout(s, DEFAULT_VIEW);
    const kept = layout(s, DEFAULT_VIEW, { [oid('lost')]: { x: 300, y: 20 } });
    const lost = kept.nodes.find((n) => n.id === oid('lost'))!;
    assert.deepEqual([lost.x, lost.y], [300, 20]);
    assert.equal(lost.stray, true);
    assert.ok(kept.height < dropped.height);
  });

  it('lets a pin override a position without disturbing anything else', () => {
    const free = layout(snap, DEFAULT_VIEW);
    const pinned = layout(snap, DEFAULT_VIEW, { [oid('b')]: { x: 999, y: 888 } });
    const moved = pinned.nodes.find((n) => n.id === oid('b'))!;
    assert.deepEqual([moved.x, moved.y], [999, 888]);
    const other = pinned.nodes.find((n) => n.id === oid('a'))!;
    assert.deepEqual(other, free.nodes.find((n) => n.id === oid('a')));
  });

  it('never puts two nodes in the same place, however busy the state', () => {
    // The pile-up this guards against was pins, not layout — but layout is the
    // only thing that can promise there is somewhere for everything to go.
    const s = fakeSnapshot({ c: ['b'], b: ['a'], a: [] });
    const [tree, blob, deep, lost, tlost, added] =
      ['t', 'bl', 'deep', 'lost', 'tlost', 'added'].map(oid);
    s.commits[oid('c')].tree = tree;
    s.trees[tree] = [
      { mode: '100644', name: 'a.txt', oid: blob, type: 'blob' },
      { mode: '40000', name: 'lib', oid: deep, type: 'tree' },
    ];
    s.trees[deep] = [{ mode: '100644', name: 'b.txt', oid: blob, type: 'blob' }];
    s.commits[lost] = { ...s.commits[oid('a')], oid: lost, tree: tlost, parents: [] };
    s.trees[tlost] = [{ mode: '100644', name: 'gone.txt', oid: oid('bgone'), type: 'blob' }];
    s.unreachable = [lost, tlost, oid('bgone')];
    s.stagedOnly = [added];
    s.objects[added] = { oid: added, type: 'blob', size: 1 };
    s.index = [
      { path: 'added.txt', oid: added, mode: '100644', stage: 0 },
      { path: 'a.txt', oid: blob, mode: '100644', stage: 0 },
    ];

    const scene = layout(s, { ...DEFAULT_VIEW, expanded: [oid('c')] });
    assert.ok(scene.nodes.length > 12, 'a state worth checking');
    for (let i = 0; i < scene.nodes.length; i++) {
      for (let j = i + 1; j < scene.nodes.length; j++) {
        const a = scene.nodes[i];
        const b = scene.nodes[j];
        const hit =
          a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        assert.ok(!hit, `${a.kind} ${a.label} sits on top of ${b.kind} ${b.label}`);
      }
    }
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
