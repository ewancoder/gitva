/**
 * Layout is a pure function of the step being drawn, so it is tested here,
 * before anything paints it. Stability is the load-bearing property: a shape
 * that flashes *and* moves teaches nothing.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assignLanes, layout, objectGraph, M } from '../web/layout.js';
import { explain } from '../web/explain.js';
import { DEFAULT_VIEW, type Commit, type Step, type View } from '../src/types.js';

// The separator matters: without it `c1`, `c10` and `c100` all pad to the same
// forty characters, and the twenty-thousand-commit case stops being a chain.
const oid = (n: string) => (n + '-').padEnd(40, '0');

function fakeCommits(commits: Record<string, string[]>, extra: Partial<Step> = {}): Step {
    const order = Object.keys(commits);
    const asCommit = (o: string): Commit => ({
        oid: oid(o),
        tree: oid('t' + o),
        parents: commits[o].map(oid),
        author: 'A <a@b>',
        authorDate: 0,
        committer: 'A <a@b>',
        committerDate: 1_700_000_000_000,
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
        capabilities: {
            objectCount: 10,
            looseCount: 10,
            refCount: 1,
            fullLoad: true,
            indexShapes: true,
            commitGraph: false,
            limits: { fullLoad: 60_000, indexShapes: 400 },
        },
        window: {
            commits: order.map(oid),
            totalCommits: order.length,
            more: false,
            refsOutside: 0,
        },
        notes: [],
        ...extra,
    };
}

describe('lanes', () => {
    it('keeps a linear history in one lane', () => {
        const { lane, laneCount } = assignLanes(['a', 'b', 'c'], (o) =>
            o === 'c' ? [] : [String.fromCharCode(o.charCodeAt(0) + 1)],
        );
        assert.equal(laneCount, 1);
        assert.deepEqual([lane.get('a'), lane.get('b'), lane.get('c')], [0, 0, 0]);
    });

    it('fans a merge out and lets the lane close again', () => {
        // m -> (x, y) -> both -> base
        const parents: Record<string, string[]> = {
            m: ['x', 'y'],
            x: ['base'],
            y: ['base'],
            base: [],
        };
        const { lane, laneCount } = assignLanes(['m', 'x', 'y', 'base'], (o) => parents[o]);
        assert.equal(lane.get('m'), 0);
        assert.notEqual(lane.get('x'), lane.get('y'));
        assert.equal(laneCount, 2);
    });

    it('frees the lane of a branch whose parent another lane already holds', () => {
        // a and b both fork off base: b's lane has nothing left to carry, so the
        // next tip reuses it instead of the object graph creeping one lane rightwards.
        const parents: Record<string, string[]> = {
            a: ['base'],
            b: ['base'],
            base: ['root'],
            c: [],
            root: [],
        };
        const { lane, laneCount } = assignLanes(['a', 'b', 'base', 'c', 'root'], (o) => parents[o]);
        assert.equal(lane.get('c'), lane.get('b'));
        assert.equal(laneCount, 2);
    });

    it('releases a lane whose parent is outside the window', () => {
        const { laneCount } = assignLanes(['a', 'b'], (o) => (o === 'a' ? ['gone'] : []));
        assert.equal(laneCount, 1);
    });
});

describe("a commit's objects", () => {
    const trees = {
        root: [
            { name: 'a.txt', oid: 'shared', mode: '100644', type: 'blob' },
            { name: 'lib', oid: 'lib', mode: '40000', type: 'tree' },
        ],
        lib: [{ name: 'c.txt', oid: 'shared', mode: '100644', type: 'blob' }],
    };

    it('places a shared blob at its deepest column so no link points backwards', () => {
        const g = objectGraph('root', trees);
        assert.equal(g.depth.get('root'), 0);
        assert.equal(g.depth.get('lib'), 1);
        assert.equal(g.depth.get('shared'), 2, 'the longest path from the root wins');
        assert.equal(g.levels[2].length, 1, 'and it is placed once');
    });

    it('keeps the entries in the order git lists them', () => {
        const g = objectGraph('root', trees);
        assert.deepEqual(
            g.links.filter((e) => e.from === 'root').map((e) => e.label),
            ['a.txt', 'lib'],
        );
    });

    it('holds back what a collapsed tree contains, and still draws the tree', () => {
        // Hidden means absent: collapsing `lib` takes the blob under it out of the
        // scene, rather than drawing it somewhere nobody can see.
        const g = objectGraph(
            'root',
            {
                root: trees.root,
                lib: [{ name: 'c.txt', oid: 'only', mode: '100644', type: 'blob' }],
            },
            new Set(['lib']),
        );
        assert.equal(g.depth.get('lib'), 1, 'the collapsed tree is still there');
        assert.equal(g.depth.has('only'), false, 'what it holds left the scene');
        assert.deepEqual(
            g.links.map((e) => e.label),
            ['a.txt', 'lib'],
            'and no link points at a shape that is not drawn',
        );
    });

    it('keeps a blob a collapsed tree shared with someone still open', () => {
        // The collapse hides a path, not an object: `shared` is a.txt at the root too,
        // so it stays, and only the link from `lib` goes.
        const g = objectGraph('root', trees, new Set(['lib']));
        assert.equal(g.depth.get('shared'), 1, 'it moves up to the path still open');
        assert.equal(
            g.links.some((e) => e.from === 'lib'),
            false,
        );
    });

    it('holds back everything when the root itself is collapsed', () => {
        // The root is a tree like any other: a commit whose own tree is collapsed
        // shows the tree and nothing under it.
        const g = objectGraph('root', trees, new Set(['root']));
        assert.deepEqual(g.levels, [['root']]);
        assert.deepEqual(g.links, []);
    });

    it('writes both names on one link when two files in a tree are the same blob', () => {
        // Two identical files are one blob, so the tree has two entries pointing at
        // it: one link, both names, rather than two labels on the same pixels.
        const g = objectGraph('r', {
            r: [
                { name: 'a.txt', oid: 'same', mode: '100644', type: 'blob' },
                { name: 'b.txt', oid: 'same', mode: '100644', type: 'blob' },
            ],
        });
        assert.deepEqual(
            g.links.map((e) => e.label),
            ['a.txt, b.txt'],
        );
    });

    it('marks an executable and a symlink on the link', () => {
        const g = objectGraph('r', {
            r: [
                { name: 'run.sh', oid: 'x', mode: '100755', type: 'blob' },
                { name: 'link', oid: 'y', mode: '120000', type: 'blob' },
            ],
        });
        assert.deepEqual(
            g.links.map((e) => e.label),
            ['run.sh +x', 'link ->'],
        );
    });
});

describe('the scene', () => {
    const step = fakeCommits({ c: ['b'], b: ['a'], a: [] });

    it('is the same scene every time it is drawn', () => {
        assert.deepEqual(layout(step, DEFAULT_VIEW), layout(step, DEFAULT_VIEW));
    });

    it('collapsing a tree removes what it holds from the scene, and says how much', () => {
        // A collapsed tree with nothing drawn under it would read as an empty tree, so
        // it carries the count. And the blob is gone from the scene, not hidden in
        // it: the shape list is what you can see.
        const open = fakeCommits(
            { a: [] },
            {
                trees: {
                    [oid('ta')]: [{ name: 'a.txt', oid: oid('bl'), mode: '100644', type: 'blob' }],
                },
                objects: {
                    [oid('ta')]: { oid: oid('ta'), type: 'tree', size: 1 },
                    [oid('bl')]: { oid: oid('bl'), type: 'blob', size: 1 },
                },
            },
        );
        const view = { ...DEFAULT_VIEW, expanded: [oid('a')] };
        const before = layout(open, view);
        assert.equal(before.shapes.find((n) => n.id === oid('ta'))?.sub, 'tree');
        assert.ok(before.shapes.some((n) => n.id === oid('bl')));

        const after = layout(open, { ...view, collapsed: [oid('ta')] });
        assert.equal(after.shapes.find((n) => n.id === oid('ta'))?.sub, 'tree +1');
        assert.equal(
            after.shapes.find((n) => n.id === oid('ta'))?.collapsed,
            true,
            'and says so, for the painter',
        );
        assert.equal(
            after.shapes.some((n) => n.id === oid('bl')),
            false,
            'hidden means absent',
        );
        assert.equal(
            after.links.some((e) => e.to === oid('bl')),
            false,
        );
    });

    it('does not move anything sideways when a commit lands on top', () => {
        const before = layout(step, DEFAULT_VIEW);
        const after = layout(fakeCommits({ d: ['c'], c: ['b'], b: ['a'], a: [] }), DEFAULT_VIEW);
        for (const n of before.shapes) {
            const same = after.shapes.find((m) => m.id === n.id);
            if (!same) continue;
            assert.equal(same.x, n.x, `${n.id} stayed in its lane`);
        }
    });

    it('accordions a row open, pushing everything below down by a predictable amount', () => {
        const withTrees = fakeCommits({ c: ['b'], b: ['a'], a: [] });
        withTrees.trees[oid('tc')] = [
            { name: 'a.txt', oid: oid('blob1'), mode: '100644', type: 'blob' },
            { name: 'b.txt', oid: oid('blob2'), mode: '100644', type: 'blob' },
            { name: 'c.txt', oid: oid('blob3'), mode: '100644', type: 'blob' },
        ];
        const collapsed = layout(withTrees, DEFAULT_VIEW);
        const view: View = { ...DEFAULT_VIEW, expanded: [oid('c')] };
        const open = layout(withTrees, view);

        assert.equal(collapsed.rows[0].h, M.rowH);
        assert.ok(open.rows[0].h > collapsed.rows[0].h, 'the row grew');
        const grew = open.rows[0].h - collapsed.rows[0].h;
        assert.equal(
            open.rows[1].y - collapsed.rows[1].y,
            grew,
            'and the row below shifted by exactly that',
        );
        assert.ok(open.shapes.some((n) => n.id === oid('blob1')));
    });

    it('makes the pointer gutter as narrow as the longest chain in it', () => {
        // main alone is one hop, HEAD → main is two, and neither should be paying
        // for the third column an annotated tag would need.
        const bare = fakeCommits({ c: ['b'], b: ['a'], a: [] });
        bare.head = { ref: undefined, oid: undefined, detached: false, unborn: false };
        const oneHop = layout(bare, DEFAULT_VIEW);
        const twoHops = layout(step, DEFAULT_VIEW);
        const w = (sc: typeof oneHop) => sc.columns.find((b) => b.key === 'pointersAndTags')!.w;
        assert.equal(w(twoHops) - w(oneHop), M.chipPitch, 'one column of difference');
        assert.equal(w(twoHops), M.gutterW - M.chipPitch, 'and the full gutter is three');
    });

    it('still right-aligns the chips against the narrower gutter', () => {
        const scene = layout(step, DEFAULT_VIEW);
        const column = scene.columns.find((b) => b.key === 'pointersAndTags')!;
        for (const n of scene.shapes.filter((c) => c.kind === 'ref' || c.kind === 'head')) {
            assert.ok(
                n.x >= column.x && n.x + n.w <= column.x + column.w,
                `${n.id} is inside the gutter`,
            );
        }
        // The last hop is the one nearest the commits: HEAD sits left of its branch.
        const head = scene.shapes.find((n) => n.id === 'HEAD')!;
        const ref = scene.shapes.find((n) => n.kind === 'ref')!;
        assert.ok(head.x < ref.x);
    });

    it('grows the index column to hold an entry dragged out to the right', () => {
        const s = fakeCommits({ c: ['b'], b: ['a'], a: [] });
        s.index = [{ path: 'a.txt', oid: oid('blob1'), mode: '100644', stage: 0 }];
        const id = 'index:0:a.txt';
        const plain = layout(s, DEFAULT_VIEW);
        const chip = plain.shapes.find((n) => n.id === id)!;
        const column = (sc: typeof plain) => sc.columns.find((b) => b.key === 'index')!;

        const out = layout(s, DEFAULT_VIEW, { [id]: { x: chip.x + 300, y: chip.y } });
        assert.equal(column(out).w, column(plain).w + 300, 'the column followed it');
        assert.ok(out.width > plain.width, 'and the canvas is wide enough to pan to it');

        // Dragging left is a way out of the column, and stays one.
        const back = layout(s, DEFAULT_VIEW, { [id]: { x: chip.x - 300, y: chip.y } });
        assert.equal(column(back).w, column(plain).w);
    });

    it('grows the scene down to hold a shape dragged below everything else', () => {
        const s = fakeCommits({ c: ['b'], b: ['a'], a: [] });
        const plain = layout(s, DEFAULT_VIEW);
        const chip = plain.shapes.find((n) => n.kind === 'commit')!;
        const down = layout(s, DEFAULT_VIEW, { [chip.id]: { x: chip.x, y: plain.height + 500 } });
        assert.ok(down.height > plain.height + 500, 'and the canvas can be panned to it');
    });

    it('grows the scene up to hold a shape dragged above everything else', () => {
        const s = fakeCommits({ c: ['b'], b: ['a'], a: [] });
        const plain = layout(s, DEFAULT_VIEW);
        const chip = plain.shapes.find((n) => n.kind === 'commit')!;
        const up = layout(s, DEFAULT_VIEW, { [chip.id]: { x: chip.x, y: -500 } });
        assert.ok(up.y < -500, 'the scene starts above it');
        assert.ok(up.y + up.height >= plain.y + plain.height, 'and still reaches the bottom');
    });

    it('widens a column by hand, moving every column after it along', () => {
        const plain = layout(step, DEFAULT_VIEW);
        const wide = layout(step, DEFAULT_VIEW, {}, { pointersAndTags: 400 });
        const column = (sc: typeof plain, key: string) => sc.columns.find((b) => b.key === key)!;
        assert.equal(column(wide, 'pointersAndTags').w, 400);
        const shift = 400 - column(plain, 'pointersAndTags').w;
        assert.equal(column(wide, 'commits').x - column(plain, 'commits').x, shift);
        assert.equal(column(wide, 'index').x - column(plain, 'index').x, shift);
        assert.equal(wide.width - plain.width, shift);
    });

    it('will not narrow a column past what it holds', () => {
        const plain = layout(step, DEFAULT_VIEW);
        const squeezed = layout(step, DEFAULT_VIEW, {}, { pointers: 10, commits: 1, objects: 1 });
        assert.deepEqual(squeezed.columns, plain.columns);
    });

    it('explains the ref chips it draws — the scene keys them, the inspector looks them up', () => {
        const chip = layout(step, DEFAULT_VIEW).shapes.find((n) => n.kind === 'ref')!;
        const facts = explain(step, 'ref', chip.id).facts;
        // The name is the part you type; the whole of it is the file's path.
        assert.deepEqual(
            facts.find(([k]) => k === 'name'),
            ['name', 'main'],
        );
        assert.deepEqual(facts.find(([k]) => k === 'file')![1], {
            short: 'refs/heads/main',
            full: `${step.gitDir}/refs/heads/main`,
        });
    });

    // There is nothing to draw a parent outside the window *to*, and no button to
    // load it with: the window is the run's, fixed when the step was made, and
    // the notes toolbar is where the rest of the history is admitted to.
    it('draws no link to a parent outside the window', () => {
        const s = fakeCommits({ c: ['b'], b: ['gone'] });
        const scene = layout(s, DEFAULT_VIEW);
        assert.ok(
            !scene.links.some((e) => e.to === oid('gone')),
            'never a link to a shape that is not there',
        );
        assert.equal(scene.links.filter((e) => e.kind === 'parent').length, 1);
    });

    it('puts HEAD outside the ref it names, pointing at it', () => {
        const scene = layout(step, DEFAULT_VIEW);
        const head = scene.shapes.find((n) => n.kind === 'head')!;
        const ref = scene.shapes.find((n) => n.kind === 'ref')!;
        assert.ok(head.x < ref.x, 'HEAD sits outside the ref');
        assert.ok(scene.links.some((e) => e.from === 'HEAD' && e.to === ref.id));
        assert.ok(scene.links.some((e) => e.from === ref.id && e.to === oid('c')));
    });

    it('points a detached HEAD straight at the commit', () => {
        const s = fakeCommits({ c: ['b'], b: [] }, {});
        s.head = { oid: oid('c'), detached: true, unborn: false };
        s.refs = [];
        const scene = layout(s, DEFAULT_VIEW);
        assert.ok(scene.links.some((e) => e.from === 'HEAD' && e.to === oid('c')));
    });

    it('still draws HEAD on a repo with nothing in it yet', () => {
        const s = fakeCommits({}, {});
        s.head = { ref: 'refs/heads/main', detached: false, unborn: true };
        s.refs = [];
        const scene = layout(s, DEFAULT_VIEW);
        const head = scene.shapes.find((n) => n.kind === 'head')!;
        assert.ok(head, 'a fresh git init is not an empty screen');
        assert.equal(head.sub, 'main');
    });

    it('leaves a ref pointing outside the window out of the drawing', () => {
        const s = fakeCommits({ c: ['b'], b: [] });
        s.refs.push({
            name: 'refs/heads/old',
            oid: oid('gone'),
            objectType: 'commit',
            packed: true,
        });
        const scene = layout(s, DEFAULT_VIEW);
        assert.equal(scene.shapes.filter((n) => n.kind === 'ref').length, 1);
    });

    it('hides the index outright when it is switched off', () => {
        const s = fakeCommits({ a: [] });
        s.index = [{ path: 'a.txt', oid: oid('blob1'), mode: '100644', stage: 0 }];
        assert.ok(layout(s, DEFAULT_VIEW).shapes.some((n) => n.kind === 'index'));
        const off = layout(s, { ...DEFAULT_VIEW, showIndex: false });
        assert.ok(
            !off.shapes.some((n) => n.kind === 'index'),
            'taken out of the drawing, not merely invisible',
        );
        assert.ok(!off.columns.some((b) => b.key === 'index'));
    });

    it('marks a conflict entry differently from a clean one', () => {
        const s = fakeCommits({ a: [] });
        s.index = [
            { path: 'a.txt', oid: oid('blob1'), mode: '100644', stage: 0 },
            { path: 'b.txt', oid: oid('blob2'), mode: '100644', stage: 2 },
        ];
        const scene = layout(s, DEFAULT_VIEW);
        const entries = scene.shapes.filter((n) => n.kind === 'index');
        assert.deepEqual(
            entries.map((e) => e.conflict),
            [false, true],
        );
    });

    it('collapses an unreachable tree too — a ghost is a tree with entries like any other', () => {
        const s = fakeCommits({ a: [] });
        s.objects[oid('lt')] = { oid: oid('lt'), type: 'tree', size: 7 };
        s.objects[oid('lb')] = { oid: oid('lb'), type: 'blob', size: 7 };
        s.trees[oid('lt')] = [{ name: 'gone.txt', oid: oid('lb'), mode: '100644', type: 'blob' }];
        s.unreachable = [oid('lt'), oid('lb')];
        const scene = layout(s, { ...DEFAULT_VIEW, collapsed: [oid('lt')] });
        assert.equal(scene.shapes.find((n) => n.id === oid('lt'))?.sub, 'tree +1');
        assert.equal(scene.shapes.find((n) => n.id === oid('lt'))?.collapsed, true);
        // Collapsing a ghost does not delete one: an unreachable object nothing draws
        // any more falls through to the stray column, because "never silently
        // dropped" outranks the collapse. It leaves the collapse's column, not the canvas.
        const lost = scene.shapes.find((n) => n.id === oid('lb'))!;
        assert.ok(lost, 'an unreachable object is never hidden by a collapse');
        assert.equal(lost.stray, true);
        assert.equal(
            scene.links.some((e) => e.to === oid('lb')),
            false,
            'and no link into it from the collapsed tree',
        );
    });

    it('draws an unreachable object nothing points at, never silently dropping it', () => {
        const s = fakeCommits({ a: [] });
        s.objects[oid('lost')] = { oid: oid('lost'), type: 'blob', size: 7 };
        s.unreachable = [oid('lost')];
        const scene = layout(s, DEFAULT_VIEW);
        const lost = scene.shapes.find((n) => n.id === oid('lost'))!;
        assert.ok(lost);
        assert.equal(lost.unreachable, true);
    });

    it('hides unreachable objects outright when they are switched off, and keeps staged blobs', () => {
        const s = fakeCommits({ a: [] });
        s.objects[oid('lost')] = { oid: oid('lost'), type: 'blob', size: 7 };
        s.objects[oid('stag')] = { oid: oid('stag'), type: 'blob', size: 7 };
        s.unreachable = [oid('lost')];
        s.stagedOnly = [oid('stag')];
        const off = layout(s, { ...DEFAULT_VIEW, showUnreachable: false });
        assert.ok(
            !off.shapes.some((n) => n.id === oid('lost')),
            'out of the scene, not merely invisible',
        );
        assert.ok(
            off.shapes.some((n) => n.id === oid('stag')),
            'the index still holds this one',
        );
    });

    it('keeps the links between objects that were unreachable together', () => {
        // A discarded commit -> its tree -> its blob, all lost at the same moment,
        // plus one still-reachable blob the lost tree also names.
        const s = fakeCommits({ a: [] });
        const [lost, tree, blob, kept] = ['lost', 'tlost', 'blost', 'kept'].map(oid);
        s.commits[lost] = { ...s.commits[oid('a')], oid: lost, tree, parents: [] };
        s.trees[tree] = [
            { mode: '100644', name: 'gone.txt', oid: blob, type: 'blob' },
            { mode: '100644', name: 'here.txt', oid: kept, type: 'blob' },
        ];
        for (const [o, type] of [
            [lost, 'commit'],
            [tree, 'tree'],
            [blob, 'blob'],
            [kept, 'blob'],
        ] as const)
            s.objects[o] = { oid: o, type, size: 1 };
        s.unreachable = [lost, tree, blob];

        const scene = layout(s, DEFAULT_VIEW);
        const between = scene.links.filter((e) => e.from === lost || e.from === tree);
        assert.deepEqual(
            between.map((e) => [e.from, e.to, e.label]),
            [
                [lost, tree, undefined],
                [tree, blob, 'gone.txt'],
            ],
            'the unreachable set keeps its own links, and drops the one out to a live blob',
        );
        assert.ok(
            !scene.shapes.some((n) => n.id === kept),
            'the live blob is not dragged down here',
        );

        // Drawn in the columns everything else uses: the ghost commit under the live
        // ones, its tree and blob fanning out to the right in the object column.
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        const live = shape(oid('a'));
        assert.equal(shape(lost).x, live.x, 'the unreachable object is in the commit column');
        assert.ok(shape(lost).y > live.y, 'below the live history');
        assert.ok(live.x < shape(tree).x && shape(tree).x < shape(blob).x);
        assert.deepEqual(shape(tree).y, shape(lost).y, 'the tree sits on its commit row');
    });

    it('strands an unreachable object with no unreachable parent below, out of the commit column', () => {
        const s = fakeCommits({ a: [] });
        const [tree, blob] = ['tlost', 'blost'].map(oid);
        s.trees[tree] = [{ mode: '100644', name: 'gone.txt', oid: blob, type: 'blob' }];
        s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
        s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
        s.unreachable = [tree, blob];

        const scene = layout(s, DEFAULT_VIEW);
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        const commits = scene.columns.find((b) => b.key === 'commits')!;
        const objects = scene.columns.find((b) => b.key === 'treesAndBlobs')!;
        assert.equal(shape(tree).x, objects.x, 'the rootless tree starts the object column');
        assert.ok(shape(tree).x >= commits.x + commits.w, 'and never where the commits are');
        assert.ok(shape(blob).x > shape(tree).x);
        assert.ok(shape(tree).y > shape(oid('a')).y);
    });

    it('fans a stray tree out to a blob that git happened to list first', () => {
        // hash-object then mktree: the blob exists before the tree does, and comes
        // back first. Order of arrival must not decide who gets the first column.
        const s = fakeCommits({ a: [] });
        const [tree, blob] = ['tlost', 'blost'].map(oid);
        s.trees[tree] = [{ mode: '100644', name: 'gone.txt', oid: blob, type: 'blob' }];
        s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
        s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
        s.unreachable = [blob, tree];

        const scene = layout(s, DEFAULT_VIEW);
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        assert.ok(shape(blob).x > shape(tree).x, 'the blob is right of the tree, not under it');
        assert.equal(shape(blob).y, shape(tree).y, 'on the same row');
    });

    it('puts an unreachable tag in the pointer gutter, beside what it still names', () => {
        const s = fakeCommits({ a: [] });
        const [lost, tagged, adrift] = ['lost', 'tagged', 'adrift'].map(oid);
        s.commits[lost] = { ...s.commits[oid('a')], oid: lost, tree: oid('none'), parents: [] };
        const tag = (o: string, target: string) => ({
            oid: o,
            target,
            targetType: 'commit' as const,
            name: 'v1',
            tagger: 'A <a@b>',
            message: '',
        });
        s.tags[tagged] = tag(tagged, lost);
        s.tags[adrift] = tag(adrift, oid('a')); // still-reachable target: link dropped
        for (const o of [lost, tagged, adrift])
            s.objects[o] = { oid: o, type: o === lost ? 'commit' : 'tag', size: 1 };
        s.unreachable = [lost, tagged, adrift];

        const scene = layout(s, DEFAULT_VIEW);
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        const gutter = scene.columns.find((b) => b.key === 'pointersAndTags')!;
        assert.equal(shape(tagged).kind, 'tag');
        assert.ok(shape(tagged).x >= gutter.x && shape(tagged).x < gutter.x + gutter.w);
        assert.equal(shape(tagged).y, shape(lost).y);
        assert.ok(
            scene.links.some((e) => e.from === tagged && e.to === lost && e.kind === 'pointer'),
        );
        // Nothing unreachable left to point at, so it joins the strays instead.
        assert.ok(shape(adrift).x >= scene.columns.find((b) => b.key === 'treesAndBlobs')!.x);
        assert.ok(!scene.links.some((e) => e.from === adrift));
    });

    it('draws a blob only the index holds above the history, not below it', () => {
        // `git add` is the first thing the tutorial does, and below a page of
        // history the blob it wrote is off the bottom of the screen.
        const s = fakeCommits({ a: ['b'], b: [] });
        const blob = oid('added');
        s.objects[blob] = { oid: blob, type: 'blob', size: 3 };
        s.stagedOnly = [blob];
        s.index = [{ path: 'added.txt', oid: blob, mode: '100644', stage: 0 }];

        const scene = layout(s, DEFAULT_VIEW);
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        const objects = scene.columns.find((b) => b.key === 'treesAndBlobs')!;
        assert.equal(shape(blob).x, objects.x, 'in the object column, where objects go');
        assert.equal(shape(blob).staged, true);
        assert.ok(shape(blob).y < shape(oid('a')).y, 'above the newest commit');
        const chip = scene.shapes.find((n) => n.kind === 'index')!;
        assert.ok(chip.y <= shape(blob).y, 'and the chip holding it comes up beside it');
    });

    it('draws a submodule as a submodule, not a blob', () => {
        // The whole point of a gitlink: mode 160000 names a commit this object
        // database does not have, so `step.objects` can never say what it is and
        // the entry naming it is the only thing that knows.
        const s = fakeCommits({ a: [] });
        const sub = oid('sub');
        s.trees[oid('ta')] = [{ mode: '160000', name: 'sub', oid: sub, type: 'commit' }];

        const scene = layout(s, { ...DEFAULT_VIEW, expanded: [oid('a')] });
        const shape = scene.shapes.find((n) => n.id === sub)!;
        assert.equal(shape.kind, 'submodule');
        assert.equal(shape.sub, 'commit', "git's own word for it, out of ls-tree");
    });

    it('leaves a staged tree below, where its fan-out has room', () => {
        // Only a gitlink can put a tree in the index's reach, and a tree is a row
        // of its own — the top of the page is for the loose blobs `git add` writes.
        const s = fakeCommits({ a: [] });
        const [tree, blob] = ['tstaged', 'bstaged'].map(oid);
        s.trees[tree] = [{ mode: '100644', name: 'x.txt', oid: blob, type: 'blob' }];
        s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
        s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
        s.stagedOnly = [tree, blob];

        const scene = layout(s, DEFAULT_VIEW);
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        assert.ok(shape(tree).y > shape(oid('a')).y, 'below the history, with the strays');
        assert.ok(shape(blob).x > shape(tree).x, 'and its blob still fans out beside it');
        assert.ok(scene.links.some((e) => e.from === tree && e.to === blob));
    });

    it('keeps a staged blob beside the unreachable tree that names it — git write-tree', () => {
        // `write-tree` writes a tree nothing points at, holding the blobs the index
        // still holds. Hoisted to the top of the page the blob would be drawn twice
        // over: purple up there, and unsaid down beside the tree that names it.
        const s = fakeCommits({ a: [] });
        const [tree, blob] = ['twritten', 'bstaged'].map(oid);
        s.trees[tree] = [{ mode: '100644', name: 'x.txt', oid: blob, type: 'blob' }];
        s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
        s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
        s.unreachable = [tree];
        s.stagedOnly = [blob];
        s.index = [{ path: 'x.txt', oid: blob, mode: '100644', stage: 0 }];

        const scene = layout(s, DEFAULT_VIEW);
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        assert.ok(shape(blob).y > shape(oid('a')).y, 'down with the tree, not up at the top');
        assert.ok(shape(blob).x > shape(tree).x, 'in the fan-out beside it');
        assert.equal(shape(blob).staged, true, 'and still the index\u2019s, not a ghost');
        assert.equal(shape(blob).unreachable, false);
        assert.ok(scene.links.some((e) => e.from === tree && e.to === blob && e.kind === 'entry'));
        assert.ok(
            scene.links.some((e) => e.to === blob && e.kind === 'stage'),
            'the chip still holds it',
        );
    });

    it('hoists a staged blob whose only tree is an unreachable object that is switched off', () => {
        const s = fakeCommits({ a: [] });
        const [tree, blob] = ['twritten', 'bstaged'].map(oid);
        s.trees[tree] = [{ mode: '100644', name: 'x.txt', oid: blob, type: 'blob' }];
        s.objects[tree] = { oid: tree, type: 'tree', size: 1 };
        s.objects[blob] = { oid: blob, type: 'blob', size: 1 };
        s.unreachable = [tree];
        s.stagedOnly = [blob];

        const scene = layout(s, { ...DEFAULT_VIEW, showUnreachable: false });
        const shape = (o: string) => scene.shapes.find((n) => n.id === o)!;
        assert.ok(!scene.shapes.some((n) => n.id === tree), 'the tree is out of the scene');
        assert.ok(
            shape(blob).y < shape(oid('a')).y,
            'so the blob goes back up beside the newest commit',
        );
    });

    it('draws an unreachable tree\u2019s links into live territory only when asked', () => {
        // The whole point of the switch: the ghost tree names the very blob the
        // live commit names, so gc would free the tree and nothing else. Off, the
        // link is not there; on, it is, and not one shape has moved.
        const s = fakeCommits({ a: [] });
        const [live, lost, own] = ['bl', 'tlost', 'bown'].map(oid);
        s.trees[oid('ta')] = [{ mode: '100644', name: 'a.txt', oid: live, type: 'blob' }];
        s.trees[lost] = [
            { mode: '100644', name: 'a.txt', oid: live, type: 'blob' },
            { mode: '100644', name: 'gone.txt', oid: own, type: 'blob' },
        ];
        for (const [o, t] of [
            [oid('ta'), 'tree'],
            [lost, 'tree'],
            [live, 'blob'],
            [own, 'blob'],
        ] as const)
            s.objects[o] = { oid: o, type: t, size: 1 };
        s.unreachable = [lost, own];

        const fromUnreachable = (sc: ReturnType<typeof layout>) =>
            sc.links.filter((e) => e.from === lost && e.to === live);
        const open = { ...DEFAULT_VIEW, expanded: [oid('a')] };
        const off = layout(s, open);
        const on = layout(s, { ...open, showLinksFromUnreachable: true });
        assert.equal(fromUnreachable(off).length, 0);
        assert.equal(fromUnreachable(on).length, 1, 'one link, labelled with the name it is under');
        assert.equal(fromUnreachable(on)[0].label, 'a.txt');
        assert.equal(
            on.shapes.filter((n) => n.id === live).length,
            1,
            'the blob is not drawn twice',
        );
        assert.deepEqual(on.shapes, off.shapes, 'a link is added, nothing is moved');
        assert.ok(
            on.links.some((e) => e.from === lost && e.to === own),
            'its own blob still fans out',
        );
        // Collapse the commit away and the blob is off the screen; a link to a shape
        // nobody can see is not a link.
        assert.equal(
            fromUnreachable(layout(s, { ...DEFAULT_VIEW, showLinksFromUnreachable: true })).length,
            0,
        );
    });

    it('draws a discarded commit\u2019s link to the live parent it was cut from', () => {
        // What `git reset --hard HEAD~1` leaves: the old tip hangs below, still
        // naming the commit the branch now points at.
        const s = fakeCommits({ a: ['b'], b: [] });
        const lost = oid('lost');
        s.commits[lost] = {
            ...s.commits[oid('a')],
            oid: lost,
            tree: oid('ta'),
            parents: [oid('a')],
        };
        s.objects[lost] = { oid: lost, type: 'commit', size: 1 };
        s.unreachable = [lost];

        const parent = (v: View) =>
            layout(s, v).links.filter((e) => e.from === lost && e.to === oid('a'));
        assert.equal(
            parent(DEFAULT_VIEW).length,
            0,
            'off by default, like any link from unreachable',
        );
        const on = parent({ ...DEFAULT_VIEW, showLinksFromUnreachable: true });
        assert.equal(on.length, 1);
        assert.equal(on[0].kind, 'parent');
    });

    it('draws a discarded commit\u2019s link to the live tree it shares', () => {
        // Two unrelated commits over one tree, only one of them reachable: the
        // ghost still names that tree, and nothing else on screen says so.
        const s = fakeCommits({ a: [] });
        const lost = oid('lost');
        s.trees[oid('ta')] = [{ mode: '100644', name: 'a.txt', oid: oid('bl'), type: 'blob' }];
        s.objects[oid('ta')] = { oid: oid('ta'), type: 'tree', size: 1 };
        s.objects[oid('bl')] = { oid: oid('bl'), type: 'blob', size: 1 };
        s.commits[lost] = { ...s.commits[oid('a')], oid: lost, tree: oid('ta'), parents: [] };
        s.objects[lost] = { oid: lost, type: 'commit', size: 1 };
        s.unreachable = [lost];

        const tree = (v: View) =>
            layout(s, v).links.filter((e) => e.from === lost && e.to === oid('ta'));
        const open = { ...DEFAULT_VIEW, expanded: [oid('a')] };
        assert.equal(tree(open).length, 0, 'off by default, like any link from unreachable');
        const on = tree({ ...open, showLinksFromUnreachable: true });
        assert.equal(on.length, 1);
        assert.equal(on[0].kind, 'tree');
    });

    it('says nothing about the entries of a collapsed unreachable object, links from unreachable or not', () => {
        const s = fakeCommits({ a: [] });
        const [live, lost] = ['bl', 'tlost'].map(oid);
        s.trees[oid('ta')] = [{ mode: '100644', name: 'a.txt', oid: live, type: 'blob' }];
        s.trees[lost] = [{ mode: '100644', name: 'a.txt', oid: live, type: 'blob' }];
        for (const o of [oid('ta'), lost]) s.objects[o] = { oid: o, type: 'tree', size: 1 };
        s.objects[live] = { oid: live, type: 'blob', size: 1 };
        s.unreachable = [lost];

        const scene = layout(s, {
            ...DEFAULT_VIEW,
            expanded: [oid('a')],
            showLinksFromUnreachable: true,
            collapsed: [lost],
        });
        assert.ok(!scene.links.some((e) => e.from === lost));
    });

    it('lets a pinned unreachable object stay where it was drawn, reserving no room below', () => {
        const s = fakeCommits({ a: ['b'], b: ['c'], c: ['d'], d: ['e'], e: [] });
        s.objects[oid('lost')] = { oid: oid('lost'), type: 'blob', size: 7 };
        s.unreachable = [oid('lost')];
        const dropped = layout(s, DEFAULT_VIEW);
        const kept = layout(s, DEFAULT_VIEW, { [oid('lost')]: { x: 300, y: 20 } });
        const lost = kept.shapes.find((n) => n.id === oid('lost'))!;
        assert.deepEqual([lost.x, lost.y], [300, 20]);
        assert.equal(lost.stray, true);
        assert.ok(kept.height < dropped.height);
    });

    it('puts lost commits newest first, and settles a tie by sha', () => {
        const s = fakeCommits({ a: ['b'], b: [] });
        const [old, recent, tied] = ['lost1', 'lost2', 'lost3'].map(oid);
        for (const [o, when] of [
            [old, 1],
            [recent, 9],
            [tied, 9],
        ] as const) {
            s.commits[o] = { ...s.commits[oid('a')], oid: o, parents: [], authorDate: when };
        }
        s.unreachable = [old, recent, tied];
        const scene = layout(s, DEFAULT_VIEW);
        const y = (o: string) => scene.shapes.find((n) => n.id === o)!.y;
        assert.ok(
            y(recent) < y(old),
            'the most recent thing you lost is the one you are looking for',
        );
        assert.ok(
            y(recent) < y(tied),
            'two at the same moment go in sha order, so the canvas is stable',
        );
    });

    it('lets a pin override a position without disturbing anything else', () => {
        const free = layout(step, DEFAULT_VIEW);
        const pinned = layout(step, DEFAULT_VIEW, { [oid('b')]: { x: 999, y: 888 } });
        const moved = pinned.shapes.find((n) => n.id === oid('b'))!;
        assert.deepEqual([moved.x, moved.y], [999, 888]);
        const other = pinned.shapes.find((n) => n.id === oid('a'))!;
        assert.deepEqual(
            other,
            free.shapes.find((n) => n.id === oid('a')),
        );
    });

    it('never puts two shapes in the same place, however busy the step', () => {
        // The pile-up this guards against was pins, not layout — but layout is the
        // only thing that can promise there is somewhere for everything to go.
        const s = fakeCommits({ c: ['b'], b: ['a'], a: [] });
        const [tree, blob, deep, lost, tlost, added] = [
            't',
            'bl',
            'deep',
            'lost',
            'tlost',
            'added',
        ].map(oid);
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
        assert.ok(scene.shapes.length > 12, 'a step worth checking');
        for (let i = 0; i < scene.shapes.length; i++) {
            for (let j = i + 1; j < scene.shapes.length; j++) {
                const a = scene.shapes[i];
                const b = scene.shapes[j];
                const hit =
                    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
                assert.ok(!hit, `${a.kind} ${a.label} sits on top of ${b.kind} ${b.label}`);
            }
        }
    });

    it('is fast enough on twenty thousand commits', () => {
        const many: Record<string, string[]> = {};
        for (let i = 0; i < 20_000; i++) many[`c${i}`] = i === 19_999 ? [] : [`c${i + 1}`];
        const s = fakeCommits(many);
        const t0 = performance.now();
        const scene = layout(s, DEFAULT_VIEW);
        const ms = performance.now() - t0;
        assert.equal(scene.rows.length, 20_000);
        // A guard against layout going quadratic, not a benchmark: the budget is
        // loose because a shared CI runner is several times slower than a laptop,
        // and anything worse than linear here costs seconds, not milliseconds.
        assert.ok(ms < 1000, `deciding where 20,000 commits go took ${ms.toFixed(1)}ms`);
    });
});
