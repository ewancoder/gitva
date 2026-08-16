/**
 * Real fixture repositories, built with real plumbing commands.
 *
 * Isolated from the author's global config — which signs commits and tags — by
 * pointing GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at nothing. Scoped to the
 * throwaway repo; global is never the answer.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    try {
      rmSync(this.dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
    } catch {
      // Windows can keep a handle on .git after the last git process has
      // exited; the OS collects the temp dir. Failing the suite over that
      // teaches nothing about git.
    }
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
