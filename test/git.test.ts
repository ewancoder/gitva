import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
    changeSignal,
    measure,
    open,
    parseBatch,
    parseCommit,
    parseTag,
    parseTree,
    objectPath,
    readBody,
    revListArgs,
    readStep,
    type Repository,
} from '../src/git.js';
import type { Capabilities, Step } from '../src/types.js';
import { plumbedRepo, type Repo } from './fixture.js';

describe('parsing what git hands back', () => {
    it('splits a --batch stream into objects', () => {
        const buf = Buffer.concat([
            Buffer.from('aaaa blob 3\nhi\n'),
            Buffer.from('bbbb missing\n'),
            Buffer.from('cccc blob 2\nyo\n'),
        ]);
        const got = parseBatch(buf);
        assert.equal(got.size, 2);
        assert.equal(got.get('aaaa')!.body.toString(), 'hi\n'.slice(0, 3));
        assert.equal(got.get('cccc')!.body.toString(), 'yo');
    });

    it('reads a tree, mode and name and raw sha', () => {
        const sha = Buffer.alloc(20, 0xab);
        const body = Buffer.concat([
            Buffer.from('100644 a.txt\0'),
            sha,
            Buffer.from('40000 lib\0'),
            Buffer.alloc(20, 0xcd),
            Buffer.from('100755 run.sh\0'),
            Buffer.alloc(20, 0xef),
        ]);
        const entries = parseTree(body, 20);
        assert.deepEqual(
            entries.map((e) => [e.mode, e.name, e.type]),
            [
                ['100644', 'a.txt', 'blob'],
                ['40000', 'lib', 'tree'],
                ['100755', 'run.sh', 'blob'],
            ],
        );
        assert.equal(entries[0].oid, 'ab'.repeat(20));
    });

    it('reads a commit, skipping folded headers such as a signature', () => {
        const c = parseCommit(
            'deadbeef',
            [
                'tree 1111',
                'parent 2222',
                'parent 3333',
                'author A U Thor <a@b.c> 1700000000 +0000',
                'committer C O Mitter <c@d.e> 1700000001 +0000',
                'gpgsig -----BEGIN-----',
                ' folded continuation',
                '',
                'subject line',
                '',
                'body',
            ].join('\n'),
        );
        assert.equal(c.tree, '1111');
        assert.deepEqual(c.parents, ['2222', '3333']);
        assert.equal(c.author, 'A U Thor <a@b.c>');
        assert.equal(c.authorDate, 1700000000000);
        assert.equal(c.subject, 'subject line');
    });

    it('reads an annotated tag', () => {
        const t = parseTag(
            'tagoid',
            [
                'object 4444',
                'type commit',
                'tag v1',
                'tagger T <t@t> 1700000000 +0000',
                '',
                'why',
            ].join('\n'),
        );
        assert.equal(t.target, '4444');
        assert.equal(t.name, 'v1');
        assert.equal(t.message, 'why');
    });
});

describe('the one question the server asks for the window', () => {
    it('names HEAD only when HEAD resolves', () => {
        assert.deepEqual(revListArgs(5, true).slice(-2), ['--all', 'HEAD']);
        assert.deepEqual(revListArgs(5, false).slice(-1), ['--all']);
        assert.ok(revListArgs(5, true).includes('-n5'));
    });
});

describe('a repository read through its own plumbing', () => {
    let repo: Repo;
    let handle: Repository;
    let capabilities: Capabilities;
    let step: Step;

    before(async () => {
        repo = plumbedRepo();
        handle = await open(repo.dir);
        capabilities = await measure(handle.repo);
        step = await readStep(handle, capabilities, 1);
    });
    after(() => repo.dispose());

    it('measures the repository and finds it small enough to hold whole', () => {
        assert.equal(capabilities.fullLoad, true);
        assert.equal(capabilities.indexShapes, true);
        assert.ok(capabilities.objectCount > 5);
    });

    it('sees every kind of object', () => {
        const kinds = new Set(Object.values(step.objects).map((o) => o.type));
        assert.deepEqual([...kinds].sort(), ['blob', 'commit', 'tag', 'tree']);
    });

    it('sees HEAD attached to a branch', () => {
        assert.equal(step.head.detached, false);
        assert.equal(step.head.ref, 'refs/heads/main');
        assert.equal(step.head.oid, repo.git('rev-parse', 'HEAD'));
    });

    it('sees the refs, and knows an annotated tag peels', () => {
        const names = step.refs.map((r) => r.name).sort();
        assert.deepEqual(names, ['refs/heads/main', 'refs/heads/side', 'refs/tags/v1']);
        const tag = step.refs.find((r) => r.name === 'refs/tags/v1')!;
        assert.equal(tag.objectType, 'tag');
        assert.equal(tag.target, repo.git('rev-parse', 'refs/tags/v1^{commit}'));
        assert.equal(tag.packed, false); // a real file on disk, until it is packed away
    });

    it('sees the staging index', () => {
        const paths = step.index.map((e) => e.path).sort();
        assert.deepEqual(paths, ['a.txt', 'b.txt', 'd.txt', 'lib/c.txt']);
        assert.ok(step.index.every((e) => e.stage === 0));
    });

    it('finds the deliberate unreachable object by walking out from the roots', () => {
        const unreachableBlob = repo.git('hash-object', 'unreachable.txt');
        assert.ok(step.unreachable);
        assert.ok(
            step.unreachable.includes(unreachableBlob),
            'the unreferenced blob is unreachable',
        );
        assert.ok(!step.unreachable.includes(step.head.oid!), 'HEAD is not');
    });

    // A step is what git did, so it carries everything about the repository
    // whatever any browser happens to be drawing: the toggles are the viewer's,
    // and a step scrubbed back to must answer them all.
    it('carries the index and the unreachable set for every view there could be', () => {
        assert.ok(step.index.length > 0);
        assert.ok(step.unreachable!.length > 0);
        assert.ok(
            !step.notes.includes('indexHidden'),
            'what a viewer hides is not the step’s to say',
        );
    });

    it('holds every tree in the window, so expanding a commit asks nothing of it', () => {
        for (const oid of step.window.commits) {
            assert.ok(
                step.trees[step.commits[oid].tree],
                'the tree of a drawn commit is in the step',
            );
        }
    });

    it('stores one blob for two names, because names live in trees', () => {
        const a = repo.git('hash-object', 'a.txt');
        const root = step.commits[step.head.oid!].tree;
        const lib = step.trees[root].find((e) => e.name === 'lib')!;
        const c = step.trees[lib.oid].find((e) => e.name === 'c.txt')!;
        assert.equal(c.oid, a);
    });

    it('a merge commit has two parents', () => {
        const merge = step.commits[step.head.oid!];
        assert.equal(merge.parents.length, 2);
    });

    it('reads one body on demand, and only when asked', async () => {
        const a = repo.git('hash-object', 'a.txt');
        const body = await readBody(handle, a);
        assert.equal(body.type, 'blob');
        assert.equal(body.text, 'alpha\n');
        const root = await readBody(handle, step.commits[step.head.oid!].tree);
        assert.ok(root.entries!.some((e) => e.name === 'lib'));
    });

    it('says when a large text body is only the first 64 KiB', async () => {
        repo.write('large.txt', 'x'.repeat(64 * 1024 + 1));
        const oid = repo.git('hash-object', '-w', 'large.txt');
        const body = await readBody(handle, oid);
        assert.equal(body.text?.length, 64 * 1024);
        assert.equal(body.size, 64 * 1024 + 1);
        assert.equal(body.truncated, true);
    });

    it('reads a tag object that no ref hands it, and follows what it points at', async () => {
        // An annotated tag whose ref was deleted. The object is still in the
        // database, and the walk out from every object is the only thing that
        // meets it — refs are what usually hand tags over.
        repo.git('tag', '-a', 'v2', '-m', 'a tag that lost its ref', 'HEAD');
        const oid = repo.git('rev-parse', 'refs/tags/v2');
        repo.git('update-ref', '-d', 'refs/tags/v2');
        const s = await readStep(handle, capabilities, 2);
        assert.equal(s.tags[oid].name, 'v2');
        assert.equal(s.tags[oid].target, s.head.oid);
        assert.ok(s.unreachable!.includes(oid), 'nothing points at it any more');
    });

    it('reads a commit no ref names, the way `git reset` leaves one behind', async () => {
        const tree = repo.git('write-tree');
        const dropped = repo.git(
            'commit-tree',
            tree,
            '-p',
            step.head.oid!,
            '-m',
            'a commit thrown away',
        );
        // Never pointed at, so `rev-list --all` will not name it: the walk over
        // every object in the database is the only thing that meets it.
        const s = await readStep(handle, capabilities, 5);
        assert.ok(!s.window.commits.includes(dropped));
        assert.equal(s.commits[dropped].message.trim(), 'a commit thrown away');
        assert.deepEqual(s.commits[dropped].parents, [step.head.oid]);
        assert.ok(s.unreachable!.includes(dropped));
    });

    it('the cheap question moves only when something happened', async () => {
        const before = await changeSignal(handle.repo, handle.gitDir);
        assert.equal(before, await changeSignal(handle.repo, handle.gitDir));
        repo.write('e.txt', 'epsilon\n');
        repo.git('hash-object', '-w', 'e.txt'); // a bare object nothing points at
        assert.notEqual(before, await changeSignal(handle.repo, handle.gitDir));
    });
});

describe('what git has already built for itself', () => {
    it('notices the commit-graph cache, and never builds one', async () => {
        const repo = plumbedRepo();
        try {
            const handle = await open(repo.dir);
            assert.equal((await measure(handle.repo)).commitGraph, false);
            repo.git('commit-graph', 'write', '--reachable');
            assert.equal((await measure(handle.repo)).commitGraph, true);
        } finally {
            repo.dispose();
        }
    });

    it('sees a branch whose file has been folded away into packed-refs', async () => {
        const repo = plumbedRepo();
        try {
            const handle = await open(repo.dir);
            repo.git('pack-refs', '--all');
            const capabilities = await measure(handle.repo);
            const step = await readStep(handle, capabilities, 1);
            assert.ok(step.refs.length > 0);
            assert.ok(
                step.refs.every((r) => r.packed),
                'the files are gone; the shas are in one file instead',
            );
        } finally {
            repo.dispose();
        }
    });
});

describe('degrading the documented way above a limit', () => {
    let repo: Repo;
    let handle: Repository;
    let step: Step;

    before(async () => {
        repo = plumbedRepo();
        handle = await open(repo.dir);
        // Fake the measurement rather than building an enormous repository: this is
        // the same switch the measurement flips.
        const capabilities: Capabilities = {
            objectCount: 9_000_000,
            looseCount: 12,
            refCount: 3,
            fullLoad: false,
            indexShapes: false,
            commitGraph: false,
            limits: { fullLoad: 60_000, indexShapes: 400 },
        };
        step = await readStep(handle, capabilities, 1);
    });
    after(() => repo.dispose());

    it('turns unreachable detection off and says why', () => {
        assert.equal(step.unreachable, null);
        assert.ok(step.notes.includes('noUnreachableDetection'));
    });

    it('draws the index as the delta from HEAD, and counts the rest', () => {
        assert.ok(step.indexElided);
        assert.equal(step.indexElided!.total, 4);
        assert.ok(step.indexElided!.shown < step.indexElided!.total);
        assert.ok(step.notes.includes('indexElided'));
    });

    it('still draws the commits it was asked for', () => {
        assert.ok(step.window.commits.length >= 3);
        assert.equal(step.window.totalCommits, null);
    });

    it('draws the paths that differ from HEAD, and leaves the rest to the count', async () => {
        repo.write('new.txt', 'new\n');
        repo.git('add', 'new.txt');
        const s = await readStep(handle, step.capabilities, 3);
        assert.deepEqual(
            s.index.map((e) => e.path),
            ['new.txt'],
            'only the staged difference is drawn',
        );
        assert.equal(s.indexElided!.total, 5);
    });

    // Even here the step holds the window's trees: there is no route back to the
    // server for a browser that expands a commit, so a step that left them out
    // would leave an expanded commit pointing at nothing.
    it('still reads the trees of the commits in the window', () => {
        assert.ok(Object.keys(step.trees).length > 0);
        for (const oid of step.window.commits) assert.ok(step.trees[step.commits[oid].tree]);
    });

    // The notes toolbar is the interface's promise about what it is not showing,
    // so it is asserted whole. Nothing here says trees load on demand, because
    // they do not any more: the window's trees are in every step — and nothing
    // here advises on the repository, because a note is about the canvas.
    it('says exactly what it is not showing, and nothing that is no longer true', () => {
        assert.deepEqual(step.notes, [
            'noUnreachableDetection',
            'indexElided',
            'bodiesOnSelection',
        ]);
    });
});

/**
 * A key hands you a value, and the value is a file — until git packs it away
 * and the file is gone. Getting this wrong points a viewer at a path that is
 * not there, which teaches the opposite of the lesson.
 */
describe('where git actually keeps an object', () => {
    let repo: Repo;
    let handle: Repository;

    before(async () => {
        repo = plumbedRepo();
        handle = await open(repo.dir);
    });
    after(() => repo.dispose());

    it('names the loose file an object starts life as', async () => {
        const oid = repo.git('hash-object', 'a.txt');
        assert.equal(await objectPath(handle, oid), `objects/${oid.slice(0, 2)}/${oid.slice(2)}`);
    });

    it('names the pack it moves into once the file is gone', async () => {
        const oid = repo.git('rev-parse', 'HEAD');
        repo.git('repack', '-ad');
        assert.match((await objectPath(handle, oid))!, /^objects\/pack\/pack-[0-9a-f]+\.pack$/);
    });

    it('has nothing to say about an object this repository does not hold', async () => {
        assert.equal(await objectPath(handle, 'f'.repeat(40)), null);
    });
});
