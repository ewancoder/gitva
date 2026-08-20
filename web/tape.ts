/**
 * The tape: every state the browser has been shown, where the person is
 * standing in it, and the view they are asking with.
 *
 * No browser in here — the rules about what is recorded, what is shown and
 * what stays folded are the ones that got quietly broken by hand, so they are
 * a plain object with tests (`test/tape.test.ts`) rather than something you can
 * only check by scrubbing and squinting.
 */

import type { NodeKind } from '../src/layout.js';
import { S } from '../src/strings.js';
import { DEFAULT_VIEW, TAPE_CAP, type Oid, type Question, type Snapshot, type TreeEntry, type View } from '../src/types.js';

/** What the caller has to repaint after a state arrived. */
export type Arrival =
  | { kind: 'none'; post: View | null }
  /** The same state, answered again — nothing happened in git. */
  | { kind: 'inplace'; post: View | null }
  | { kind: 'shown'; prev: Snapshot | null; first: boolean; post: View | null };

export interface Prefs {
  showIndex: boolean;
  openNewCommits: boolean;
}

/** True when we mean to draw a tree the server is not reading one for — the
 *  only reason a state's arrival has anything to say back to it. */
const wants = (mine: Oid[], theirs: Oid[]) => {
  const has = new Set(theirs);
  return mine.some((o) => !has.has(o));
};

export class Tape {
  readonly states: Snapshot[] = [];
  dropped = 0;
  cursor = -1;
  following = true;
  view: View = { ...DEFAULT_VIEW };
  /** The server answered with less than was asked for: this is all there is. */
  exhausted = false;

  /** Every tree ever read, across every state. An object *is* its contents, so
   *  a tree read at any moment is that tree at every moment — which is what
   *  lets a commit opened now be drawn open on a state recorded before. */
  private readonly trees: Record<Oid, TreeEntry[]> = {};
  /** Every commit any state has ever shown, and — of those — the ones that
   *  appeared while the tape was running rather than being there from the
   *  start. A commit can leave a window and come back (a filter, a page
   *  boundary, a branch moving), so "new" has to mean new to the whole tape,
   *  not to the state before. `born` is what a replay may find already open. */
  private readonly seen = new Set<Oid>();
  private readonly born = new Set<Oid>();
  /** What the watcher has said by hand about each commit — open or folded.
   *  Held apart from the view because it is theirs and not the state's: the
   *  browser writes it out and hands it back on the next load, so a commit
   *  that was in the repository before the session started comes back the way
   *  they left it rather than at its default. */
  answers: Record<Oid, boolean> = {};

  /** Their answers over whatever the defaults worked out to. */
  private answered(open: Oid[]): Oid[] {
    const on = new Set(open);
    for (const [oid, want] of Object.entries(this.answers)) if (want) on.add(oid);
      else on.delete(oid);
    return [...on];
  }

  get current(): Snapshot | null {
    return this.states[this.cursor] ?? null;
  }
  get last(): Snapshot | null {
    return this.states[this.states.length - 1] ?? null;
  }
  /** The state on screen, told everything the tape knows about trees. */
  get world(): Snapshot | null {
    const s = this.current;
    return s && { ...s, trees: { ...this.trees, ...s.trees } };
  }

  /** A state off the wire. `post` is a view the server has to be told about.
   *  `replay` is history the room walked before this browser arrived: it is
   *  recorded, and a commit made during it stands as the room left it — open if
   *  it opened itself and nobody folded it, so a reload does not fold away what
   *  the session unfolded. Nothing is asked of the server: the room's answer is
   *  already in the states, trees and all. */
  arrive(s: Snapshot, prefs: Prefs, replay = false): Arrival {
    Object.assign(this.trees, s.trees);
    if (s.window.commits.length < s.view.limit) this.exhausted = true;
    const first = this.states.length === 0;
    const last = this.last;
    let post: View | null = null;

    // `--learning`: the room is being shown a small repository, so every commit
    // in the window is open before anyone touches it — including for a browser
    // that joins late and replays. The server has to hear about it, because on
    // a repository too big to hold whole it reads only the opened trees.
    const openAll = s.view.learning ? [...s.window.commits] : [];

    if (first) {
      // Everything otherwise starts folded: opening a repository should cost
      // nothing to draw, and unfolding a commit is the gesture the tutorial
      // wants asked.
      // `folded` is this browser's and nobody else's — a tree it shut before a
      // reload is still shut, the same way a commit it folded is.
      this.view = {
        ...s.view,
        showIndex: prefs.showIndex,
        expanded: this.answered(openAll),
        folded: this.view.folded ?? [],
      };
      if (wants(this.view.expanded, s.view.expanded)) post = this.view;
    } else if (replay && last) {
      // A commit born during the replayed session keeps whatever the room last
      // said about it — opened by the rule below when it was made, or folded by
      // hand since, which is an answer a reload must not undo. Commits older
      // than this browser stay folded whatever anyone else opened: those folds
      // are the watcher's, and this watcher has not said anything yet.
      if (s.seq !== last.seq) for (const c of s.window.commits) if (!this.seen.has(c)) this.born.add(c);
      this.view = {
        ...s.view,
        showIndex: prefs.showIndex,
        expanded: this.answered(
          s.view.learning ? openAll : prefs.openNewCommits ? s.view.expanded.filter((c) => this.born.has(c)) : [],
        ),
        folded: this.view.folded,
      };
      if (wants(this.view.expanded, s.view.expanded)) post = this.view;
    } else if (prefs.openNewCommits && last && s.seq !== last.seq) {
      // A commit git just made opens itself: the lesson is that it points at
      // the trees and blobs already on screen, which folding it away would
      // hide. Only on a new state — paging in older commits is not something
      // that just happened. Once, too: folding it afterwards is an answer, and
      // it does not get asked again.
      const had = new Set([...this.seen, ...this.view.expanded]);
      const fresh = s.window.commits.filter((c) => !had.has(c));
      if (fresh.length > 0) {
        this.view = { ...this.view, expanded: [...this.view.expanded, ...fresh] };
        // Paused, the question on screen belongs to an older state while the
        // server is still on its own: only the folds travel.
        post = this.following ? this.view : { ...s.view, expanded: this.view.expanded };
      }
    }

    for (const c of s.window.commits) this.seen.add(c);

    // A step is a state of the repository. Asking the same repository a
    // different question — folding, filtering, paging — replaces the state in
    // place, so stepping back and forth only ever walks over things git did.
    const top = this.states.length - 1;
    if (top >= 0 && this.states[top].seq === s.seq) {
      this.states[top] = s;
      return { kind: this.cursor === top ? 'inplace' : 'none', post };
    }

    this.states.push(s);
    if (this.states.length > TAPE_CAP) {
      this.states.shift();
      this.dropped++;
      // The oldest state fell off the end; standing still means standing on
      // the same state, not on the same number.
      this.cursor = Math.max(0, this.cursor - 1);
    }
    if (!this.following) return { kind: 'none', post };
    const prev = this.current;
    this.cursor = this.states.length - 1;
    return { kind: 'shown', prev, first, post };
  }

  /** Show state `i`; returns what was on screen before, or null if it can't. */
  jump(i: number): { prev: Snapshot | null } | null {
    if (!this.states[i]) return null;
    const prev = this.current;
    this.cursor = i;
    // Each state was a state *of a view*, so going back to one puts its view
    // back — every part of it except which commits are open. That one is held
    // in the head of the person watching, across the whole tape: a commit they
    // opened stays open wherever they stand, and one they folded stays folded,
    // until they say otherwise.
    this.view = { ...this.states[i].view, expanded: this.view.expanded, folded: this.view.folded };
    return { prev };
  }

  step(d: number) {
    const i = Math.min(this.states.length - 1, Math.max(0, this.cursor + d));
    this.following = i === this.states.length - 1;
    return this.jump(i);
  }

  scrubTo(i: number) {
    this.following = false;
    return this.jump(i);
  }

  goLive() {
    this.following = true;
    return this.jump(this.states.length - 1);
  }

  /** Fold or unfold a tree. Trees arrive open, so this list is the closed ones
   *  — the reverse of `expanded`, because the defaults are the reverse too. */
  toggleTree(oid: Oid) {
    const off = this.view.folded ?? [];
    this.view = { ...this.view, folded: off.includes(oid) ? off.filter((o) => o !== oid) : [...off, oid] };
  }

  /** The three fold gestures — the only things that own `expanded`. */
  toggle(oid: Oid) {
    const on = this.view.expanded.includes(oid);
    this.answers[oid] = !on;
    this.view = {
      ...this.view,
      expanded: on ? this.view.expanded.filter((o) => o !== oid) : [...this.view.expanded, oid],
    };
  }
  /** Both act on what is on screen: folds made elsewhere in the tape are not
   *  something this gesture said anything about. */
  unfoldAll() {
    for (const c of this.current?.window.commits ?? []) this.answers[c] = true;
    const on = new Set([...this.view.expanded, ...(this.current?.window.commits ?? [])]);
    this.view = { ...this.view, expanded: [...on], folded: [] };
  }
  foldAll() {
    const off = new Set(this.current?.window.commits ?? []);
    for (const c of off) this.answers[c] = false;
    this.view = { ...this.view, expanded: this.view.expanded.filter((o) => !off.has(o)) };
  }

  /** A different question is a different window, so what was exhausted is not. */
  ask(q: Question) {
    this.exhausted = false;
    this.view = { ...this.view, question: q };
  }

  /** Paging is offered only when there is more, and only on the live end: a
   *  state further back is a state of a window that already happened. */
  get canLoadMore(): boolean {
    return !this.exhausted && !!this.current?.window.more && this.following;
  }

  /** Clicking "load more history" pages — scrolling never loads anything. */
  loadMore(): boolean {
    if (!this.canLoadMore) return false;
    this.view = { ...this.view, limit: this.view.limit + 1000 };
    return true;
  }

  /**
   * "load all" asks for no limit at all and lets the server's ceiling be the
   * only bound. Not `totalCommits`: that is null on a big repo, and counts the
   * whole repository rather than the matches under a search.
   */
  loadAll(): boolean {
    if (!this.canLoadMore) return false;
    this.view = { ...this.view, limit: Number.MAX_SAFE_INTEGER };
    return true;
  }

  /** The counts line: what is on screen, and what the repository holds. */
  tally(drawn: number): string {
    const snap = this.current;
    if (!snap) return '';
    const kinds = { commit: 0, tree: 0, blob: 0, tag: 0 };
    for (const o of Object.values(snap.objects)) kinds[o.type]++;
    const commits = snap.window.commits.length;
    return snap.caps.fullLoad
      ? S.status.tally(drawn, commits, kinds, (snap.unreachable ?? []).length, snap.index.length)
      : S.status.tallyBig(
          drawn,
          commits,
          snap.caps.objectCount.toLocaleString(),
          snap.index.length,
        );
  }

  /** What this picture is not showing — the server's reasons, plus our own. */
  notes(): string[] {
    const notes = [...(this.current?.notes ?? [])];
    if (this.dropped > 0) {
      notes.push(S.status.stepsDropped(this.states.length, this.dropped));
    }
    return notes;
  }
}

/** The toolbar's questions are one object, not three features. */
export function questionFor(kind: string, text: string, refs: string[]): Question {
  if (kind === 'all') return { kind: 'all' };
  if (kind === 'branches') return { kind: 'refs', refs };
  return { kind: 'search', text, in: kind as 'message' };
}

/**
 * Pins: objects put somewhere by hand. A pin belongs to the moment it was made
 * in — drag a blob on today's state and yesterday's picture is untouched — so
 * they live with the tape rather than with the camera.
 */
export class Pins {
  private readonly list: { seq: number; id: Oid; x: number; y: number }[] = [];

  get count(): number {
    return this.list.length;
  }

  /** Where things are pinned as of state `seq`: a pin holds from then on. */
  at(seq: number): Record<Oid, { x: number; y: number }> {
    const out: Record<Oid, { x: number; y: number }> = {};
    for (const p of this.list) if (p.seq <= seq) out[p.id] = { x: p.x, y: p.y };
    return out;
  }

  put(seq: number, id: Oid, x: number, y: number) {
    const at = this.list.find((p) => p.id === id && p.seq === seq);
    if (at) {
      at.x = x;
      at.y = y;
    } else this.list.push({ seq, id, x, y });
  }

  /** Every pin, for a browser to write out and hand back after a reload. */
  get all(): readonly { seq: number; id: Oid; x: number; y: number }[] {
    return this.list;
  }

  /** Pins from before a reload. They come back holding from the first step
   *  there is, not the one they were made at: a recording that has been cleared
   *  or has dropped its oldest steps would otherwise leave a pin waiting for a
   *  step number that is not coming back. */
  restore(pins: readonly { id: Oid; x: number; y: number }[]) {
    for (const p of pins) this.put(0, p.id, p.x, p.y);
  }

  /** Shift-clicking a node is the undo of dragging it, at every moment. */
  drop(id: Oid): boolean {
    const n = this.list.length;
    for (let i = n - 1; i >= 0; i--) if (this.list[i].id === id) this.list.splice(i, 1);
    return n !== this.list.length;
  }

  clear() {
    this.list.length = 0;
  }
}

/**
 * Whether the right button marks this node. One gesture for every kind: a mark
 * says "keep an eye on this" and that is the same wish whether the thing is a
 * commit, a blob, a branch or a staged path — the index band is one chip per
 * file, and a file is exactly the thing you want to follow across a stage and
 * a reset. Only the "more" button is left out: there is one of it, and it
 * cannot get lost in the graph.
 */
export function canMark(kind: NodeKind): boolean {
  return kind !== 'more';
}

/** One press of the left button, remembered only so the next one can be told
 *  apart from it. */
export interface Click {
  at: number;
  x: number;
  y: number;
  id: string | null;
}

/**
 * Whether this click is the second half of a double-click. The browser's own
 * `dblclick` cannot be used for it: the first click may centre the node it
 * landed on, and the second click then arrives over whatever the camera moved
 * into that spot — so the pair is told apart by when and where the pointer
 * was, and the gesture acts on what the *first* click hit.
 */
export function isDouble(prev: Click | null, now: Click): boolean {
  return !!prev && now.at - prev.at < 500 && Math.abs(now.x - prev.x) < 12 && Math.abs(now.y - prev.y) < 12;
}
