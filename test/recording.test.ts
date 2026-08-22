/**
 * The recording and the collapses that ride on it.
 *
 * Which commits are open is the one thing you are holding in
 * their head, so it has to survive every way of moving through history. This
 * was broken by hand — walking back two steps, opening three commits, walking
 * forward and back again found them collapsed — so every rule about it is here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDouble, Pins, Recording, type Settings } from '../web/recording.js';
import { layout } from '../src/layout.js';
import { RECORDING_CAP, type Step } from '../src/types.js';

const oid = (n: string) => (n + '-').padEnd(40, '0');
const OPEN: Settings = { showIndex: true, expandNewCommits: true };
const SHUT: Settings = { showIndex: true, expandNewCommits: false };

// Enough older history that a step is never small enough to be opened whole
// on arrival — that rule has its own test.
const FILL = ['z1', 'z2', 'z3', 'z4', 'z5', 'z6', 'z7'];

/** A step of a repository whose commits each hold one tree of one blob. Every
 *  tree is in it, because that is what the server sends: a step carries
 *  everything any view could draw. */
function step(seq: number, commits: string[]): Step {
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
    capabilities: {
      objectCount: 10,
      looseCount: 10,
      refCount: 1,
      fullLoad: true,
      indexShapes: true,
      commitGraph: false,
      limits: { fullLoad: 60_000, indexShapes: 400 },
    },
    window: { commits: list, totalCommits: list.length, more: false, refsOutside: 0 },
    notes: [],
  };
}

/** Is the recording standing somewhere that draws this commit's tree? */
const drawsTreeOf = (t: Recording, c: string) =>
  layout(t.shown!, t.view).shapes.some((n) => n.oid === oid('t' + c));

describe('the recording', () => {
  // A dropped stream reconnects and the server hands over the whole recording
  // again. Every step of it is one the recording already holds, and a step is what
  // git did — so none of them is news, and none of them lands twice.
  it('ignores a step it is already holding', () => {
    const t = new Recording();
    t.arrive(step(1, ['c']), SHUT);
    t.arrive(step(2, ['d', 'c']), SHUT);
    for (const seq of [1, 2]) {
      const again = t.arrive(step(seq, ['c']), SHUT, true);
      assert.equal(again.kind, 'none');
    }
    assert.equal(t.steps.length, 2);
  });

  // `--fresh`: the presenter started the recording over. Nothing tells a tab to
  // reload — the stream reconnects by itself and is handed a whole recording
  // numbered from one again — so a tab left open must not take those steps for
  // ones it already holds and sit there, live, showing a recording that is gone.
  it('starts over when the recording it is handed is numbered from one again', () => {
    const t = new Recording();
    t.arrive(step(1, ['c']), SHUT);
    t.arrive(step(2, ['d', 'c']), SHUT);
    t.scrubTo(0);

    const over = t.arrive({ ...step(1, ['e']), time: 99 }, SHUT, true);
    assert.equal(over.kind, 'shown', 'the first step of the new recording was taken for a re-send');
    assert.equal(t.steps.length, 1);
    assert.equal(t.cursor, 0);
    assert.ok(t.following, 'left standing in a recording that no longer exists');
    assert.equal(t.arrive({ ...step(2, ['f', 'e']), time: 100 }, SHUT, true).kind, 'shown');
    assert.equal(t.steps.length, 2);
  });

  it('keeps you on the step you were watching when the oldest one drops', () => {
    const t = new Recording();
    for (let i = 1; i <= RECORDING_CAP; i++) t.arrive(step(i, ['c' + i]), SHUT);
    t.scrubTo(10);
    const watching = t.current;
    t.arrive(step(RECORDING_CAP + 1, ['later']), SHUT);
    assert.equal(t.steps.length, RECORDING_CAP);
    assert.equal(t.current, watching);
  });
});

describe('what is collapsed', () => {
  it('stays open on every step once it has been opened', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), SHUT);
    t.arrive(step(2, ['b', 'a']), SHUT);
    t.arrive(step(3, ['c', 'b', 'a']), SHUT);
    t.step(-2);
    t.toggle(oid('a'));
    assert.ok(t.view.expanded.includes(oid('a')));
    t.step(1);
    assert.ok(t.view.expanded.includes(oid('a')), 'walking forward collapsed it again');
    t.step(-1);
    assert.ok(t.view.expanded.includes(oid('a')), 'walking back collapsed it again');
    t.goLive();
    assert.ok(t.view.expanded.includes(oid('a')), 'going live collapsed it again');
  });

  it('stays collapsed on every step once it has been collapsed by hand', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), OPEN);
    t.arrive(step(2, ['b', 'a']), OPEN); // b arrives open
    assert.ok(t.view.expanded.includes(oid('b')));
    t.toggle(oid('b')); // ...and is collapsed by hand
    t.arrive(step(3, ['c', 'b', 'a']), OPEN);
    assert.ok(!t.view.expanded.includes(oid('b')), 'a new step re-opened it');
    t.scrubTo(1);
    assert.ok(!t.view.expanded.includes(oid('b')), 'stepping back re-opened it');
  });

  it('draws a commit opened now on a step recorded before it was', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), SHUT);
    t.arrive(step(2, ['b', 'a']), SHUT);
    t.scrubTo(0);
    t.toggle(oid('a'));
    // Nothing is asked for and nothing arrives: the tree was in the step all
    // along, and expanding a commit is a redraw.
    assert.ok(drawsTreeOf(t, 'a'), 'the tree read a moment ago is the same tree');
    t.goLive();
    assert.ok(drawsTreeOf(t, 'a'));
  });

  it('opens a commit made while the recording is paused, without moving the recording', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), OPEN);
    t.scrubTo(0);
    const arrival = t.arrive(step(2, ['b', 'a']), OPEN);
    assert.equal(arrival.kind, 'none', 'a paused viewer is not moved');
    assert.ok(t.view.expanded.includes(oid('b')), 'the new commit was never opened');
    t.goLive();
    assert.ok(t.view.expanded.includes(oid('b')), 'it arrived collapsed after all');
  });

  it('does not open a commit that only came back into the window', () => {
    const t = new Recording();
    // Windows are bounded and questions filter, so a commit leaves and returns.
    // Only what git has just made opens itself — and this one was already here,
    // collapsed, when you last saw it.
    t.arrive(step(1, ['a', 'b']), OPEN);
    t.arrive(step(2, ['a']), OPEN);
    t.arrive(step(3, ['a', 'b']), OPEN);
    assert.deepEqual(t.view.expanded, [], 'an old commit opened itself on the way back in');
  });

  it('leaves a new commit collapsed when that is what was asked for', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), SHUT);
    t.arrive(step(2, ['b', 'a']), SHUT);
    assert.deepEqual(t.view.expanded, []);
  });

  it('collapses and expands only what is on screen', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), SHUT);
    t.arrive(step(2, ['b', 'a']), SHUT);
    t.expandAll();
    assert.ok(t.view.expanded.includes(oid('a')) && t.view.expanded.includes(oid('b')));
    t.scrubTo(0); // `b` was not made yet, so it is not on screen there
    t.collapseAll();
    assert.ok(!t.view.expanded.includes(oid('a')));
    assert.ok(t.view.expanded.includes(oid('b')), 'it collapsed a commit nobody could see');
  });

  it('opens every repository collapsed, however small', () => {
    const big = new Recording();
    big.arrive(step(1, []), SHUT);
    assert.deepEqual(big.view.expanded, []);

    const small = new Recording();
    const s = step(1, []);
    s.window.commits = s.window.commits.slice(0, 3);
    small.arrive(s, SHUT);
    assert.deepEqual(small.view.expanded, []);
  });

  it('opens every commit on arrival when the run is a demonstration', () => {
    // `--learning`: a demo repository shown to viewers, where nobody should have
    // to expand anything to see the same canvas as everyone else. It is a fact
    // about the run, told on connecting, so it holds for a step recorded before
    // anyone said it — and it puts the links out of the unreachable up too,
    // because in a demonstration the unreachable objects are the point.
    const t = new Recording();
    t.presenting(true);
    const s = step(1, ['a', 'b']);
    t.arrive(s, SHUT);
    assert.deepEqual(t.view.expanded, s.window.commits);
    assert.equal(t.view.showLinksFromUnreachable, true);

    // And so does a browser that joins halfway through.
    const late = new Recording();
    late.presenting(true);
    late.arrive(step(1, ['a']), SHUT, true);
    const two = step(2, ['b', 'a']);
    late.arrive(two, SHUT, true);
    assert.deepEqual(late.view.expanded, two.window.commits);
  });

  // The stream reconnects on its own, so `--learning` is said again every time
  // it does. A viewer who turned the links from unreachable off and reloaded
  // must not have them put back up under them, over and over, all session.
  it('leaves the links from unreachable as you last left them, demonstration or not', () => {
    const t = new Recording();
    t.presenting(true, false);
    assert.equal(t.view.showLinksFromUnreachable, false, 'the flag overruled an answer already given');

    const asked = new Recording();
    asked.presenting(false, true);
    assert.equal(asked.view.showLinksFromUnreachable, true, 'a kept answer was dropped');
  });
});

describe('what the toolbars say', () => {
  it('counts what is on screen, and what the repository holds', () => {
    const t = new Recording();
    const s = step(1, ['a']);
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
    const t = new Recording();
    const s = step(1, ['a']);
    s.capabilities = { ...s.capabilities, fullLoad: false, objectCount: 12_000 };
    s.unreachable = null;
    t.arrive(s, SHUT);
    assert.match(t.tally(3), /· 12,000 objects · 0 index$/);
  });

  it('has nothing to say before the first step arrives', () => {
    assert.equal(new Recording().tally(0), '');
    assert.deepEqual(new Recording().notes(), []);
  });

  // The bug: switch the index off, walk back through the recording, switch it
  // on again — every step was drawn with the toggle it was recorded under, so
  // the index stayed off, and the steps recorded while it was off held no index
  // to draw. Same for unreachable and the links out of it: they are the
  // viewer's, and the recording is git's.
  it('keeps the view toolbar’s toggles yours, wherever you stand in the recording', () => {
    const t = new Recording();
    for (const i of [1, 2, 3]) t.arrive(step(i, ['c' + i]), SHUT);
    t.view = { ...t.view, showIndex: false, showUnreachable: false, showLinksFromUnreachable: true };

    t.scrubTo(0);
    assert.equal(t.view.showIndex, false);
    assert.equal(t.view.showUnreachable, false);
    assert.equal(t.view.showLinksFromUnreachable, true);

    t.view = { ...t.view, showIndex: true };
    t.goLive();
    assert.equal(t.view.showIndex, true, 'the step put the toggle back');
    t.scrubTo(1);
    assert.equal(t.view.showIndex, true);
  });

  it('does not let a step arriving turn a toggle back on', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), SHUT);
    t.view = { ...t.view, showIndex: false };
    // A step says what git did and nothing about how anyone is looking at it.
    t.arrive(step(2, ['b']), SHUT, true);
    assert.equal(t.view.showIndex, false);
  });

  it('says what this browser is hiding, and only while it is hiding it', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), SHUT);
    t.view = { ...t.view, showIndex: false, showUnreachable: false };
    const notes = t.notes();
    assert.equal(notes.length, 2);
    assert.match(notes[0], /index/i);
    assert.match(notes[1], /[Uu]nreachable/);
    t.view = { ...t.view, showIndex: true, showUnreachable: true };
    assert.deepEqual(t.notes(), []);
  });

  it('passes on the server’s reasons, and owns up to what the recording itself dropped', () => {
    const t = new Recording();
    for (let i = 1; i <= RECORDING_CAP + 1; i++) {
      const s = step(i, ['c' + i]);
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

describe('the recording from before this browser arrived', () => {
  it('replays it whole, standing the session’s commits back up and asking nothing', () => {
    const t = new Recording();
    // The viewers got here without us; replaying it must not repeat what each step
    // did when it was new, or the page strobes through the session. What it must
    // not lose either is that git made those commits while it ran — a commit
    // born during the session comes back expanded, the way it opened itself.
    const before = [step(1, ['a']), step(2, ['b', 'a']), step(3, ['c', 'b', 'a'])];
    for (const s of before) assert.equal(t.arrive(s, OPEN, true).kind, 'shown');
    assert.equal(t.steps.length, 3);
    assert.equal(t.cursor, 2, 'a replay leaves you standing on the newest step');
    assert.deepEqual(t.view.expanded, [oid('b'), oid('c')], 'a reload collapsed the session’s commits');
    assert.ok(t.shown?.trees[oid('tb')], 'their trees came with the steps, so nothing has to be asked for');

    // And what happens next is still something happening now.
    t.arrive(step(4, ['d', 'c', 'b', 'a']), OPEN);
    assert.deepEqual(t.view.expanded, [oid('b'), oid('c'), oid('d')], 'the commit git just made stayed collapsed');
  });

  it('hands back what was expanded by hand, whatever the step says', () => {
    // The gesture is your answer, not the step's, so it has to survive
    // the page: an old commit they expanded comes back expanded, and its tree is
    // in every step already.
    const first = new Recording();
    first.arrive(step(1, ['a']), SHUT);
    first.toggle(oid('a'));

    const reloaded = new Recording();
    reloaded.answers = JSON.parse(JSON.stringify(first.answers)); // through localStorage
    reloaded.arrive(step(1, ['a']), SHUT, true);
    assert.ok(reloaded.view.expanded.includes(oid('a')), 'a reload collapsed what was expanded by hand');
    assert.ok(drawsTreeOf(reloaded, 'a'));
  });

  it('keeps a commit collapsed by hand where everything else is open', () => {
    const first = new Recording();
    first.presenting(true);
    first.arrive(step(1, ['a', 'b']), SHUT);
    first.toggle(oid('a'));

    const reloaded = new Recording();
    reloaded.presenting(true);
    reloaded.answers = { ...first.answers };
    reloaded.arrive(step(1, ['a', 'b']), SHUT);
    assert.ok(!reloaded.view.expanded.includes(oid('a')), '--learning re-opened a commit somebody had collapsed');
    assert.ok(reloaded.view.expanded.includes(oid('b')), 'the rest of the recording lost its expanded commits');
  });

  it('leaves collapsed whatever was collapsed by hand, however much later', () => {
    // `b` opened itself when git made it, and was collapsed two steps later —
    // collapsing is an answer, and a reload is not a chance to ask again.
    const first = new Recording();
    first.arrive(step(1, ['a']), OPEN);
    first.arrive(step(2, ['b', 'a']), OPEN);
    first.arrive(step(3, ['c', 'b', 'a']), OPEN);
    first.toggle(oid('b'));

    const t = new Recording();
    t.answers = { ...first.answers };
    t.arrive(step(1, ['a']), OPEN, true);
    t.arrive(step(2, ['b', 'a']), OPEN, true);
    t.arrive(step(3, ['c', 'b', 'a']), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('c')], 'the replay re-opened a commit somebody had collapsed');
  });

  it('inherits nothing about commits older than this browser', () => {
    const t = new Recording();
    // The repository opens collapsed whatever anyone else is looking at: what
    // was expanded elsewhere is that viewer's, and never travels.
    t.arrive(step(1, ['a']), OPEN, true);
    t.arrive(step(2, ['b', 'a']), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('b')]);
  });

  it('does not call a commit new because it dropped out of the window and came back', () => {
    const t = new Recording();
    // A window is bounded, so a commit can leave the steps and return. It was
    // there when this browser was not, and coming back is not git making it.
    t.arrive(step(1, ['a']), OPEN, true);
    t.arrive(step(2, ['b']), OPEN, true);
    t.arrive(step(3, ['a', 'b']), OPEN, true);
    assert.deepEqual(t.view.expanded, [oid('b')], 'a commit older than this browser was opened');
  });

  it('leaves the repository as it stood before the session, when that is the setting', () => {
    const t = new Recording();
    for (const s of [step(1, ['a']), step(2, ['b', 'a'])]) t.arrive(s, SHUT, true);
    assert.deepEqual(t.view.expanded, [], 'replay opened commits the setting said to leave collapsed');
  });
});

describe('collapsing a tree', () => {
  it('collapses and expands one, and travels with you up and down the recording', () => {
    const t = new Recording();
    t.arrive(step(1, ['a']), OPEN);
    assert.deepEqual(t.view.collapsed, [], 'a tree arrives open');
    t.toggleTree(oid('t1'));
    t.toggleTree(oid('t2'));
    assert.deepEqual(t.view.collapsed, [oid('t1'), oid('t2')]);
    t.toggleTree(oid('t1'));
    assert.deepEqual(t.view.collapsed, [oid('t2')], 'the same gesture opens it again');

    // A collapse is held by you, not by the step, exactly as an
    // opened commit is: stepping back must not silently open things.
    t.arrive(step(2, ['b', 'a']), OPEN);
    t.step(-1);
    assert.deepEqual(t.view.collapsed, [oid('t2')]);

    // "expand all" means everything open, and a collapsed tree is not open.
    t.expandAll();
    assert.deepEqual(t.view.collapsed, []);
  });

  // The reload path: the browser writes its collapses out and hands them back on
  // the next load, and the first step to arrive used to wipe them.
  it('leaves a tree collapsed that was collapsed before the page was reloaded', () => {
    const t = new Recording();
    t.view = { ...t.view, collapsed: [oid('t2')] };
    t.arrive(step(1, ['a']), OPEN);
    assert.deepEqual(t.view.collapsed, [oid('t2')], 'still shut, without anyone asking again');
  });
});

describe('telling a double-click from two clicks', () => {
  it('pairs clicks by when and where the pointer was, not by what is under it', () => {
    const first = { at: 1000, x: 200, y: 100, id: 'a' };
    // The gesture that was missed by hand: centring on the first click slid the
    // shape away, so the second click landed on nothing — the browser's own
    // `dblclick` then had nothing to collapse, and nothing collapsed.
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
