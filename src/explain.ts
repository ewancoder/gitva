/**
 * The teaching. Point at anything and learn what that file in .git actually
 * does, and which command creates it. Pure, so it can be tested without a
 * browser — and so the wording is somewhere a person can fix it.
 */

import type { Snapshot } from './types.js';

export interface Explanation {
  title: string;
  what: string;
  made: string;
  facts: [string, string][];
}

const KIND: Record<string, { title: string; what: string; made: string }> = {
  blob: {
    title: 'Blob',
    what: "A blob is a file's contents and nothing else — no name, no path, no date, no permissions. Two files with identical contents anywhere in history are the same blob, stored once. The name you know the file by lives in the tree that points here.",
    made: 'git hash-object -w <file>',
  },
  tree: {
    title: 'Tree',
    what: 'A tree is one directory: a sorted list of names, each with a mode and the sha of what it holds — a blob for a file, another tree for a subdirectory. Names live in trees. This is the whole of how git stores a directory.',
    made: 'git write-tree  (from the index)',
  },
  commit: {
    title: 'Commit',
    what: 'A commit is a tiny text object: the sha of one tree — the entire project at that moment — plus the shas of its parents, an author, a committer and a message. It stores no diff. The diff is something git works out on demand by comparing two trees.',
    made: 'git commit-tree <tree> -p <parent>',
  },
  tag: {
    title: 'Annotated tag',
    what: 'An annotated tag is a real object: a name, a tagger, a message, and the sha of what it points at. That is nearly a pointer with a story attached, which is why it sits with the pointers here rather than with the objects.',
    made: 'git mktag  /  git tag -a <name>',
  },
  ref: {
    title: 'Ref',
    what: 'A ref is a file with a sha in it. That is the entire mechanism. A branch is a ref under refs/heads that gets rewritten every time you commit; a lightweight tag is a ref under refs/tags that does not. Nothing about a branch is a first-class object.',
    made: 'git update-ref refs/heads/<name> <sha>',
  },
  head: {
    title: 'HEAD',
    what: 'HEAD is a file holding the text "ref: refs/heads/<branch>" — a pointer to a pointer. That indirection is what makes committing move the branch. Detach it and HEAD holds a raw sha instead, which is why commits made there are so easy to lose.',
    made: 'git symbolic-ref HEAD refs/heads/<name>',
  },
  index: {
    title: 'Index entry',
    what: 'The index is a single binary file listing the paths that will go into the next commit, each with a blob sha and a mode. It is the only place a half-staged change exists: not in the working tree, not in any object. Staging writes here; committing turns it into a tree.',
    made: 'git update-index --add <path>',
  },
  more: {
    title: 'Load more history',
    what: 'These commits have parents that are real, but outside the window gitva asked for. The arrow is drawn honestly into here rather than pointing at a node that is not on screen. Click this block to load the rest of the history.',
    made: 'git rev-list -n <more>',
  },
};

export function explainKind(kind: string): { title: string; what: string; made: string } {
  return (
    KIND[kind] ?? { title: kind, what: 'No explanation written for this yet.', made: '' }
  );
}

const short = (oid: string) => oid.slice(0, 7);
const bytes = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KiB`);

/** Everything the panel says about one selected node. */
export function explain(snap: Snapshot, kind: string, id: string): Explanation {
  const base = explainKind(kind);
  const facts: [string, string][] = [];

  if (kind === 'commit' || kind === 'tree' || kind === 'blob' || kind === 'tag') {
    const obj = snap.objects[id];
    facts.push(['sha', id]);
    if (obj) facts.push(['size', bytes(obj.size)]);
    if (snap.unreachable?.includes(id)) {
      facts.push([
        'reachable',
        'no — nothing points here. It is still in the object database and can be rescued by name until git gc removes it.',
      ]);
    }
  }

  if (kind === 'commit') {
    const c = snap.commits[id];
    if (c) {
      facts.push(['tree', short(c.tree)]);
      facts.push(['parents', c.parents.length ? c.parents.map(short).join(', ') : 'none (root)']);
      facts.push(['author', c.author]);
      if (c.authorDate) facts.push(['authored', new Date(c.authorDate).toLocaleString()]);
      facts.push(['message', c.message.trim()]);
    }
  } else if (kind === 'tree') {
    const entries = snap.trees[id];
    if (entries) facts.push(['entries', String(entries.length)]);
  } else if (kind === 'tag') {
    const t = snap.tags[id];
    if (t) {
      facts.push(['tag name', t.name]);
      facts.push(['points at', `${t.targetType} ${short(t.target)}`]);
      facts.push(['tagger', t.tagger]);
      facts.push(['message', t.message.trim()]);
    }
  } else if (kind === 'ref') {
    const r = snap.refs.find((x) => x.name === refName(id));
    if (r) {
      // The chip in the gutter can only ever show a shortened name, so the
      // full one has to live here.
      facts.push(['name', r.name]);
      facts.push(['file', `${snap.gitDir}/${r.name}`]);
      facts.push(['contains', r.oid]);
      if (r.target) facts.push(['peels to', r.target]);
      facts.push([
        'stored',
        r.packed
          ? 'packed — folded into .git/packed-refs, so the file itself is gone'
          : 'loose — a real file on disk',
      ]);
    }
  } else if (kind === 'head') {
    facts.push(['file', `${snap.gitDir}/HEAD`]);
    if (snap.head.unborn) {
      facts.push([
        'contains',
        `ref: ${snap.head.ref} — which does not exist yet. An unborn branch: HEAD names a file that will appear on the first commit.`,
      ]);
    } else if (snap.head.detached) {
      facts.push(['contains', `${snap.head.oid} — detached, a raw sha with no branch in between`]);
    } else {
      facts.push(['contains', `ref: ${snap.head.ref}`]);
      facts.push(['resolves to', snap.head.oid ?? '']);
    }
  } else if (kind === 'index') {
    const e = snap.index.find((x) => entryId(x.path, x.stage) === id);
    if (e) {
      facts.push(['path', e.path]);
      facts.push(['blob', e.oid]);
      facts.push(['mode', e.mode]);
      if (e.stage !== 0) {
        facts.push([
          'stage',
          `${e.stage} — a conflict entry (1 = common ancestor, 2 = ours, 3 = theirs). Resolving writes one clean stage-0 entry in their place.`,
        ]);
      }
    }
  }

  return { ...base, facts };
}

export const entryId = (path: string, stage: number) => `index:${stage}:${path}`;

/** Scene nodes for refs are keyed `ref:<full name>`; the lookups want the name. */
export const refName = (id: string) => id.replace(/^ref:/, '');

/** One line for the header: what just changed. */
export function describeChange(counts: {
  added: number;
  removed: number;
  moved: number;
}): string {
  const parts: string[] = [];
  if (counts.added) parts.push(`+${counts.added}`);
  if (counts.removed) parts.push(`-${counts.removed}`);
  if (counts.moved) parts.push(`${counts.moved} moved`);
  return parts.length ? parts.join('  ') : 'no change';
}
