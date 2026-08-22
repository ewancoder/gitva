/**
 * The recording: every step the browser has been shown, where you are
 * standing in it, and the view you are looking with.
 *
 * Nothing in here asks the server for anything — there is nothing to ask. A
 * step is what git did and arrives whole; a view is how you look at it, and it
 * never leaves this object.
 *
 * No browser in here — the rules about what is recorded, what is shown and
 * what stays collapsed are the ones that got quietly broken by hand, so they are
 * a plain object with tests (`test/recording.test.ts`) rather than something you can
 * only check by scrubbing and squinting.
 */

import { renderNote, S } from '../src/strings.js';
import { DEFAULT_VIEW, RECORDING_CAP, type Oid, type Step, type TreeEntry, type View } from '../src/types.js';

/** What the caller has to repaint after a step arrived. */
export type Arrival =
  | { kind: 'none' }
  | { kind: 'shown'; prev: Step | null; first: boolean };

export interface Settings {
  showIndex: boolean;
  expandNewCommits: boolean;
}

export class Recording {
  readonly steps: Step[] = [];
  dropped = 0;
  cursor = -1;
  following = true;
  view: View = { ...DEFAULT_VIEW };
  /** `--learning`: the presenter is showing a small repository to viewers, so
   *  every commit is expanded before anyone touches it. A fact about the run,
   *  told once on connecting, never a property of a step. */
  learning = false;

  /** What the presenter said on the command line, heard once on connecting.
   *  `--learning` also puts the links out of the unreachable up before anyone
   *  asks: in a demonstration the unreachable objects are the point.
   *
   *  `yours` is what this browser kept, `null` if it has never been asked. It
   *  wins, because *before anyone asks* is exactly what the flag says: an answer
   *  you gave must not be overruled by every reconnection for the rest of the
   *  session. */
  presenting(learning: boolean, yours: boolean | null = null) {
    this.learning = learning;
    if (yours !== null) this.view = { ...this.view, showLinksFromUnreachable: yours };
    else if (learning) this.view = { ...this.view, showLinksFromUnreachable: true };
  }

  /** Every tree ever read, across every step. An object *is* its contents, so
   *  a tree read at any moment is that tree at every moment — which is what
   *  lets a commit opened now be drawn open on a step recorded before. */
  private readonly trees: Record<Oid, TreeEntry[]> = {};
  /** Every commit any step has ever shown, and — of those — the ones that
   *  appeared while the recording was running rather than being there from the
   *  start. A commit can leave a window and come back (a filter, a page
   *  boundary, a branch moving), so "new" has to mean new to the whole recording,
   *  not to the step before. `born` is what a replay may find already open. */
  private readonly seen = new Set<Oid>();
  private readonly born = new Set<Oid>();
  /** What you have said by hand about each commit — open or collapsed.
   *  Held apart from the view because it is theirs and not the step's: the
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

  get current(): Step | null {
    return this.steps[this.cursor] ?? null;
  }
  get last(): Step | null {
    return this.steps[this.steps.length - 1] ?? null;
  }
  /** The step on screen, told everything the recording knows about trees. */
  get shown(): Step | null {
    const s = this.current;
    return s && { ...s, trees: { ...this.trees, ...s.trees } };
  }

  /** A step off the wire. `replay` is the recording the viewers walked before this
   *  browser arrived: it is recorded, and a commit made during it stands as this
   *  browser left it — open if it opened itself and nobody collapsed it, so a
   *  reload does not collapse away what the session expanded. Nothing is asked of
   *  the server: everything the view could draw is already in the step, trees
   *  and all. */
  arrive(s: Step, settings: Settings, replay = false): Arrival {
    Object.assign(this.trees, s.trees);
    if (this.restarted(s)) this.startOver();
    const first = this.steps.length === 0;
    const last = this.last;
    // Steps arrive in order and only git makes one, so anything not newer than
    // the newest held is the recording being sent again — a reconnected stream
    // replays the whole of it, and it must not land on the recording twice.
    if (last && s.seq <= last.seq) return { kind: 'none' };

    const openAll = this.learning ? [...s.window.commits] : [];

    if (first) {
      // Everything otherwise starts collapsed: opening a repository should cost
      // nothing to draw, and expanding a commit is the gesture the tutorial
      // wants asked.
      // `collapsed` is this browser's and nobody else's — a tree it shut before a
      // reload is still shut, the same way a commit it collapsed is.
      this.view = { ...this.view, showIndex: settings.showIndex, expanded: this.answered(openAll) };
    } else if (replay && last) {
      // A commit born during the replayed session keeps whatever this browser
      // last said about it — opened by the rule below when it was made, or
      // collapsed by hand since, which is an answer a reload must not undo.
      // Commits older than this browser stay collapsed: whether one is expanded
      // is yours, and you have not said anything about them yet.
      for (const c of s.window.commits) if (!this.seen.has(c)) this.born.add(c);
      this.view = {
        ...this.view,
        expanded: this.answered(this.learning ? openAll : settings.expandNewCommits ? [...this.born] : []),
      };
    } else if (settings.expandNewCommits) {
      // A commit git just made opens itself: the lesson is that it points at
      // the trees and blobs already on screen, which collapsing it away would
      // hide. Once, too: collapsing it afterwards is an answer, and it does not
      // get asked again.
      const had = new Set([...this.seen, ...this.view.expanded]);
      const fresh = s.window.commits.filter((c) => !had.has(c));
      if (fresh.length > 0) this.view = { ...this.view, expanded: [...this.view.expanded, ...fresh] };
    }

    for (const c of s.window.commits) this.seen.add(c);

    this.steps.push(s);
    if (this.steps.length > RECORDING_CAP) {
      this.steps.shift();
      this.dropped++;
      // The oldest step fell off the end; standing still means standing on
      // the same step, not on the same number.
      this.cursor = Math.max(0, this.cursor - 1);
    }
    if (!this.following) return { kind: 'none' };
    const prev = this.current;
    this.cursor = this.steps.length - 1;
    return { kind: 'shown', prev, first };
  }

  /**
   * `--fresh` starts the recording over, and step numbers start over with it.
   * The stream reconnects on its own and is handed the whole recording, so a
   * number this browser already holds arriving *again* is the witness: the same
   * number at another moment is not the step being re-sent, it is a different
   * step of a recording that replaced the one being held. Held steps are
   * numbered in order, so only a number no newer than the newest can collide.
   */
  private restarted(s: Step): boolean {
    if (!this.last || s.seq > this.last.seq) return false;
    const held = this.steps.find((h) => h.seq === s.seq);
    return held !== undefined && held.time !== s.time;
  }

  /** Let go of a recording that no longer exists, and of standing anywhere in
   *  it. What is yours is kept: the trees, because an object is its contents at
   *  every moment, and every expand and collapse you answered by hand. */
  private startOver() {
    this.steps.length = 0;
    this.dropped = 0;
    this.cursor = -1;
    this.following = true;
    this.seen.clear();
    this.born.clear();
  }

  /** Show step `i`; returns what was on screen before, or null if it can't. */
  jump(i: number): { prev: Step | null } | null {
    if (!this.steps[i]) return null;
    const prev = this.current;
    this.cursor = i;
    // The view does not move with the recording: it is how *you* are looking, so a
    // commit you expanded stays expanded wherever you stand, and the toolbar's
    // toggles hold across every step you walk over.
    return { prev };
  }

  step(d: number) {
    const i = Math.min(this.steps.length - 1, Math.max(0, this.cursor + d));
    this.following = i === this.steps.length - 1;
    return this.jump(i);
  }

  scrubTo(i: number) {
    this.following = false;
    return this.jump(i);
  }

  goLive() {
    this.following = true;
    return this.jump(this.steps.length - 1);
  }

  /** Collapse or expand a tree. Trees arrive open, so this list is the closed ones
   *  — the reverse of `expanded`, because the defaults are the reverse too. */
  toggleTree(oid: Oid) {
    const off = this.view.collapsed ?? [];
    this.view = { ...this.view, collapsed: off.includes(oid) ? off.filter((o) => o !== oid) : [...off, oid] };
  }

  /** The three expand and collapse gestures — the only things that own `expanded`. */
  toggle(oid: Oid) {
    const on = this.view.expanded.includes(oid);
    this.answers[oid] = !on;
    this.view = {
      ...this.view,
      expanded: on ? this.view.expanded.filter((o) => o !== oid) : [...this.view.expanded, oid],
    };
  }
  /** Both act on what is on screen: collapses made elsewhere in the recording are not
   *  something this gesture said anything about. */
  expandAll() {
    for (const c of this.current?.window.commits ?? []) this.answers[c] = true;
    const on = new Set([...this.view.expanded, ...(this.current?.window.commits ?? [])]);
    this.view = { ...this.view, expanded: [...on], collapsed: [] };
  }
  collapseAll() {
    const off = new Set(this.current?.window.commits ?? []);
    for (const c of off) this.answers[c] = false;
    this.view = { ...this.view, expanded: this.view.expanded.filter((o) => !off.has(o)) };
  }

  /** The counts line: what is on screen, and what the repository holds. */
  tally(drawn: number): string {
    const step = this.current;
    if (!step) return '';
    const kinds = { commit: 0, tree: 0, blob: 0, tag: 0 };
    for (const o of Object.values(step.objects)) kinds[o.type]++;
    const commits = step.window.commits.length;
    return step.capabilities.fullLoad
      ? S.status.tally(drawn, commits, kinds, (step.unreachable ?? []).length, step.index.length)
      : S.status.tallyBig(drawn, commits, step.capabilities.objectCount, step.index.length);
  }

  /** What this canvas is not showing — the server's reasons, plus our own. */
  notes(): string[] {
    const notes = (this.current?.notes ?? []).map(renderNote);
    // What this browser is hiding is this browser's to say — the step cannot,
    // because the same step is read by a viewer who has the index on.
    if (!this.view.showIndex) notes.push(renderNote({ id: 'indexHidden' }));
    if (this.view.showUnreachable === false && this.current?.capabilities.fullLoad) {
      notes.push(renderNote({ id: 'unreachableHidden' }));
    }
    if (this.dropped > 0) {
      notes.push(S.status.stepsDropped(this.steps.length, this.dropped));
    }
    return notes;
  }
}

/**
 * Pins: objects put somewhere by hand. A pin belongs to the moment it was made
 * in — drag a blob on today's step and yesterday's canvas is untouched — so
 * they live with the recording rather than with the camera.
 */
export class Pins {
  private readonly list: { seq: number; id: Oid; x: number; y: number }[] = [];

  get count(): number {
    return this.list.length;
  }

  /** Where things are pinned as of step `seq`: a pin holds from then on. */
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

  /** Shift-clicking a shape is the undo of dragging it, at every moment. */
  drop(id: Oid): boolean {
    const n = this.list.length;
    for (let i = n - 1; i >= 0; i--) if (this.list[i].id === id) this.list.splice(i, 1);
    return n !== this.list.length;
  }

  clear() {
    this.list.length = 0;
  }
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
 * `dblclick` cannot be used for it: the first click may centre the shape it
 * landed on, and the second click then arrives over whatever the camera moved
 * into that spot — so the pair is told apart by when and where the pointer
 * was, and the gesture acts on what the *first* click hit.
 */
export function isDouble(prev: Click | null, now: Click): boolean {
  return !!prev && now.at - prev.at < 500 && Math.abs(now.x - prev.x) < 12 && Math.abs(now.y - prev.y) < 12;
}
