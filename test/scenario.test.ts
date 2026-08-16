/**
 * The canonical scenario. If this reads clearly to someone who has never seen
 * the tool, the tool works:
 *
 *   git add a.txt b.txt   -> two blobs, two index entries appear
 *   git reset b.txt       -> the index entry goes; the blob survives, unreachable
 *
 * Both halves visible at once.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { measure, open, snapshot, type RepoHandle } from '../src/git.js';
import { describe as describeChange } from '../src/diff.js';
import { explain } from '../src/explain.js';
import { layout } from '../src/layout.js';
import { DEFAULT_VIEW, type Capabilities, type Snapshot } from '../src/types.js';
import { Repo } from './fixture.js';

let repo: Repo;
let handle: RepoHandle;
let caps: Capabilities;
let empty: Snapshot;
let staged: Snapshot;
let reset: Snapshot;
let aBlob: string;
let bBlob: string;

before(async () => {
  repo = new Repo();
  repo.write('start.txt', 'here we go\n');
  repo.git('add', 'start.txt');
  repo.git('commit', '-q', '-m', 'a place to stand');

  handle = await open(repo.dir);
  caps = await measure(handle.repo);
  empty = await snapshot(handle, DEFAULT_VIEW, caps, 1);

  repo.write('a.txt', 'alpha\n');
  repo.write('b.txt', 'beta\n');
  repo.git('add', 'a.txt', 'b.txt');
  aBlob = repo.git('hash-object', 'a.txt');
  bBlob = repo.git('hash-object', 'b.txt');
  staged = await snapshot(handle, DEFAULT_VIEW, await measure(handle.repo), 2);

  repo.git('reset', '-q', 'b.txt');
  reset = await snapshot(handle, DEFAULT_VIEW, await measure(handle.repo), 3);
});
after(() => repo.dispose());

test('git add: two blobs and two index entries appear', () => {
  assert.ok(!(aBlob in empty.objects), 'no blob before staging');
  assert.ok(aBlob in staged.objects);
  assert.ok(bBlob in staged.objects);

  const paths = staged.index.map((e) => e.path).sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt', 'start.txt']);

  assert.match(describeChange(empty, staged), /2 blobs/);
  assert.match(describeChange(empty, staged), /index entries added/);
});

test('git reset: the index entry goes, the blob survives, now unreachable', () => {
  assert.deepEqual(reset.index.map((e) => e.path).sort(), ['a.txt', 'start.txt']);

  assert.ok(bBlob in reset.objects, 'the blob is still in the object database');
  assert.ok(reset.unreachable!.includes(bBlob), 'and is now marked unreachable');
  assert.ok(!reset.unreachable!.includes(aBlob), 'while the staged one is not');

  assert.match(describeChange(staged, reset), /index entr/);
  assert.match(describeChange(staged, reset), /now unreachable/);
});

test('both halves are drawn at once', () => {
  const view = { ...DEFAULT_VIEW, expanded: reset.window.commits };
  const scene = layout(reset, view);
  const byId = new Map(scene.nodes.map((n) => [n.id, n]));

  const bNode = byId.get(bBlob);
  assert.ok(bNode, 'the surviving blob is drawn');
  assert.equal(bNode!.unreachable, true, 'as a ghost, never silently dropped');

  // Staging is not a disappearing act: the blob `git add` wrote is still an
  // object, drawn solid, with the index entry that holds it wired to it.
  const aNode = byId.get(aBlob);
  assert.ok(aNode, 'the staged blob is drawn');
  assert.ok(!aNode!.unreachable, 'solid, not a ghost — the index holds it');
  assert.equal(aNode!.staged, true, 'and marked as held by the index alone');
  assert.match(
    explain(reset, 'blob', aBlob).facts.find(([k]) => k === 'reachable')![1],
    /only through the index/,
  );
  assert.ok(
    scene.edges.some((e) => e.kind === 'stage' && e.from === 'index:0:a.txt' && e.to === aBlob),
    'and the index entry points at it',
  );

  const aEntry = scene.nodes.find((n) => n.kind === 'index' && n.label === 'a.txt');
  const bEntry = scene.nodes.find((n) => n.kind === 'index' && n.label === 'b.txt');
  assert.ok(aEntry, 'a.txt is still staged');
  assert.equal(bEntry, undefined, 'b.txt is not');

  // The index sits apart, to the right of everything it stages.
  const objects = scene.bands.find((b) => b.key === 'objects')!;
  const index = scene.bands.find((b) => b.key === 'index')!;
  assert.ok(index.x > objects.x + objects.w - 1);
});
