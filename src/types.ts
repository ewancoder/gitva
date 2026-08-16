/**
 * The vocabulary. Shared by the server that asks git the questions and the
 * browser that draws the answers, so both halves mean the same thing by
 * "commit", "ref" and "view".
 */

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
  showIndex: boolean;
}

export const DEFAULT_VIEW: View = {
  question: { kind: 'all' },
  limit: 120,
  expanded: [],
  showIndex: true,
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
  caps: Capabilities;
  window: {
    commits: Oid[];
    totalCommits: number | null;
    more: boolean;
    refsOutside: number;
  };
  view: View;
  /** What this picture is not showing, and why. Always shown, out loud. */
  notes: string[];
}
