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
import { canMark, isDouble, Pins, questionFor, Tape, type Prefs } from '../web/tape.js';
import { layout } from '../src/layout.js';
import { DEFAULT_VIEW, TAPE_CAP, type Snapshot, type View } from '../src/types.js';

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

  it('does not open a commit that only came back into the window', () => {
    const t = new Tape();
    // Windows are bounded and questions filter, so a commit leaves and returns.
    // Only what git has just made opens itself — and this one was already here,
    // folded, when the watcher last saw it.
    t.arrive(state(1, ['a', 'b']), OPEN);
    t.arrive(state(2, ['a']), OPEN);
    t.arrive(state(3, ['a', 'b']), OPEN);
    assert.deepEqual(t.view.expanded, [], 'an old commit opened itself on the way back in');
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

  it('opens every commit on arrival when the server was started for a room', () => {
    // `--learning`: a demo repository shown to people, where nobody should have
    // to unfold anything to see the same picture as everyone else.
    const t = new Tape();
    const s = state(1, ['a', 'b'], { learning: true });
    const a = t.arrive(s, SHUT);
    assert.deepEqual(t.view.expanded, s.window.commits);
    assert.equal(a.post, t.view, 'the server was not told which trees to read');

    // And so does a browser that joins the room halfway through.
    const late = new Tape();
    late.arrive(state(1, ['a'], { learning: true }), SHUT, true);
    const two = state(2, ['b', 'a'], { learning: true });
    assert.equal(late.arrive(two, SHUT, true).post, late.view);
    assert.deepEqual(late.view.expanded, two.window.commits);
  });
});

/** A state whose window is full and has history behind it. */
function paged(seq: number) {
  const s = state(seq, ['a'], { limit: 8 }); // eight commits, eight asked for
  s.window.more = true;
  return s;
}

describe('paging', () => {
  it('offers more history only when there is more of it', () => {
    const t = new Tape();
    t.arrive(paged(1), SHUT);
    assert.equal(t.canLoadMore, true);
    assert.equal(t.loadMore(), true);
    assert.equal(t.view.limit, 1008);
  });

  it('stops offering it once the answer came back smaller than the question', () => {
    const t = new Tape();
    const s = paged(1);
    s.view = { ...s.view, limit: 500 }; // asked for 500, got eight
    t.arrive(s, SHUT);
    assert.equal(t.canLoadMore, false, 'there is nothing more to ask for');
    assert.equal(t.loadMore(), false);
    assert.equal(t.loadAll(), false);
    assert.equal(t.view.limit, 500, 'a refused page still moved the question');
  });

  it('does not page while the tape is standing further back', () => {
    const t = new Tape();
    t.arrive(paged(1), SHUT);
    t.arrive(paged(2), SHUT);
    t.step(-1);
    assert.equal(t.canLoadMore, false, 'that window happened, and is not being asked again');
    t.goLive();
    assert.equal(t.canLoadMore, true);
  });

  it('lets the server’s own ceiling be the only bound on "load all"', () => {
    const t = new Tape();
    t.arrive(paged(1), SHUT);
    assert.equal(t.loadAll(), true);
    assert.equal(t.view.limit, Number.MAX_SAFE_INTEGER);
  });

  it('starts paging over when the question changes', () => {
    const t = new Tape();
    const s = paged(1);
    s.view = { ...s.view, limit: 500 };
    t.arrive(s, SHUT);
    t.ask({ kind: 'search', text: 'x', in: 'message' });
    assert.deepEqual(t.view.question, { kind: 'search', text: 'x', in: 'message' });
    assert.equal(t.canLoadMore, true, 'a different question has its own window');
  });

  it('turns whichever control was touched into the one question', () => {
    assert.deepEqual(questionFor('all', 'ignored', ['ignored']), { kind: 'all' });
    assert.deepEqual(questionFor('branches', 'ignored', ['refs/heads/main']), {
      kind: 'refs',
      refs: ['refs/heads/main'],
    });
    assert.deepEqual(questionFor('author', 'ada', []), { kind: 'search', text: 'ada', in: 'author' });
  });
});

describe('what the header says', () => {
  it('counts what is on screen, and what the repository holds', () => {
    const t = new Tape();
    const s = state(1, ['a']);
    s.objects = {
      b1: { oid: 'b1', type: 'blob', size: 1 },
      t1: { oid: 't1', type: 'tree', size: 1 },
      c1: { oid: 'c1', type: 'commit', size: 1 },
      g1: { oid: 'g1', type: 'tag', size: 1 },
    };
    s.unreachable = ['b1'];
    t.arrive(s, SHUT);
    assert.equal(t.tally(12), '12 on screen · 8 commits · 1c 1t 1b 1g · 1 unreachable · 0 index');
  });

  it('says how many objects there are instead, when it was too big to read them', () => {
    const t = new Tape();
    const s = state(1, ['a']);
    s.caps = { ...s.caps, fullLoad: false, objectCount: 12_000 };
    s.unreachable = null;
    t.arrive(s, SHUT);
    assert.match(t.tally(3), /· 12,000 objects · 0 index$/);
  });

  it('has nothing to say before the first state arrives', () => {
    assert.equal(new Tape().tally(0), '');
    assert.deepEqual(new Tape().notes(), []);
  });

  it('passes on the server’s reasons, and owns up to what the tape itself dropped', () => {
    const t = new Tape();
    for (let i = 1; i <= TAPE_CAP + 1; i++) {
      const s = state(i, ['c' + i]);
      s.notes = ['Orphan detection is off in a repository this size.'];
      t.arrive(s, SHUT);
    }
    const notes = t.notes();
    assert.equal(notes[0], 'Orphan detection is off in a repository this size.');
    assert.match(notes[1], /400 states kept, 1 older ones dropped/);
  });
});

describe('pins', () => {
  it('holds an object where it was put, from that moment onwards', () => {
    const pins = new Pins();
    pins.put(2, 'b1', 10, 20);
    assert.deepEqual(pins.at(1), {}, 'a pin does not reach back before it was made');
    assert.deepEqual(pins.at(3), { b1: { x: 10, y: 20 } });
  });

  it('moves the pin rather than stacking them up while one object is dragged', () => {
    const pins = new Pins();
    pins.put(2, 'b1', 10, 20);
    pins.put(2, 'b1', 11, 21);
    assert.equal(pins.count, 1);
    assert.deepEqual(pins.at(2), { b1: { x: 11, y: 21 } });
  });

  it('lets a later moment put the same object somewhere else', () => {
    const pins = new Pins();
    pins.put(1, 'b1', 10, 20);
    pins.put(3, 'b1', 90, 90);
    assert.deepEqual(pins.at(2), { b1: { x: 10, y: 20 } });
    assert.deepEqual(pins.at(3), { b1: { x: 90, y: 90 } });
  });

  it('takes every pin of one object out at once, and says whether there were any', () => {
    const pins = new Pins();
    pins.put(1, 'b1', 10, 20);
    pins.put(3, 'b1', 90, 90);
    pins.put(1, 'b2', 5, 5);
    assert.equal(pins.drop('b1'), true);
    assert.equal(pins.drop('b1'), false, 'nothing to undo the second time');
    assert.deepEqual(pins.at(9), { b2: { x: 5, y: 5 } });
    pins.clear();
    assert.equal(pins.count, 0);
  });
});

describe('history from before this browser arrived', () => {
  it('replays it whole, standing the session\u2019s commits back up and asking the server nothing', () => {
    const t = new Tape();
    // The room got here without us; replaying it must not repeat what each
    // state did when it was new, or the page strobes through the session and
    // posts a view per step on the way. What it must not lose either is the
    // room's answer about the commits git made while it ran — the server
    // recorded each state with those open, so a reload finds them open.
    const before = [
      state(1, ['a']),
      state(2, ['b', 'a'], { expanded: [oid('b')] }),
      state(3, ['c', 'b', 'a'], { limit: 44, expanded: [oid('b'), oid('c')] }),
    ];
    for (const s of before) assert.equal(t.arrive(s, OPEN, true).post, null, 'replay told the server something');
    assert.equal(t.states.length, 3);
    assert.equal(t.cursor, 2, 'a replay leaves you standing on the newest state');
    assert.deepEqual(t.view.expanded, [oid('b'), oid('c')], 'a reload folded away the commits the session made');
    assert.equal(t.view.limit, 44, 'the question the room is on is the one to carry on with');
    assert.ok(t.world?.trees[oid('tb')], 'their trees came with the states, so nothing has to be asked for');

    // And what happens next is still something happening now.
    t.arrive(state(4, ['d', 'c', 'b', 'a'], { limit: 44 }), OPEN);
    assert.deepEqual(t.view.expanded, [oid('b'), oid('c'), oid('d')], 'the commit git just made stayed folded');
  });

  it('leaves folded whatever the session folded by hand, however much later', () => {
    const t = new Tape();
    // b opened itself when git made it, and was folded two states later —
    // folding is an answer, and a reload is not a chance to ask again.
    t.arrive(state(1, ['a']), OPEN, true);
    t.arrive(state(2, ['b', 'a'], { expanded: [oid('b')] }), OPEN, true);
    t.arrive(state(3, ['c', 'b', 'a'], { expanded: [oid('c')] }), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('c')], 'the replay re-opened a commit somebody had folded');
  });

  it('inherits no folds about commits older than this browser', () => {
    const t = new Tape();
    // Another viewer had opened `a` — but the folds are the watcher's, and a
    // repository opens folded whatever the room is looking at.
    t.arrive(state(1, ['a'], { expanded: [oid('a')] }), OPEN, true);
    t.arrive(state(2, ['b', 'a'], { expanded: [oid('a'), oid('b')] }), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('b')]);
  });

  it('does not call a commit new because it dropped out of the window and came back', () => {
    const t = new Tape();
    // A window is bounded and a question is a filter, so a commit can leave the
    // states and return. It was there when this browser was not, and coming
    // back is not git making it.
    t.arrive(state(1, ['a'], { expanded: [oid('a')] }), OPEN, true);
    t.arrive(state(2, ['b'], { expanded: [oid('a'), oid('b')] }), OPEN, true);
    t.arrive(state(3, ['a', 'b'], { expanded: [oid('a'), oid('b')] }), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('b')], 'a commit older than this browser was opened');
  });

  it('leaves the repository as it stood before the session folded', () => {
    const t = new Tape();
    const before = [state(1, ['a']), state(2, ['b', 'a'], { expanded: [oid('b')] })];
    for (const s of before) t.arrive(s, SHUT, true);
    assert.deepEqual(t.view.expanded, [], 'replay opened commits the setting said to leave folded');
  });
});

describe('folding a tree', () => {
  it('folds and unfolds one, and travels with the person up and down the tape', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), OPEN);
    assert.deepEqual(t.view.folded, [], 'a tree arrives open');
    t.toggleTree(oid('t1'));
    t.toggleTree(oid('t2'));
    assert.deepEqual(t.view.folded, [oid('t1'), oid('t2')]);
    t.toggleTree(oid('t1'));
    assert.deepEqual(t.view.folded, [oid('t2')], 'the same gesture opens it again');

    // A fold is held by the person watching, not by the state, exactly as an
    // opened commit is: stepping back must not silently open things.
    t.arrive(state(2, ['b', 'a']), OPEN);
    t.step(-1);
    assert.deepEqual(t.view.folded, [oid('t2')]);

    // "unfold all" means everything open, and a folded tree is not open.
    t.unfoldAll();
    assert.deepEqual(t.view.folded, []);
  });
});

describe('what the right button can mark', () => {
  it('marks every node that can get lost in the graph, and nothing else', () => {
    // One gesture for every kind: a mark is "keep an eye on this", and that is
    // the same wish for a commit as for a blob or a branch.
    // The index band is one chip per staged file, and a file is exactly what
    // you want to keep an eye on while it is staged and then reset.
    for (const kind of [
      'commit', 'tree', 'blob', 'tag', 'submodule', 'ref', 'head', 'index',
    ] as const) {
      assert.equal(canMark(kind), true, `${kind} could not be marked`);
    }
    // There is one "load more" button, and it cannot be mislaid.
    assert.equal(canMark('more'), false);
  });
});

describe('telling a double-click from two clicks', () => {
  it('pairs clicks by when and where the pointer was, not by what is under it', () => {
    const first = { at: 1000, x: 200, y: 100, id: 'a' };
    // The gesture that was missed by hand: centring on the first click slid the
    // node away, so the second click landed on nothing — the browser's own
    // `dblclick` then had nothing to fold, and nothing folded.
    assert.equal(isDouble(first, { at: 1180, x: 200, y: 100, id: null }), true);
    // A slip of a pixel or two between the two presses is still one gesture.
    assert.equal(isDouble(first, { at: 1180, x: 206, y: 104, id: 'a' }), true);
    // Two deliberate clicks: too slow, or somewhere else entirely.
    assert.equal(isDouble(first, { at: 1600, x: 200, y: 100, id: 'a' }), false);
    assert.equal(isDouble(first, { at: 1180, x: 260, y: 100, id: 'a' }), false);
    // The first click of the day has nothing to pair with.
    assert.equal(isDouble(null, first), false);
  });
});
