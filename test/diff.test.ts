import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { describe as describeChange, diffScenes } from '../src/diff.js';
import { explain, explainKind } from '../src/explain.js';
import type { Scene } from '../src/layout.js';
import type { Snapshot } from '../src/types.js';

const node = (id: string, x = 0, y = 0, label = id) => ({
  id,
  kind: 'blob' as const,
  x,
  y,
  w: 10,
  h: 10,
  label,
});
const scene = (nodes: ReturnType<typeof node>[]): Scene => ({
  nodes,
  edges: [],
  bands: [],
  width: 0,
  height: 0,
  rows: [],
});

describe('diffing whole states', () => {
  it('reports nothing against a blank screen', () => {
    const d = diffScenes(null, scene([node('a')]));
    assert.equal(d.added.size, 0);
  });

  it('finds what appeared, what went and what moved', () => {
    const d = diffScenes(scene([node('a'), node('b')]), scene([node('a', 5), node('c')]));
    assert.deepEqual([...d.added], ['c']);
    assert.deepEqual([...d.removed], ['b']);
    assert.deepEqual([...d.moved], ['a']);
  });

  it('notices a node that says something different in the same place', () => {
    const d = diffScenes(scene([node('a', 0, 0, 'old')]), scene([node('a', 0, 0, 'new')]));
    assert.deepEqual([...d.updated], ['a']);
    assert.equal(d.moved.size, 0);
  });

  it('runs backwards, which is how a reset is shown twice without doing it twice', () => {
    const before = scene([node('a')]);
    const after = scene([node('a'), node('b')]);
    assert.deepEqual([...diffScenes(before, after).added], ['b']);
    assert.deepEqual([...diffScenes(after, before).removed], ['b']);
  });
});

const snap = (over: Partial<Snapshot>): Snapshot =>
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
    caps: {
      objectCount: 1,
      looseCount: 1,
      refCount: 1,
      fullLoad: true,
      indexNodes: true,
      commitGraph: false,
      limits: { fullLoad: 1, indexNodes: 1 },
    },
    window: { commits: [], totalCommits: 0, more: false, refsOutside: 0 },
    view: { question: { kind: 'all' }, limit: 10, expanded: [], showIndex: true },
    notes: [],
    ...over,
  }) as Snapshot;

describe('saying what just happened', () => {
  it('calls the first read what it is', () => {
    assert.equal(describeChange(null, snap({})), 'first read');
  });

  it('names new objects by kind', () => {
    const after = snap({ objects: { b1: { oid: 'b1', type: 'blob', size: 1 } } });
    assert.match(describeChange(snap({}), after), /\+1 blob/);
  });

  it('reports a ref moving, being born and being deleted', () => {
    const moved = snap({ refs: [{ name: 'refs/heads/main', oid: 'bbbbbbbbbb', objectType: 'commit', packed: false }] });
    assert.match(describeChange(snap({}), moved), /main → bbbbbbb/);

    const born = snap({
      refs: [
        { name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false },
        { name: 'refs/heads/side', oid: 'aaa', objectType: 'commit', packed: false },
      ],
    });
    assert.match(describeChange(snap({}), born), /new ref side/);
    assert.match(describeChange(born, snap({})), /deleted side/);
  });

  it('reports HEAD detaching', () => {
    const detached = snap({ head: { oid: 'aaa', detached: true, unborn: false } });
    assert.match(describeChange(snap({}), detached), /HEAD → detached/);
  });

  it('says nothing loudly when nothing happened', () => {
    assert.equal(describeChange(snap({}), snap({})), 'no visible change');
  });
});

describe('the teaching', () => {
  it('has plain language and a command for every kind it draws', () => {
    for (const kind of ['blob', 'tree', 'commit', 'tag', 'ref', 'head', 'index', 'more', 'submodule']) {
      const e = explainKind(kind);
      assert.ok(e.what.length > 40, `${kind} is explained`);
      assert.ok(e.made.length > 0, `${kind} names the command that makes it`);
    }
  });

  it('says a branch is a file with a sha in it, and where', () => {
    const e = explain(snap({}), 'ref', 'refs/heads/main');
    assert.match(e.what, /a file with a sha in it/);
    assert.deepEqual(e.facts.find(([k]) => k === 'file'), ['file', '/g/refs/heads/main']);
    assert.match(e.facts.find(([k]) => k === 'stored')![1], /loose/);
  });

  it('explains what an unborn HEAD is', () => {
    const e = explain(snap({ head: { ref: 'refs/heads/main', detached: false, unborn: true } }), 'head', 'HEAD');
    assert.match(e.facts.find(([k]) => k === 'contains')![1], /does not exist yet/);
  });

  it('says an unreachable object is still rescuable', () => {
    const s = snap({ objects: { b1: { oid: 'b1', type: 'blob', size: 5 } }, unreachable: ['b1'] });
    const e = explain(s, 'blob', 'b1');
    assert.match(e.facts.find(([k]) => k === 'reachable')![1], /rescued/);
  });

  it('explains the three sides of a conflict', () => {
    const s = snap({ index: [{ path: 'a.txt', oid: 'b1', mode: '100644', stage: 2 }] });
    const e = explain(s, 'index', 'index:2:a.txt');
    assert.match(e.facts.find(([k]) => k === 'stage')![1], /ours/);
  });

  it('explains a gitlink as a pointer into another repository, not as a commit', () => {
    const e = explain(snap({ objects: { c1: { oid: 'c1', type: 'commit', size: 1 } } }), 'submodule', 'c1');
    assert.match(e.title, /gitlink/i);
    assert.match(e.what, /160000/);
    assert.match(e.facts.find(([k]) => k === 'mode')![1], /gitlink/);
  });
});
