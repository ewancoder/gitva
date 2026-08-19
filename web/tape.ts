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
   *  recorded, but nothing that only makes sense for something happening now —
   *  opening the commit git just made, telling the server about it — happens. */
  arrive(s: Snapshot, prefs: Prefs, replay = false): Arrival {
    Object.assign(this.trees, s.trees);
    if (s.window.commits.length < s.view.limit) this.exhausted = true;
    const first = this.states.length === 0;
    const last = this.last;
    let post: View | null = null;

    if (first || replay) {
      // Everything starts folded: opening a repository should cost nothing to
      // draw, and unfolding a commit is the gesture the tutorial wants asked.
      this.view = { ...s.view, showIndex: prefs.showIndex, expanded: [], folded: [] };
    } else if (prefs.openNewCommits && last && s.seq !== last.seq) {
      // A commit git just made opens itself: the lesson is that it points at
      // the trees and blobs already on screen, which folding it away would
      // hide. Only on a new state — paging in older commits is not something
      // that just happened. Once, too: folding it afterwards is an answer, and
      // it does not get asked again.
      const had = new Set([...last.window.commits, ...this.view.expanded]);
      const fresh = s.window.commits.filter((c) => !had.has(c));
      if (fresh.length > 0) {
        this.view = { ...this.view, expanded: [...this.view.expanded, ...fresh] };
        // Paused, the question on screen belongs to an older state while the
        // server is still on its own: only the folds travel.
        post = this.following ? this.view : { ...s.view, expanded: this.view.expanded };
      }
    }

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
    this.view = {
      ...this.view,
      expanded: on ? this.view.expanded.filter((o) => o !== oid) : [...this.view.expanded, oid],
    };
  }
  /** Both act on what is on screen: folds made elsewhere in the tape are not
   *  something this gesture said anything about. */
  unfoldAll() {
    const on = new Set([...this.view.expanded, ...(this.current?.window.commits ?? [])]);
    this.view = { ...this.view, expanded: [...on], folded: [] };
  }
  foldAll() {
    const off = new Set(this.current?.window.commits ?? []);
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
    return (
      `${drawn} on screen · ${snap.window.commits.length} commits` +
      (snap.caps.fullLoad
        ? ` · ${kinds.commit}c ${kinds.tree}t ${kinds.blob}b${kinds.tag ? ` ${kinds.tag}g` : ''}` +
          ` · ${(snap.unreachable ?? []).length} unreachable`
        : ` · ${snap.caps.objectCount.toLocaleString()} objects`) +
      ` · ${snap.index.length} index`
    );
  }

  /** What this picture is not showing — the server's reasons, plus our own. */
  notes(): string[] {
    const notes = [...(this.current?.notes ?? [])];
    if (this.dropped > 0) {
      notes.push(`Tape: ${this.states.length} states kept, ${this.dropped} older ones dropped.`);
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
