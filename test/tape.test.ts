/**
 * The tape and the folds that ride on it.
 *
 * Which commits are open is the one thing the person watching is holding in
 * their head, so it has to survive every way of moving through history. This
 * was broken by hand — walking back two steps, opening three commits, walking
 * forward and back again found them folded — so every rule about it is here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Tape, TAPE_CAP, type Prefs } from '../web/tape.js';
import { layout } from '../src/layout.js';
import { DEFAULT_VIEW, type Snapshot, type View } from '../src/types.js';

const oid = (n: string) => (n + '-').padEnd(40, '0');
const OPEN: Prefs = { showIndex: true, openNewCommits: true };
const SHUT: Prefs = { showIndex: true, openNewCommits: false };

// Enough older history that a state is never small enough to be opened whole
// on arrival — that rule has its own test.
const FILL = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'];

/** A state of a repository whose commits each hold one tree of one blob. */
function state(seq: number, commits: string[], view: Partial<View> = {}): Snapshot {
  commits = [...commits, ...FILL];
  const list = commits.map(oid);
  return {
    seq,
    time: seq,
    repo: 'fake',
    gitDir: '/tmp/fake/.git',
    head: { ref: 'refs/heads/main', oid: list[0], detached: false, unborn: false },
    refs: [{ name: 'refs/heads/main', oid: list[0], objectType: 'commit', packed: false }],
    objects: {},
    commits: Object.fromEntries(
      commits.map((c, i) => [
        oid(c),
        {
          oid: oid(c),
          tree: oid('t' + c),
          parents: i + 1 < commits.length ? [oid(commits[i + 1])] : [],
          author: 'A <a@b>',
          authorDate: 0,
          committer: 'A <a@b>',
          subject: c,
          message: c,
        },
      ]),
    ),
    // Only what the view asked to open comes with its trees, exactly as the
    // server sends it.
    trees: Object.fromEntries(
      (view.expanded ?? []).map((c) => [
        oid('t' + c.replace(/-0*$/, '')),
        [{ mode: '100644', type: 'blob' as const, oid: oid('b' + c.replace(/-0*$/, '')), name: 'f.txt' }],
      ]),
    ),
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
    window: { commits: list, totalCommits: list.length, more: false, refsOutside: 0 },
    view: { ...DEFAULT_VIEW, ...view },
    notes: [],
  };
}

/** Is the tape standing somewhere that draws this commit's tree? */
const drawsTreeOf = (t: Tape, c: string) =>
  layout(t.world!, t.view).nodes.some((n) => n.oid === oid('t' + c));

describe('the tape', () => {
  it('does not make a step out of the same state answered twice', () => {
    const t = new Tape();
    t.arrive(state(1, ['c']), SHUT);
    const again = t.arrive(state(1, ['c'], { limit: 500 }), SHUT);
    assert.equal(t.states.length, 1);
    assert.equal(again.kind, 'inplace');
  });

  it('keeps you on the state you were watching when the oldest one drops', () => {
    const t = new Tape();
    for (let i = 1; i <= TAPE_CAP; i++) t.arrive(state(i, ['c' + i]), SHUT);
    t.scrubTo(10);
    const watching = t.current;
    t.arrive(state(TAPE_CAP + 1, ['later']), SHUT);
    assert.equal(t.states.length, TAPE_CAP);
    assert.equal(t.current, watching);
  });
});

describe('what is folded', () => {
  it('stays open on every state once it has been opened', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.arrive(state(2, ['b', 'a']), SHUT);
    t.arrive(state(3, ['c', 'b', 'a']), SHUT);
    t.step(-2);
    t.toggle(oid('a'));
    assert.ok(t.view.expanded.includes(oid('a')));
    t.step(1);
    assert.ok(t.view.expanded.includes(oid('a')), 'walking forward folded it again');
    t.step(-1);
    assert.ok(t.view.expanded.includes(oid('a')), 'walking back folded it again');
    t.goLive();
    assert.ok(t.view.expanded.includes(oid('a')), 'going live folded it again');
  });

  it('stays folded on every state once it has been folded by hand', () => {
    const t = new Tape();
    t.arrive(state(1, ['a'], { expanded: [oid('a')] }), OPEN);
    t.arrive(state(2, ['b', 'a']), OPEN); // b arrives open
    assert.ok(t.view.expanded.includes(oid('b')));
    t.toggle(oid('b')); // ...and is folded by hand
    t.arrive(state(3, ['c', 'b', 'a']), OPEN);
    assert.ok(!t.view.expanded.includes(oid('b')), 'a new state re-opened it');
    t.scrubTo(1);
    assert.ok(!t.view.expanded.includes(oid('b')), 'stepping back re-opened it');
  });

  it('puts a state’s question back but not its folds', () => {
    const t = new Tape();
    t.arrive(state(1, ['a'], { limit: 20 }), SHUT);
    t.arrive(state(2, ['b', 'a'], { limit: 500 }), SHUT);
    t.toggle(oid('b'));
    t.scrubTo(0);
    assert.equal(t.view.limit, 20, 'the question asked at that state is the replay');
    assert.deepEqual(t.view.expanded, [oid('b')], 'the folds are the watcher’s, not the state’s');
    t.goLive();
    assert.equal(t.view.limit, 500, 'coming back to live kept the old question');
  });

  it('draws a commit opened now on a state recorded before it was', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.arrive(state(2, ['b', 'a']), SHUT);
    t.scrubTo(0);
    t.toggle(oid('a'));
    // The server answers the fold against the state it is on, not the one
    // being watched: the tree only ever arrives attached to the newest state.
    t.arrive(state(2, ['b', 'a'], { expanded: [oid('a')] }), SHUT);
    assert.ok(drawsTreeOf(t, 'a'), 'the tree read a moment ago is the same tree');
    t.goLive();
    assert.ok(drawsTreeOf(t, 'a'));
  });

  it('opens a commit made while the tape is paused, without moving the question', () => {
    const t = new Tape();
    t.arrive(state(1, ['a'], { limit: 20 }), OPEN);
    t.scrubTo(0);
    t.view = { ...t.view, limit: 20 }; // the old state's question is on screen
    const arrival = t.arrive(state(2, ['b', 'a'], { limit: 500 }), OPEN);
    assert.equal(arrival.kind, 'none', 'a paused watcher is not moved');
    assert.ok(t.view.expanded.includes(oid('b')), 'the new commit was never opened');
    assert.equal(arrival.post?.limit, 500, 'the paused question was pushed at the server');
    assert.ok(arrival.post?.expanded.includes(oid('b')));
    t.goLive();
    assert.ok(t.view.expanded.includes(oid('b')), 'it arrived folded after all');
  });

  it('leaves a new commit folded when that is what was asked for', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.arrive(state(2, ['b', 'a']), SHUT);
    assert.deepEqual(t.view.expanded, []);
  });

  it('does not open commits paged in from further back', () => {
    const t = new Tape();
    t.arrive(state(1, ['c', 'b']), OPEN);
    // Same state of the repository, a wider window: older commits are not news.
    t.arrive(state(1, ['c', 'b', 'a'], { limit: 500 }), OPEN);
    assert.ok(!t.view.expanded.includes(oid('a')));
  });

  it('folds and unfolds only what is on screen', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.arrive(state(2, ['b', 'a']), SHUT);
    t.unfoldAll();
    assert.ok(t.view.expanded.includes(oid('a')) && t.view.expanded.includes(oid('b')));
    t.scrubTo(0); // `b` was not made yet, so it is not on screen there
    t.foldAll();
    assert.ok(!t.view.expanded.includes(oid('a')));
    assert.ok(t.view.expanded.includes(oid('b')), 'it folded a commit nobody could see');
  });

  it('opens every repository folded, however small, however the server left it', () => {
    const big = new Tape();
    big.arrive(state(1, []), SHUT);
    assert.deepEqual(big.view.expanded, []);

    const small = new Tape();
    const s = state(1, []);
    s.window.commits = s.window.commits.slice(0, 3);
    s.view = { ...s.view, expanded: [...s.window.commits] }; // another viewer had opened them
    small.arrive(s, SHUT);
    assert.deepEqual(small.view.expanded, []);
  });
});
