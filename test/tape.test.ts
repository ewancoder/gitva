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
import { isDouble, Pins, Tape, type Prefs } from '../web/tape.js';
import { layout } from '../src/layout.js';
import { TAPE_CAP, type Snapshot } from '../src/types.js';

const oid = (n: string) => (n + '-').padEnd(40, '0');
const OPEN: Prefs = { showIndex: true, openNewCommits: true };
const SHUT: Prefs = { showIndex: true, openNewCommits: false };

// Enough older history that a state is never small enough to be opened whole
// on arrival — that rule has its own test.
const FILL = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'];

/** A step of a repository whose commits each hold one tree of one blob. Every
 *  tree is in it, because that is what the server sends: a step carries
 *  everything any view could draw. */
function state(seq: number, commits: string[]): Snapshot {
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
    trees: Object.fromEntries(
      commits.map((c) => [
        oid('t' + c),
        [{ mode: '100644', type: 'blob' as const, oid: oid('b' + c), name: 'f.txt' }],
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
    notes: [],
  };
}

/** Is the tape standing somewhere that draws this commit's tree? */
const drawsTreeOf = (t: Tape, c: string) =>
  layout(t.world!, t.view).nodes.some((n) => n.oid === oid('t' + c));

describe('the tape', () => {
  // A dropped stream reconnects and the server hands over the whole recording
  // again. Every step of it is one the tape already holds, and a step is what
  // git did — so none of them is news, and none of them lands twice.
  it('ignores a step it is already holding', () => {
    const t = new Tape();
    t.arrive(state(1, ['c']), SHUT);
    t.arrive(state(2, ['d', 'c']), SHUT);
    for (const seq of [1, 2]) {
      const again = t.arrive(state(seq, ['c']), SHUT, true);
      assert.equal(again.kind, 'none');
    }
    assert.equal(t.states.length, 2);
  });

  // `--fresh`: the presenter started the recording over. Nothing tells a tab to
  // reload — the stream reconnects by itself and is handed a whole recording
  // numbered from one again — so a tab left open must not take those steps for
  // ones it already holds and sit there, live, showing a recording that is gone.
  it('starts over when the recording it is handed is numbered from one again', () => {
    const t = new Tape();
    t.arrive(state(1, ['c']), SHUT);
    t.arrive(state(2, ['d', 'c']), SHUT);
    t.scrubTo(0);

    const over = t.arrive({ ...state(1, ['e']), time: 99 }, SHUT, true);
    assert.equal(over.kind, 'shown', 'the first step of the new recording was taken for a re-send');
    assert.equal(t.states.length, 1);
    assert.equal(t.cursor, 0);
    assert.ok(t.following, 'left standing in a recording that no longer exists');
    assert.equal(t.arrive({ ...state(2, ['f', 'e']), time: 100 }, SHUT, true).kind, 'shown');
    assert.equal(t.states.length, 2);
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
    t.arrive(state(1, ['a']), OPEN);
    t.arrive(state(2, ['b', 'a']), OPEN); // b arrives open
    assert.ok(t.view.expanded.includes(oid('b')));
    t.toggle(oid('b')); // ...and is folded by hand
    t.arrive(state(3, ['c', 'b', 'a']), OPEN);
    assert.ok(!t.view.expanded.includes(oid('b')), 'a new state re-opened it');
    t.scrubTo(1);
    assert.ok(!t.view.expanded.includes(oid('b')), 'stepping back re-opened it');
  });

  it('draws a commit opened now on a state recorded before it was', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.arrive(state(2, ['b', 'a']), SHUT);
    t.scrubTo(0);
    t.toggle(oid('a'));
    // Nothing is asked for and nothing arrives: the tree was in the step all
    // along, and expanding a commit is a redraw.
    assert.ok(drawsTreeOf(t, 'a'), 'the tree read a moment ago is the same tree');
    t.goLive();
    assert.ok(drawsTreeOf(t, 'a'));
  });

  it('opens a commit made while the tape is paused, without moving the tape', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), OPEN);
    t.scrubTo(0);
    const arrival = t.arrive(state(2, ['b', 'a']), OPEN);
    assert.equal(arrival.kind, 'none', 'a paused watcher is not moved');
    assert.ok(t.view.expanded.includes(oid('b')), 'the new commit was never opened');
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

  it('opens every repository collapsed, however small', () => {
    const big = new Tape();
    big.arrive(state(1, []), SHUT);
    assert.deepEqual(big.view.expanded, []);

    const small = new Tape();
    const s = state(1, []);
    s.window.commits = s.window.commits.slice(0, 3);
    small.arrive(s, SHUT);
    assert.deepEqual(small.view.expanded, []);
  });

  it('opens every commit on arrival when the run is a demonstration', () => {
    // `--learning`: a demo repository shown to people, where nobody should have
    // to expand anything to see the same picture as everyone else. It is a fact
    // about the run, told on connecting, so it holds for a step recorded before
    // anyone said it — and it puts the links out of the unreachable up too,
    // because in a demonstration the orphans are the point.
    const t = new Tape();
    t.presenting(true);
    const s = state(1, ['a', 'b']);
    t.arrive(s, SHUT);
    assert.deepEqual(t.view.expanded, s.window.commits);
    assert.equal(t.view.showCrossLinks, true);

    // And so does a browser that joins the room halfway through.
    const late = new Tape();
    late.presenting(true);
    late.arrive(state(1, ['a']), SHUT, true);
    const two = state(2, ['b', 'a']);
    late.arrive(two, SHUT, true);
    assert.deepEqual(late.view.expanded, two.window.commits);
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

  // The bug: switch the index off, walk back through the recording, switch it
  // on again — every step was drawn with the toggle it was recorded under, so
  // the index stayed off, and the steps recorded while it was off held no index
  // to draw. Same for unreachable and the links out of it: they are the
  // viewer's, and the recording is git's.
  it('keeps the view toolbar’s toggles yours, wherever you stand in the recording', () => {
    const t = new Tape();
    for (const i of [1, 2, 3]) t.arrive(state(i, ['c' + i]), SHUT);
    t.view = { ...t.view, showIndex: false, showUnreachable: false, showCrossLinks: true };

    t.scrubTo(0);
    assert.equal(t.view.showIndex, false);
    assert.equal(t.view.showUnreachable, false);
    assert.equal(t.view.showCrossLinks, true);

    t.view = { ...t.view, showIndex: true };
    t.goLive();
    assert.equal(t.view.showIndex, true, 'the step put the toggle back');
    t.scrubTo(1);
    assert.equal(t.view.showIndex, true);
  });

  it('does not let a step arriving turn a toggle back on', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.view = { ...t.view, showIndex: false };
    // A step says what git did and nothing about how anyone is looking at it.
    t.arrive(state(2, ['b']), SHUT, true);
    assert.equal(t.view.showIndex, false);
  });

  it('says what this browser is hiding, and only while it is hiding it', () => {
    const t = new Tape();
    t.arrive(state(1, ['a']), SHUT);
    t.view = { ...t.view, showIndex: false, showUnreachable: false };
    const notes = t.notes();
    assert.equal(notes.length, 2);
    assert.match(notes[0], /index/i);
    assert.match(notes[1], /[Uu]nreachable/);
    t.view = { ...t.view, showIndex: true, showUnreachable: true };
    assert.deepEqual(t.notes(), []);
  });

  it('passes on the server’s reasons, and owns up to what the tape itself dropped', () => {
    const t = new Tape();
    for (let i = 1; i <= TAPE_CAP + 1; i++) {
      const s = state(i, ['c' + i]);
      s.notes = [{ id: 'noUnreachableDetection', args: [12_345] }];
      t.arrive(s, SHUT);
    }
    const notes = t.notes();
    // The step carries an id and a number; the sentence is put together here,
    // in the language this browser is set to.
    assert.match(notes[0], /Unreachable detection is off: repository is too big - 12,345 objects/);
    assert.match(notes[1], /400 steps kept, 1 older ones dropped/);
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

  // The reload path: the browser writes its pins out and hands them back.
  it('brings pins back after a reload, holding from the first step there is', () => {
    const before = new Pins();
    before.put(4, 'b1', 10, 20);
    before.put(7, 'b2', 30, 40);

    const after = new Pins();
    after.restore(JSON.parse(JSON.stringify(before.all)) as { id: string; x: number; y: number }[]);
    // Not waiting for step 4 to come round again: a recording that was cleared
    // is back at step one, and a pin nobody can see is a pin nobody can undo.
    assert.deepEqual(after.at(1), { b1: { x: 10, y: 20 }, b2: { x: 30, y: 40 } });
    assert.equal(after.count, 2);
  });
});

describe('history from before this browser arrived', () => {
  it('replays it whole, standing the session’s commits back up and asking nothing', () => {
    const t = new Tape();
    // The room got here without us; replaying it must not repeat what each step
    // did when it was new, or the page strobes through the session. What it must
    // not lose either is that git made those commits while it ran — a commit
    // born during the session comes back expanded, the way it opened itself.
    const before = [state(1, ['a']), state(2, ['b', 'a']), state(3, ['c', 'b', 'a'])];
    for (const s of before) assert.equal(t.arrive(s, OPEN, true).kind, 'shown');
    assert.equal(t.states.length, 3);
    assert.equal(t.cursor, 2, 'a replay leaves you standing on the newest step');
    assert.deepEqual(t.view.expanded, [oid('b'), oid('c')], 'a reload collapsed the session’s commits');
    assert.ok(t.world?.trees[oid('tb')], 'their trees came with the steps, so nothing has to be asked for');

    // And what happens next is still something happening now.
    t.arrive(state(4, ['d', 'c', 'b', 'a']), OPEN);
    assert.deepEqual(t.view.expanded, [oid('b'), oid('c'), oid('d')], 'the commit git just made stayed collapsed');
  });

  it('hands back what was expanded by hand, whatever the step says', () => {
    // The gesture is this person's answer, not the step's, so it has to survive
    // the page: an old commit they expanded comes back expanded, and its tree is
    // in every step already.
    const first = new Tape();
    first.arrive(state(1, ['a']), SHUT);
    first.toggle(oid('a'));

    const reloaded = new Tape();
    reloaded.answers = JSON.parse(JSON.stringify(first.answers)); // through localStorage
    reloaded.arrive(state(1, ['a']), SHUT, true);
    assert.ok(reloaded.view.expanded.includes(oid('a')), 'a reload collapsed what was expanded by hand');
    assert.ok(drawsTreeOf(reloaded, 'a'));
  });

  it('keeps a commit collapsed by hand in a room where everything else is open', () => {
    const first = new Tape();
    first.presenting(true);
    first.arrive(state(1, ['a', 'b']), SHUT);
    first.toggle(oid('a'));

    const reloaded = new Tape();
    reloaded.presenting(true);
    reloaded.answers = { ...first.answers };
    reloaded.arrive(state(1, ['a', 'b']), SHUT);
    assert.ok(!reloaded.view.expanded.includes(oid('a')), '--learning re-opened a commit somebody had collapsed');
    assert.ok(reloaded.view.expanded.includes(oid('b')), 'the rest of the room lost its expanded commits');
  });

  it('leaves collapsed whatever was collapsed by hand, however much later', () => {
    // `b` opened itself when git made it, and was collapsed two steps later —
    // collapsing is an answer, and a reload is not a chance to ask again.
    const first = new Tape();
    first.arrive(state(1, ['a']), OPEN);
    first.arrive(state(2, ['b', 'a']), OPEN);
    first.arrive(state(3, ['c', 'b', 'a']), OPEN);
    first.toggle(oid('b'));

    const t = new Tape();
    t.answers = { ...first.answers };
    t.arrive(state(1, ['a']), OPEN, true);
    t.arrive(state(2, ['b', 'a']), OPEN, true);
    t.arrive(state(3, ['c', 'b', 'a']), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('c')], 'the replay re-opened a commit somebody had collapsed');
  });

  it('inherits nothing about commits older than this browser', () => {
    const t = new Tape();
    // The repository opens collapsed whatever anyone else is looking at: what
    // was expanded elsewhere is that viewer's, and never travels.
    t.arrive(state(1, ['a']), OPEN, true);
    t.arrive(state(2, ['b', 'a']), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('b')]);
  });

  it('does not call a commit new because it dropped out of the window and came back', () => {
    const t = new Tape();
    // A window is bounded, so a commit can leave the steps and return. It was
    // there when this browser was not, and coming back is not git making it.
    t.arrive(state(1, ['a']), OPEN, true);
    t.arrive(state(2, ['b']), OPEN, true);
    t.arrive(state(3, ['a', 'b']), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('b')], 'a commit older than this browser was opened');
  });

  it('leaves the repository as it stood before the session, when that is the setting', () => {
    const t = new Tape();
    for (const s of [state(1, ['a']), state(2, ['b', 'a'])]) t.arrive(s, SHUT, true);
    assert.deepEqual(t.view.expanded, [], 'replay opened commits the setting said to leave collapsed');
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

  // The reload path: the browser writes its folds out and hands them back on
  // the next load, and the first state to arrive used to wipe them.
  it('leaves a tree folded that was folded before the page was reloaded', () => {
    const t = new Tape();
    t.view = { ...t.view, folded: [oid('t2')] };
    t.arrive(state(1, ['a']), OPEN);
    assert.deepEqual(t.view.folded, [oid('t2')], 'still shut, without anyone asking again');
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
