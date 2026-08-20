/**
 * Real fixture repositories, built with real plumbing commands.
 *
 * Isolated from the recording gitva keeps in the user's own state directory as
 * well: a test that started a server would otherwise write into it, and load
 * back whatever an earlier run left there.
 *
 * Isolated from the author's global config — which signs commits and tags — by
 * pointing GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at nothing. Scoped to the
 * throwaway repo; global is never the answer.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_VIEW, type Snapshot } from '../src/types.js';

// Every test process gets its own, and takes it away again.
process.env.GITVA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'gitva-state-'));
process.on('exit', () => rmSync(process.env.GITVA_STATE_DIR!, { recursive: true, force: true }));

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_DATE: '1700000000 +0000',
};

export class Repo {
  readonly dir: string;
  constructor() {
    this.dir = mkdtempSync(join(tmpdir(), 'gitva-fixture-'));
    this.git('init', '-q', '-b', 'main');
    this.git('config', 'commit.gpgsign', 'false');
    this.git('config', 'tag.gpgsign', 'false');
  }

  git(...args: string[]): string {
    return execFileSync('git', ['-C', this.dir, ...args], { env: ENV, encoding: 'utf8' }).trim();
  }

  write(name: string, contents: string) {
    writeFileSync(join(this.dir, name), contents);
  }

  dispose() {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/**
 * A repo built the way the tutorial teaches it: hash an object, update the
 * index, write a tree, commit — plus a branch, a merge, an annotated tag, and
 * a deliberate orphan that nothing points at.
 */
export function plumbedRepo(): Repo {
  const r = new Repo();
  r.write('a.txt', 'alpha\n');
  r.write('b.txt', 'beta\n');
  r.git('hash-object', '-w', 'a.txt');
  r.git('hash-object', '-w', 'b.txt');
  r.git('update-index', '--add', 'a.txt', 'b.txt');
  const tree = r.git('write-tree');
  const first = r.git('commit-tree', tree, '-m', 'the first commit');
  r.git('update-ref', 'refs/heads/main', first);

  // A directory, so there is a tree inside a tree.
  mkdirSync(join(r.dir, 'lib'), { recursive: true });
  r.write('lib/c.txt', 'alpha\n'); // same contents as a.txt: one blob, two names
  r.git('add', 'lib/c.txt');
  const tree2 = r.git('write-tree');
  const second = r.git('commit-tree', tree2, '-p', first, '-m', 'a nested tree');
  r.git('update-ref', 'refs/heads/main', second);

  // A side branch and a merge, so the lanes have something to do.
  r.write('d.txt', 'delta\n');
  r.git('update-index', '--add', 'd.txt');
  const sideTree = r.git('write-tree');
  const side = r.git('commit-tree', sideTree, '-p', first, '-m', 'a side branch');
  r.git('update-ref', 'refs/heads/side', side);
  const mergeTree = r.git('write-tree');
  const merge = r.git('commit-tree', mergeTree, '-p', second, '-p', side, '-m', 'a merge');
  r.git('update-ref', 'refs/heads/main', merge);
  r.git('symbolic-ref', 'HEAD', 'refs/heads/main');
  r.git('read-tree', mergeTree);

  r.git('tag', '-a', 'v1', '-m', 'the first release', merge);

  // The orphan: a blob written into the object database and never referenced.
  r.write('orphan.txt', 'nobody points at me\n');
  r.git('hash-object', '-w', 'orphan.txt');

  return r;
}

/**
 * An empty but valid state, for the tests that are about what gitva *says*
 * rather than about what git did — the panel, the counts, the explanations.
 * Fill in only the part being asked about.
 */
export function fakeState(extra: Partial<Snapshot> = {}): Snapshot {
  return {
    seq: 1,
    time: 0,
    repo: 'fake',
    gitDir: '/tmp/fake/.git',
    head: { ref: 'refs/heads/main', oid: 'a'.repeat(40), detached: false, unborn: false },
    refs: [],
    objects: {},
    commits: {},
    trees: {},
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
    window: { commits: [], totalCommits: 0, more: false, refsOutside: 0 },
    view: DEFAULT_VIEW,
    notes: [],
    ...extra,
  };
}
