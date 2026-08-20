/**
 * The vocabulary. Shared by the server that asks git the questions and the
 * browser that draws the answers, so both halves mean the same thing by
 * "commit", "ref" and "view".
 */

import type { Strings } from './strings.js';

export type Oid = string;
export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/** What git knows about an object without opening it: `cat-file --batch-check`. */
export interface GitObject {
  oid: Oid;
  type: ObjectType;
  size: number;
}

/** One line of a tree. The name lives here, never in the blob. */
export interface TreeEntry {
  mode: string;
  name: string;
  oid: Oid;
  type: ObjectType;
}

export interface Commit {
  oid: Oid;
  tree: Oid;
  parents: Oid[];
  author: string;
  authorDate: number;
  committer: string;
  subject: string;
  message: string;
}

/** An annotated tag: a name and a message pointing at another object. */
export interface TagObject {
  oid: Oid;
  target: Oid;
  targetType: ObjectType;
  name: string;
  tagger: string;
  message: string;
}

/** A ref is a file with a sha in it. `target` is the peeled sha for annotated tags. */
export interface Ref {
  name: string;
  oid: Oid;
  objectType: ObjectType;
  target?: Oid;
  packed: boolean;
}

export interface Head {
  /** Full refname when attached, undefined when detached. */
  ref?: string;
  oid?: Oid;
  detached: boolean;
  /** True when HEAD names a branch that does not exist yet (unborn). */
  unborn: boolean;
}

export interface IndexEntry {
  path: string;
  oid: Oid;
  mode: string;
  /** 0 for a clean entry; 1/2/3 are the three sides of a conflict. */
  stage: number;
}

/** Derived from one cheap measurement at startup — never from a flag. */
export interface Capabilities {
  objectCount: number;
  looseCount: number;
  refCount: number;
  /** Cheap enough to read every object, so orphans can be found by walking. */
  fullLoad: boolean;
  /** Cheap enough to draw one node per staged path. */
  indexNodes: boolean;
  /** Whether the repo has the commit-graph cache git offers. Hinted, never built. */
  commitGraph: boolean;
  limits: { fullLoad: number; indexNodes: number };
}

/**
 * Filtering — chosen branches, or a search — is off. The server holds one
 * shared `view` and broadcasts every rebuild, so one viewer's question rewrites
 * every other viewer's canvas, and the rule is *the repository is shared, the
 * view is yours* (CLAUDE.md, Known open work). The code stays: flip this once
 * each browser can ask its own question, or behind a flag.
 */
export const QUESTIONS_ENABLED = false;

export type Question =
  | { kind: 'all' }
  | { kind: 'refs'; refs: string[] }
  | { kind: 'search'; text: string; in: 'message' | 'author' | 'path' | 'content' };

/**
 * The one architectural idea. The browser never holds the repository, it holds
 * a view: a question, how much of the answer, what's been opened, and whether
 * the index is part of the answer at all.
 */
export interface View {
  question: Question;
  limit: number;
  expanded: Oid[];
  /** Trees the reader closed. Trees arrive open — a commit you opened is a
   *  promise to show what is in it — so this is the folded ones, not the open
   *  ones, and an empty list means the whole tree is on screen. */
  folded?: Oid[];
  showIndex: boolean;
  /** Orphans are half the lesson, so they are drawn unless asked otherwise. */
  showUnreachable?: boolean;
  /** `--learning`: commits arrive already open. A room watching a demo should
   *  all see the same picture, including whoever opens the page late, without
   *  anyone having to unfold anything. */
  learning?: boolean;
  /** Arrows from an orphaned object to things that are still reachable — a
   *  tree's entries, and a discarded commit's parent. They cross the picture,
   *  so they are asked for rather than assumed. */
  showCrossLinks?: boolean;
}

/** How many states either side keeps. The server holds the history and the
 *  browser holds the tape; sharing the number makes them forget together. */
export const TAPE_CAP = 400;

export const DEFAULT_VIEW: View = {
  question: { kind: 'all' },
  limit: 120,
  expanded: [],
  folded: [],
  showIndex: true,
  showUnreachable: true,
  showCrossLinks: false,
};

export interface Snapshot {
  /** Which state of the repository this is. Two answers to the same state — a
   *  fold, a filter, a wider window — share a number, and are not a step. */
  seq: number;
  time: number;
  repo: string;
  gitDir: string;
  head: Head;
  refs: Ref[];
  objects: Record<Oid, GitObject>;
  commits: Record<Oid, Commit>;
  trees: Record<Oid, TreeEntry[]>;
  tags: Record<Oid, TagObject>;
  index: IndexEntry[];
  /** Set when the index is drawn as a delta instead of one node per path. */
  indexElided?: { shown: number; total: number };
  /** null means orphan detection is off — not that there are none. */
  unreachable: Oid[] | null;
  /** Objects only the index holds: staged, uncommitted, and named by nothing
   *  that is drawn as a graph. Same null meaning as `unreachable`. */
  stagedOnly?: Oid[] | null;
  caps: Capabilities;
  window: {
    commits: Oid[];
    totalCommits: number | null;
    more: boolean;
    refsOutside: number;
  };
  view: View;
  /** What the canvas is not showing, and why. Always shown, out loud. */
  notes: Note[];
}

/**
 * One note, as what to say plus what goes in the sentence — never the sentence
 * itself. A step is read by every viewer, each in their own language, and by a
 * viewer scrubbing back through steps recorded before that language existed:
 * prose in a step would be prose in whatever language the server happened to
 * be in when git moved.
 */
export type NoteId = keyof Strings['notes'];

export interface Note {
  id: NoteId;
  args?: (string | number)[];
}
