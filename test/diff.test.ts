import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describe as describeChange, diffScenes, isVisible } from '../web/diff.js';
import type { Scene } from '../web/layout.js';
import type { Step } from '../src/types.js';

const shape = (id: string, x = 0, y = 0, label = id) => ({
    id,
    kind: 'blob' as const,
    x,
    y,
    w: 10,
    h: 10,
    label,
});
const scene = (shapes: ReturnType<typeof shape>[]): Scene => ({
    shapes,
    links: [],
    columns: [],
    width: 0,
    height: 0,
    rows: [],
});

describe('diffing whole steps', () => {
    it('reports nothing against a blank screen', () => {
        const d = diffScenes(null, scene([shape('a')]));
        assert.equal(d.added.size, 0);
    });

    it('finds what appeared, what went and what moved', () => {
        const d = diffScenes(scene([shape('a'), shape('b')]), scene([shape('a', 5), shape('c')]));
        assert.deepEqual([...d.added], ['c']);
        assert.deepEqual([...d.removed], ['b']);
        assert.deepEqual([...d.moved], ['a']);
    });

    it('notices a shape that says something different in the same place', () => {
        const d = diffScenes(scene([shape('a', 0, 0, 'old')]), scene([shape('a', 0, 0, 'new')]));
        assert.deepEqual([...d.updated], ['a']);
        assert.equal(d.moved.size, 0);
    });

    it('counts a git status — same shapes, new step — as nothing to show', () => {
        const one = scene([shape('a')]);
        assert.equal(isVisible(diffScenes(one, scene([shape('a')]))), false);
        // A column resize moves everything and changes nothing.
        assert.equal(isVisible(diffScenes(one, scene([shape('a', 40)]))), false);
        assert.equal(isVisible(diffScenes(one, scene([shape('a'), shape('b')]))), true);
        assert.equal(isVisible(diffScenes(one, scene([shape('a', 0, 0, 'new')]))), true);
        assert.equal(isVisible(diffScenes(one, scene([]))), true);
    });

    it('runs backwards, which is how a reset is shown twice without doing it twice', () => {
        const before = scene([shape('a')]);
        const after = scene([shape('a'), shape('b')]);
        assert.deepEqual([...diffScenes(before, after).added], ['b']);
        assert.deepEqual([...diffScenes(after, before).removed], ['b']);
    });
});

const step = (over: Partial<Step>): Step =>
    ({
        seq: 1,
        time: 0,
        repo: 'r',
        gitDir: '/g',
        head: { ref: 'refs/heads/main', oid: 'aaa', detached: false, unborn: false },
        refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false }],
        objects: {},
        commits: {},
        trees: {},
        tags: {},
        index: [],
        unreachable: [],
        capabilities: {
            objectCount: 1,
            looseCount: 1,
            refCount: 1,
            fullLoad: true,
            indexShapes: true,
            commitGraph: false,
            limits: { fullLoad: 1, indexShapes: 1 },
        },
        window: { commits: [], totalCommits: 0, more: false, refsOutside: 0 },
        view: { question: { kind: 'all' }, limit: 10, expanded: [], showIndex: true },
        notes: [],
        ...over,
    }) as Step;

describe('saying what just happened', () => {
    it('calls the first read what it is', () => {
        assert.equal(describeChange(null, step({})), 'first read');
    });

    it('names new objects by kind', () => {
        const after = step({ objects: { b1: { oid: 'b1', type: 'blob', size: 1 } } });
        assert.match(describeChange(step({}), after), /\+1 blob/);
    });

    it('reports a ref moving, being born and being deleted', () => {
        const moved = step({
            refs: [
                { name: 'refs/heads/main', oid: 'bbbbbbbbbb', objectType: 'commit', packed: false },
            ],
        });
        assert.match(describeChange(step({}), moved), /main → bbbbbbb/);

        const born = step({
            refs: [
                { name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false },
                { name: 'refs/heads/side', oid: 'aaa', objectType: 'commit', packed: false },
            ],
        });
        assert.match(describeChange(step({}), born), /new ref side/);
        assert.match(describeChange(born, step({})), /deleted side/);
    });

    it('reports HEAD detaching', () => {
        const detached = step({ head: { oid: 'aaa', detached: true, unborn: false } });
        assert.match(describeChange(step({}), detached), /HEAD → detached/);
    });

    it('says nothing loudly when nothing happened', () => {
        assert.equal(describeChange(step({}), step({})), 'no visible change');
    });
});

// The teaching text has moved out to `explain.test.ts`, next to the module it
// is testing.
