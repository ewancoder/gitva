/**
 * The only place that talks to git.
 *
 * Everything gitva knows it learns by running git's own plumbing commands, so
 * anything in here can be typed by hand in the terminal beside the browser.
 * Two rules shape the code:
 *
 *   - asking git a question is cheap, asking it once per object is not, so
 *     prefer one conversation that answers many questions;
 *   - gitva never writes to the repository, so only read commands are allowed
 *     and GIT_OPTIONAL_LOCKS=0 stops git taking a lock to be helpful.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  Capabilities,
  Commit,
  GitObject,
  Head,
  IndexEntry,
  ObjectType,
  Oid,
  Ref,
  Snapshot,
  TagObject,
  TreeEntry,
  View,
} from './types.js';

/** Read-only by construction: nothing else may be spawned. Third mention, deliberately. */
const READ_ONLY = new Set([
  'rev-parse',
  'symbolic-ref',
  'for-each-ref',
  'cat-file',
  'rev-list',
  'log',
  'ls-files',
  'count-objects',
  'diff-index',
]);

export class GitError extends Error {}

function run(repo: string, args: string[], stdin?: string): Promise<Buffer> {
  const cmd = args[0];
  if (!READ_ONLY.has(cmd)) throw new GitError(`refusing to run non-read-only git ${cmd}`);
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', repo, ...args], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new GitError(`git ${args.join(' ')} exited ${code}: ${Buffer.concat(err)}`));
    });
    // A command that does not read stdin may be gone before we finish writing.
    child.stdin.on('error', () => {});
    if (stdin === undefined) child.stdin.end();
    else child.stdin.end(stdin);
  });
}

async function text(repo: string, args: string[], stdin?: string): Promise<string> {
  return (await run(repo, args, stdin)).toString('utf8');
}

/** Same, but a non-zero exit is an answer ("no such ref") rather than a failure. */
async function maybe(repo: string, args: string[]): Promise<string | null> {
  try {
    return (await text(repo, args)).trim();
  } catch {
    return null;
  }
}

const lines = (s: string) => s.split('\n').filter((l) => l.length > 0);
const zsplit = (s: string) => s.split('\0').filter((l) => l.length > 0);

// ---------------------------------------------------------------------------
// One conversation, many answers
// ---------------------------------------------------------------------------

/**
 * `git cat-file --batch` takes a list of oids on stdin and streams back
 *   <oid> SP <type> SP <size> LF <contents> LF
 * for each. One process, one pipe, however many objects.
 */
export function parseBatch(buf: Buffer): Map<Oid, { type: ObjectType; body: Buffer }> {
  const out = new Map<Oid, { type: ObjectType; body: Buffer }>();
  let p = 0;
  while (p < buf.length) {
    const nl = buf.indexOf(10, p);
    if (nl < 0) break;
    const header = buf.toString('utf8', p, nl);
    p = nl + 1;
    const [oid, type, size] = header.split(' ');
    if (type === undefined || type === 'missing') continue;
    const n = Number(size);
    out.set(oid, { type: type as ObjectType, body: buf.subarray(p, p + n) });
    p += n + 1;
  }
  return out;
}

/**
 * A tree, exactly as git hands it over: `<mode> SP <name> NUL <raw sha>`.
 * This is the one format we read directly, because the alternative is one
 * `ls-tree` process per tree and that is the cost that kills the tool.
 */
export function parseTree(body: Buffer, hashLen: number): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let p = 0;
  while (p < body.length) {
    const sp = body.indexOf(32, p);
    const nul = body.indexOf(0, sp);
    if (sp < 0 || nul < 0) break;
    const mode = body.toString('utf8', p, sp);
    const name = body.toString('utf8', sp + 1, nul);
    const oid = body.toString('hex', nul + 1, nul + 1 + hashLen);
    entries.push({ mode, name, oid, type: modeType(mode) });
    p = nul + 1 + hashLen;
  }
  return entries;
}

function modeType(mode: string): ObjectType {
  if (mode === '40000' || mode === '040000') return 'tree';
  if (mode === '160000') return 'commit'; // a submodule: a sha with no object here
  return 'blob';
}

/** A commit body: headers, a blank line, then the message the human wrote. */
export function parseCommit(oid: Oid, body: string): Commit {
  const split = body.indexOf('\n\n');
  const head = split < 0 ? body : body.slice(0, split);
  const message = split < 0 ? '' : body.slice(split + 2);
  const c: Commit = {
    oid,
    tree: '',
    parents: [],
    author: '',
    authorDate: 0,
    committer: '',
    subject: message.split('\n')[0] ?? '',
    message,
  };
  for (const line of head.split('\n')) {
    if (line.startsWith(' ')) continue; // a folded header, e.g. a signature
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'tree') c.tree = value;
    else if (key === 'parent') c.parents.push(value);
    else if (key === 'author') {
      c.author = identName(value);
      c.authorDate = identDate(value);
    } else if (key === 'committer') c.committer = identName(value);
  }
  return c;
}

export function parseTag(oid: Oid, body: string): TagObject {
  const split = body.indexOf('\n\n');
  const head = split < 0 ? body : body.slice(0, split);
  const message = split < 0 ? '' : body.slice(split + 2);
  const t: TagObject = {
    oid,
    target: '',
    targetType: 'commit',
    name: '',
    tagger: '',
    message,
  };
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp);
    const value = line.slice(sp + 1);
    if (key === 'object') t.target = value;
    else if (key === 'type') t.targetType = value as ObjectType;
    else if (key === 'tag') t.name = value;
    else if (key === 'tagger') t.tagger = identName(value);
  }
  return t;
}

/** "A U Thor <a@b.c> 1700000000 +0100" -> the human part, and the timestamp. */
function identName(ident: string): string {
  const gt = ident.lastIndexOf('>');
  return gt < 0 ? ident : ident.slice(0, gt + 1);
}
function identDate(ident: string): number {
  const m = / (\d+) [+-]\d{4}\s*$/.exec(ident);
  return m ? Number(m[1]) * 1000 : 0;
}

// ---------------------------------------------------------------------------
// Measuring the repository, once, cheaply
// ---------------------------------------------------------------------------

/**
 * Capabilities, not modes. `count-objects -v` and a ref count are both cheap;
 * everything the interface offers or declines is derived from them.
 *
 * The limits are set from the *expensive* step — measured, not guessed, because
 * the previous build got one of these wrong by more than an order of magnitude
 * by sizing it from the cheap step.
 *
 * Listing every object is nearly free (`--batch-all-objects --batch-check` on
 * 46,000 objects is a few milliseconds). Reading every *tree* so orphans can be
 * found by traversal is what binds: it costs about 8.5 microseconds per object
 * on a mid-range laptop — 394 ms at 46,000 objects, 17 ms at 2,500. The budget
 * for rebuilding after a change is a tenth of a second, so the limit is there.
 */
export const LIMITS = { fullLoad: 12_000, indexNodes: 400 };

export async function measure(repo: string, gitDir?: string): Promise<Capabilities> {
  const counts = await text(repo, ['count-objects', '-v']);
  const field = (k: string) => {
    const m = new RegExp(`^${k}: (\\d+)$`, 'm').exec(counts);
    return m ? Number(m[1]) : 0;
  };
  const looseCount = field('count');
  const objectCount = looseCount + field('in-pack');
  const refCount = lines(await text(repo, ['for-each-ref', '--format=%(refname)'])).length;
  const indexCount = zsplit(await text(repo, ['ls-files', '-z'])).length;
  const dir = gitDir ?? (await text(repo, ['rev-parse', '--absolute-git-dir'])).trim();
  const commitGraph = await stat(join(dir, 'objects/info/commit-graph')).then(
    () => true,
    () => false,
  );
  return {
    objectCount,
    looseCount,
    refCount,
    fullLoad: objectCount <= LIMITS.fullLoad,
    indexNodes: indexCount <= LIMITS.indexNodes,
    commitGraph,
    limits: { ...LIMITS },
  };
}

// ---------------------------------------------------------------------------
// The cheap question: has anything happened?
// ---------------------------------------------------------------------------

/**
 * A change signal whose cost depends on the number of refs, not the size of
 * the repository. It has to notice three things:
 *
 *   - a ref moving (for-each-ref),
 *   - a bare new object nothing points at yet (count-objects: the very first
 *     plumbing command the tutorial teaches),
 *   - an index rewrite, which is how staging shows up (stat, not a read).
 */
export async function changeSignal(repo: string, gitDir: string): Promise<string> {
  const [refs, head, counts, index] = await Promise.all([
    text(repo, ['for-each-ref', '--format=%(objectname) %(refname)']),
    maybe(repo, ['rev-parse', '--symbolic-full-name', 'HEAD']).then(
      async (r) => `${r} ${await maybe(repo, ['rev-parse', 'HEAD'])}`,
    ),
    text(repo, ['count-objects', '-v']),
    stat(join(gitDir, 'index')).then(
      (s) => `${s.mtimeMs}:${s.size}`,
      () => 'none',
    ),
  ]);
  return createHash('sha1').update(refs).update(head).update(counts).update(index).digest('hex');
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface RepoHandle {
  repo: string;
  gitDir: string;
  name: string;
  hashLen: number;
}

export async function open(cwd: string): Promise<RepoHandle> {
  const gitDir = (await text(cwd, ['rev-parse', '--absolute-git-dir'])).trim();
  const top = (await maybe(cwd, ['rev-parse', '--show-toplevel'])) || gitDir;
  const format = (await maybe(cwd, ['rev-parse', '--show-object-format'])) || 'sha1';
  return { repo: cwd, gitDir, name: basename(top), hashLen: format === 'sha256' ? 32 : 20 };
}

async function readHead(repo: string): Promise<Head> {
  const ref = await maybe(repo, ['symbolic-ref', '-q', 'HEAD']);
  const oid = await maybe(repo, ['rev-parse', '-q', '--verify', 'HEAD']);
  return {
    ref: ref ?? undefined,
    oid: oid ?? undefined,
    detached: ref === null && oid !== null,
    unborn: ref !== null && oid === null,
  };
}

async function readRefs(repo: string, gitDir: string): Promise<Ref[]> {
  const raw = await text(repo, [
    'for-each-ref',
    '--format=%(refname)%09%(objecttype)%09%(objectname)%09%(*objectname)',
  ]);
  return Promise.all(
    lines(raw).map(async (l) => {
      const [name, objectType, oid, target] = l.split('\t');
      // A branch is a file with a sha in it — unless it has been folded away
      // into packed-refs, in which case the file is simply not there.
      const loose = await stat(join(gitDir, name)).then(
        () => true,
        () => false,
      );
      return {
        name,
        objectType: objectType as ObjectType,
        oid,
        target: target || undefined,
        packed: !loose,
      };
    }),
  );
}

export function revListArgs(view: View, limit: number, hasHead: boolean): string[] | null {
  const q = view.question;
  const base = ['rev-list', '--topo-order', `-n${limit}`];
  // `--all` misses a detached HEAD, so name it too — when it resolves at all.
  const everything = hasHead ? ['--all', 'HEAD'] : ['--all'];
  if (q.kind === 'refs') return q.refs.length === 0 ? null : [...base, ...q.refs];
  if (q.kind === 'search') {
    if (q.text.length === 0) return [...base, ...everything];
    if (q.in === 'message') return [...base, `--grep=${q.text}`, ...everything];
    if (q.in === 'author') return [...base, `--author=${q.text}`, ...everything];
    // rev-list refuses the pickaxe; `log --format=%H` takes it and prints the same list.
    if (q.in === 'content')
      return ['log', '--topo-order', `-n${limit}`, '--format=%H', `-S${q.text}`, ...everything];
    return [...base, ...everything, '--', q.text];
  }
  return [...base, ...everything];
}

async function readIndex(repo: string, caps: Capabilities) {
  const raw = zsplit(await text(repo, ['ls-files', '--stage', '-z']));
  const all: IndexEntry[] = raw.map((l) => {
    const tab = l.indexOf('\t');
    const [mode, oid, stage] = l.slice(0, tab).split(' ');
    return { mode, oid, stage: Number(stage), path: l.slice(tab + 1) };
  });
  if (caps.indexNodes || all.length === 0) return { index: all };

  // Above the limit the interesting part of the index is the delta, not the
  // inventory: draw what differs from HEAD and count the rest.
  const changed = new Set(
    zsplit((await maybe(repo, ['diff-index', '--cached', '--name-only', '-z', 'HEAD'])) ?? ''),
  );
  const shown = all.filter((e) => changed.has(e.path) || e.stage !== 0);
  return { index: shown, indexElided: { shown: shown.length, total: all.length } };
}

/** Read the bodies of a set of oids in one conversation, following trees down. */
async function readObjects(
  h: RepoHandle,
  seed: Oid[],
  commits: Record<Oid, Commit>,
  trees: Record<Oid, TreeEntry[]>,
  tags: Record<Oid, TagObject>,
) {
  let wanted = seed.filter((o) => o && !(o in commits) && !(o in trees) && !(o in tags));
  while (wanted.length > 0) {
    const batch = parseBatch(await run(h.repo, ['cat-file', '--batch'], wanted.join('\n') + '\n'));
    const next: Oid[] = [];
    for (const [oid, { type, body }] of batch) {
      if (type === 'commit') {
        commits[oid] = parseCommit(oid, body.toString('utf8'));
        next.push(commits[oid].tree);
      } else if (type === 'tree') {
        const entries = parseTree(body, h.hashLen);
        trees[oid] = entries;
        for (const e of entries) if (e.type === 'tree') next.push(e.oid);
      } else if (type === 'tag') {
        tags[oid] = parseTag(oid, body.toString('utf8'));
        next.push(tags[oid].target);
      }
    }
    wanted = [...new Set(next)].filter(
      (o) => o && !(o in commits) && !(o in trees) && !(o in tags),
    );
  }
}

export async function snapshot(
  h: RepoHandle,
  view: View,
  caps: Capabilities,
  seq: number,
): Promise<Snapshot> {
  const [head, refs, indexRead] = await Promise.all([
    readHead(h.repo),
    readRefs(h.repo, h.gitDir),
    readIndex(h.repo, caps),
  ]);
  const { index, indexElided } = indexRead;

  // The window: one more than asked for, so we know whether there is more.
  const args = revListArgs(view, view.limit + 1, head.oid !== undefined);
  const revs = args ? lines(await text(h.repo, args)) : [];
  const more = revs.length > view.limit;
  const windowCommits = revs.slice(0, view.limit);
  const inWindow = new Set(windowCommits);

  const commits: Record<Oid, Commit> = {};
  const trees: Record<Oid, TreeEntry[]> = {};
  const tags: Record<Oid, TagObject> = {};
  const objects: Record<Oid, GitObject> = {};

  // Commit headers for the window, plus the tag objects the refs point at.
  const tagOids = refs.filter((r) => r.objectType === 'tag').map((r) => r.oid);
  const wanted = [...new Set([...windowCommits, ...tagOids])];
  if (wanted.length > 0) {
    for (const [oid, { type, body }] of parseBatch(
      await run(h.repo, ['cat-file', '--batch'], wanted.join('\n') + '\n'),
    )) {
      if (type === 'commit') commits[oid] = parseCommit(oid, body.toString('utf8'));
      else if (type === 'tag') tags[oid] = parseTag(oid, body.toString('utf8'));
    }
  }

  if (caps.fullLoad) {
    // Small enough to hold whole: every object's header in one conversation,
    // then every commit, tree and tag body in another. Orphans fall out of the
    // traversal for free, which is the lesson made executable.
    const all = lines(
      await text(h.repo, [
        'cat-file',
        '--batch-all-objects',
        '--batch-check=%(objectname) %(objecttype) %(objectsize)',
      ]),
    );
    const structural: Oid[] = [];
    for (const l of all) {
      const [oid, type, size] = l.split(' ');
      objects[oid] = { oid, type: type as ObjectType, size: Number(size) };
      if (type !== 'blob') structural.push(oid);
    }
    await readObjects(h, structural, commits, trees, tags);
  } else {
    // Bounded: only the trees the user has actually opened, plus what the
    // index stages. Nothing here walks the object database.
    const opened = view.expanded
      .filter((o) => o in commits)
      .map((o) => commits[o].tree)
      .filter(Boolean);
    await readObjects(h, opened, commits, trees, tags);
    const known = new Set<Oid>([
      ...Object.keys(commits),
      ...Object.keys(trees),
      ...Object.keys(tags),
      ...Object.values(trees).flatMap((es) => es.map((e) => e.oid)),
      ...index.map((e) => e.oid),
    ]);
    if (known.size > 0) {
      for (const l of lines(
        await text(
          h.repo,
          ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'],
          [...known].join('\n') + '\n',
        ),
      )) {
        const [oid, type, size] = l.split(' ');
        if (!type || type === 'missing') continue;
        objects[oid] = { oid, type: type as ObjectType, size: Number(size) };
      }
    }
  }

  const unreachable = caps.fullLoad
    ? findUnreachable(objects, commits, trees, tags, head, refs, index)
    : null;

  // A ref pointing outside the window is left out and counted, never drawn as
  // an edge to a node that isn't there.
  const refsOutside = refs.filter((r) => !inWindow.has(r.target ?? r.oid)).length;

  return {
    seq,
    time: Date.now(),
    repo: h.name,
    gitDir: h.gitDir,
    head,
    refs,
    objects,
    commits,
    trees,
    tags,
    index: view.showIndex ? index : [],
    indexElided,
    unreachable,
    caps,
    window: {
      commits: windowCommits,
      totalCommits: caps.fullLoad ? countCommits(objects) : null,
      more,
      refsOutside,
    },
    view,
    notes: notesFor(caps, { more, shown: windowCommits.length, refsOutside, view, indexElided }),
  };
}

function countCommits(objects: Record<Oid, GitObject>): number {
  let n = 0;
  for (const o of Object.values(objects)) if (o.type === 'commit') n++;
  return n;
}

/**
 * Reachability, computed rather than asked for: walk out from the roots — HEAD,
 * every ref, every index entry — and anything the walk never reached is an
 * orphan. Faster than the built-in checker, and it is the lesson itself.
 */
export function findUnreachable(
  objects: Record<Oid, GitObject>,
  commits: Record<Oid, Commit>,
  trees: Record<Oid, TreeEntry[]>,
  tags: Record<Oid, TagObject>,
  head: Head,
  refs: Ref[],
  index: IndexEntry[],
): Oid[] {
  const seen = new Set<Oid>();
  const stack: Oid[] = [];
  const push = (o?: Oid) => {
    if (o && !seen.has(o)) {
      seen.add(o);
      stack.push(o);
    }
  };
  push(head.oid);
  for (const r of refs) push(r.oid);
  for (const e of index) push(e.oid);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    const commit = commits[oid];
    if (commit) {
      push(commit.tree);
      for (const p of commit.parents) push(p);
      continue;
    }
    const tag = tags[oid];
    if (tag) {
      push(tag.target);
      continue;
    }
    for (const e of trees[oid] ?? []) push(e.oid);
  }
  return Object.keys(objects).filter((oid) => !seen.has(oid));
}

function notesFor(
  caps: Capabilities,
  ctx: {
    more: boolean;
    shown: number;
    refsOutside: number;
    view: View;
    indexElided?: { shown: number; total: number };
  },
): string[] {
  const notes: string[] = [];
  if (!caps.fullLoad) {
    notes.push(
      `Orphan detection is off: ${caps.objectCount.toLocaleString()} objects, and finding an orphan means reading every one. Everything drawn here is reachable by construction.`,
    );
    notes.push('Trees load only for the commits you open — nothing walks the object database.');
  }
  if (ctx.indexElided) {
    notes.push(
      `Index: showing the ${ctx.indexElided.shown} entries that differ from HEAD, of ${ctx.indexElided.total} staged paths.`,
    );
  }
  if (ctx.more) notes.push(`Showing ${ctx.shown} commits — click "load more history" for the rest.`);
  if (ctx.refsOutside > 0)
    notes.push(`${ctx.refsOutside} refs point outside this window and are left out.`);
  if (!ctx.view.showIndex) notes.push('The index is hidden.');
  if (!caps.commitGraph && caps.objectCount > LIMITS.fullLoad) {
    // Teaching the user about a git internal they didn't know existed is gitva
    // working as designed. Detect it, hint at it, never build it — that would
    // be a write.
    notes.push(
      'This repo has no commit-graph. `git commit-graph write --reachable` would make walking history much faster — gitva will not write it for you.',
    );
  }
  if (caps.looseCount > 0 && caps.objectCount > 5_000)
    notes.push(
      `${caps.looseCount.toLocaleString()} loose objects. \`git gc\` would pack them — gitva will not run it for you.`,
    );
  notes.push('Object contents are fetched when you select something, not shipped every update.');
  return notes;
}

/** A body is for reading one thing. Fetched on selection, never broadcast. */
export async function readBody(h: RepoHandle, oid: Oid): Promise<{
  type: ObjectType;
  size: number;
  text: string | null;
  entries?: TreeEntry[];
}> {
  const batch = parseBatch(await run(h.repo, ['cat-file', '--batch'], oid + '\n'));
  const got = batch.get(oid);
  if (!got) throw new GitError(`no such object ${oid}`);
  if (got.type === 'tree') {
    return { type: 'tree', size: got.body.length, text: null, entries: parseTree(got.body, h.hashLen) };
  }
  const slice = got.body.subarray(0, 64 * 1024);
  const binary = slice.includes(0);
  return {
    type: got.type,
    size: got.body.length,
    text: binary ? null : slice.toString('utf8'),
  };
}
