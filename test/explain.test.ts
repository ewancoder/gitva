/**
 * The teaching text. It is the product — the canvas is only how you get to it —
 * so every kind gitva draws has to have something true to say about itself,
 * and every fact it offers has to come out of the step rather than out of a
 * guess about it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entryId, explain, explainKind, refName, type Fact } from '../web/explain.js';
import { fakeStep } from './fixture.js';

/** What a field says. A field holding keys says the short forms it shows. */
const fact = (facts: Fact[], key: string) => {
    const v = facts.find(([k]) => k === key)?.[1];
    if (typeof v === 'string' || v === undefined) return v;
    return Array.isArray(v) ? v.map((k) => k.short).join(' ') : v.short;
};

describe('what each kind is', () => {
    it('has plain language and a command for every kind it draws', () => {
        for (const kind of ['blob', 'tree', 'commit', 'tag', 'ref', 'head', 'index']) {
            const e = explainKind(kind);
            assert.ok(e.what.length > 40, `${kind} is explained`);
            assert.ok(e.made.length > 0, `${kind} names the command that makes it`);
        }
    });

    it('admits it when something has no explanation written yet', () => {
        const e = explainKind('sausage');
        assert.equal(e.title, 'sausage');
        assert.match(e.what, /No explanation/);
    });
});

describe('objects', () => {
    const step = fakeStep({
        objects: {
            b1: { oid: 'b1', type: 'blob', size: 6 },
            b2: { oid: 'b2', type: 'blob', size: 2048 },
        },
        trees: { t1: [{ mode: '100644', name: 'a.txt', oid: 'b1', type: 'blob' }] },
    });

    it('gives a blob its sha and its size in the units you read', () => {
        assert.equal(fact(explain(step, 'blob', 'b1').facts, 'size'), '6 B');
        assert.equal(fact(explain(step, 'blob', 'b2').facts, 'size'), '2.0 KiB');
    });

    it('takes an object’s mode off the entries that name it, however many that is', () => {
        assert.equal(fact(explain(step, 'blob', 'b1').facts, 'mode'), '100644');
        // The same blob under two entries has two modes, because the mode was
        // never the blob's.
        const both = fakeStep({
            objects: step.objects,
            trees: {
                t1: [{ mode: '100644', name: 'a.txt', oid: 'b1', type: 'blob' }],
                t2: [{ mode: '100755', name: 'run.sh', oid: 'b1', type: 'blob' }],
            },
        });
        assert.equal(fact(explain(both, 'blob', 'b1').facts, 'mode'), '100644, 100755');
        // Staged and in no tree yet: the index is the only entry there is.
        const staged = fakeStep({
            objects: step.objects,
            index: [{ path: 'a.txt', oid: 'b1', mode: '100644', stage: 0 }],
        });
        assert.equal(fact(explain(staged, 'blob', 'b1').facts, 'mode'), '100644');
    });

    it('gives a subtree and a submodule the mode of the entry that names it', () => {
        const s = fakeStep({
            objects: { t2: { oid: 't2', type: 'tree', size: 30 } },
            trees: {
                t1: [
                    { mode: '40000', name: 'lib', oid: 't2', type: 'tree' },
                    { mode: '160000', name: 'vendor', oid: 'c9', type: 'commit' },
                ],
            },
        });
        assert.equal(fact(explain(s, 'tree', 't2').facts, 'mode'), '40000');
        assert.equal(fact(explain(s, 'commit', 'c9').facts, 'mode'), '160000');
    });

    it('says nothing about the size of an object the step does not carry', () => {
        const facts = explain(step, 'blob', 'nope').facts;
        assert.deepEqual(facts, [['sha', 'nope']]);
    });

    it('says an unreachable object is still rescuable', () => {
        const s = fakeStep({ objects: step.objects, unreachable: ['b1'] });
        assert.match(fact(explain(s, 'blob', 'b1').facts, 'reachable')!, /rescued/);
    });

    it('says a staged-only blob is held up by the index alone', () => {
        const s = fakeStep({ objects: step.objects, stagedOnly: ['b1'] });
        assert.match(fact(explain(s, 'blob', 'b1').facts, 'reachable')!, /only through the index/);
    });

    it('counts a tree’s entries, and says nothing when the tree was never read', () => {
        assert.equal(fact(explain(step, 'tree', 't1').facts, 'entries'), '1');
        assert.equal(fact(explain(step, 'tree', 'unread').facts, 'entries'), undefined);
    });
});

describe('commits', () => {
    const commit = (parents: string[]) => ({
        oid: 'c1',
        tree: 'tree567890',
        parents,
        author: 'A <a@b>',
        authorDate: 1_700_000_000_000,
        committer: 'A <a@b>',
        committerDate: 1_700_000_000_000,
        subject: 'a subject',
        message: 'a subject\n\nand a body\n',
    });

    it('keeps the committer to itself while it is the author', () => {
        const facts = explain(fakeStep({ commits: { c1: commit([]) } }), 'commit', 'c1').facts;
        assert.equal(fact(facts, 'committer'), undefined);
        assert.equal(fact(facts, 'committed'), undefined);
    });

    it('says nothing about a committer date a step never carried', () => {
        const old = { ...commit([]), committerDate: 0 };
        const facts = explain(fakeStep({ commits: { c1: old } }), 'commit', 'c1').facts;
        assert.equal(fact(facts, 'committer'), undefined);
    });

    it('shows the committer once a rebase or an amend has made it someone else', () => {
        const rebased = { ...commit([]), committer: 'B <b@c>', committerDate: 1_700_000_009_000 };
        const facts = explain(fakeStep({ commits: { c1: rebased } }), 'commit', 'c1').facts;
        assert.deepEqual(
            facts.map(([k]) => k),
            ['sha', 'tree', 'parents', 'author', 'authored', 'committer', 'committed'],
        );
        assert.equal(fact(facts, 'committer'), 'B <b@c>');
    });

    it('shows it for the same person at a different moment, which is what an amend is', () => {
        const amended = { ...commit([]), committerDate: 1_700_000_009_000 };
        const facts = explain(fakeStep({ commits: { c1: amended } }), 'commit', 'c1').facts;
        assert.equal(fact(facts, 'committer'), 'A <a@b>');
        assert.ok(fact(facts, 'committed'));
    });

    it('names the tree it points at and its parents, and leaves the message to the bytes', () => {
        const s = fakeStep({ commits: { c1: commit(['p123456789', 'p223456789']) } });
        const facts = explain(s, 'commit', 'c1').facts;
        assert.equal(fact(facts, 'tree'), 'tree567');
        // One row per parent, as the commit's own bytes have one `parent` line
        // each — showing a short sha, handing over the whole of it.
        assert.deepEqual(facts.find(([k]) => k === 'parents')![1], [
            { short: 'p123456', full: 'p123456789' },
            { short: 'p223456', full: 'p223456789' },
        ]);
        // The shas it holds sit with its own, ahead of everything that is not one.
        assert.deepEqual(facts.map(([k]) => k).slice(0, 3), ['sha', 'tree', 'parents']);
        assert.ok(fact(facts, 'authored'));
        // The message is read out under `contents`, where it can be as long as it
        // likes — a field is for what is short enough to sit beside a label.
        assert.equal(fact(facts, 'message'), undefined);
    });

    it('calls a commit with no parents what it is', () => {
        const s = fakeStep({ commits: { c1: commit([]) } });
        assert.equal(fact(explain(s, 'commit', 'c1').facts, 'parents'), 'none (root)');
    });

    it('leaves out the date when git gave none', () => {
        const s = fakeStep({ commits: { c1: { ...commit([]), authorDate: 0 } } });
        assert.equal(fact(explain(s, 'commit', 'c1').facts, 'authored'), undefined);
    });

    it('says only the sha of a commit outside the window', () => {
        assert.deepEqual(explain(fakeStep(), 'commit', 'c9').facts, [['sha', 'c9']]);
    });
});

describe('tags', () => {
    it('reads an annotated tag out: its name, its target and who tagged it', () => {
        const s = fakeStep({
            tags: {
                g1: {
                    oid: 'g1',
                    target: 'c123456789',
                    targetType: 'commit',
                    name: 'v1',
                    tagger: 'A <a@b>',
                    message: 'the first release\n',
                },
            },
        });
        const facts = explain(s, 'tag', 'g1').facts;
        assert.equal(fact(facts, 'tag name'), 'v1');
        // It says the kind and the short sha; it hands over the sha alone.
        assert.deepEqual(facts.find(([k]) => k === 'points at')![1], {
            short: 'commit c123456',
            full: 'c123456789',
        });
        // The message is in the bytes under `contents`, not in a field.
        assert.equal(fact(facts, 'message'), undefined);
    });

    it('looks a tag up by its sha, not by the key the scene gave the chip', () => {
        const s = fakeStep({
            objects: { g1: { oid: 'g1', type: 'tag', size: 7 } },
            tags: {
                g1: {
                    oid: 'g1',
                    target: 'c123456789',
                    targetType: 'commit',
                    name: 'v1',
                    tagger: 'A <a@b>',
                    message: 'the first release\n',
                },
            },
        });
        // The chip is keyed `tag:<oid>` so it cannot collide with the ref of the
        // same name; what is shown is the sha you can hand to cat-file.
        const facts = explain(s, 'tag', 'tag:g1').facts;
        assert.equal(fact(facts, 'sha'), 'g1');
        assert.equal(fact(facts, 'size'), '7 B');
        assert.equal(fact(facts, 'tag name'), 'v1');
    });

    it('says only the sha of a tag object it has not read', () => {
        assert.deepEqual(explain(fakeStep(), 'tag', 'g9').facts, [['sha', 'g9']]);
    });
});

describe('pointers', () => {
    const ref = (packed: boolean, target?: string) =>
        fakeStep({
            refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed, target }],
        });

    it('says a branch is a file with a sha in it, and where', () => {
        const e = explain(ref(false), 'ref', 'ref:refs/heads/main');
        assert.match(e.what, /a file with a sha in it/);
        // Shown inside .git — the part you can type — and copied whole.
        assert.deepEqual(e.facts.find(([k]) => k === 'file')![1], {
            short: 'refs/heads/main',
            full: '/tmp/fake/.git/refs/heads/main',
        });
        assert.match(fact(e.facts, 'stored')!, /loose/);
        // The name is the part you type, the file is the whole of it, and what it
        // contains is the file — read out under `contents`, not said twice.
        assert.equal(fact(e.facts, 'name'), 'main');
        assert.equal(fact(e.facts, 'contains'), undefined);
        assert.deepEqual(
            e.facts.map(([k]) => k),
            ['file', 'name', 'stored'],
        );
    });

    it('says where a packed ref went, and where an annotated tag ends up', () => {
        const e = explain(ref(true, 'ccc'), 'ref', 'ref:refs/heads/main');
        assert.match(fact(e.facts, 'stored')!, /packed-refs/);
        // The same hop HEAD makes, said the same way, and taken whole on a click.
        assert.deepEqual(e.facts.find(([k]) => k === 'resolves to')![1], {
            short: 'ccc',
            full: 'ccc',
        });
        // A packed ref has no file of its own, so it offers no path to open — and
        // the fields you can take from sit together, ahead of the rest.
        assert.equal(fact(e.facts, 'file'), undefined);
        assert.deepEqual(
            e.facts.map(([k]) => k),
            ['resolves to', 'name', 'stored'],
        );
    });

    it('says nothing about a ref that is not in this step', () => {
        assert.deepEqual(explain(fakeStep(), 'ref', 'ref:refs/heads/gone').facts, []);
    });

    it('says where HEAD ends up, which is the hop its own file does not hold', () => {
        const e = explain(fakeStep(), 'head', 'HEAD');
        // Taken whole on a click, like every other sha.
        assert.deepEqual(e.facts.find(([k]) => k === 'resolves to')![1], {
            short: 'a'.repeat(40),
            full: 'a'.repeat(40),
        });
        // What the file holds is the file, read out under `contents`.
        assert.deepEqual(
            e.facts.map(([k]) => k),
            ['file', 'resolves to'],
        );
    });

    it('has no hop to show for an unborn HEAD: the branch it names has no sha', () => {
        const s = fakeStep({ head: { ref: 'refs/heads/main', detached: false, unborn: true } });
        assert.equal(fact(explain(s, 'head', 'HEAD').facts, 'resolves to'), undefined);
    });

    it('has none for a detached HEAD either — the sha is the file', () => {
        const s = fakeStep({ head: { oid: 'ccc', detached: true, unborn: false } });
        assert.equal(fact(explain(s, 'head', 'HEAD').facts, 'resolves to'), undefined);
    });
});

describe('the index', () => {
    const s = fakeStep({
        index: [
            { path: 'a.txt', oid: 'b1', mode: '100644', stage: 0 },
            { path: 'c.txt', oid: 'b2', mode: '100644', stage: 2 },
        ],
    });

    it('names the sha, the path and the mode of a staged entry', () => {
        const facts = explain(s, 'index', entryId('a.txt', 0)).facts;
        assert.deepEqual(
            facts.map(([k]) => k),
            ['sha', 'path', 'mode'],
        );
        assert.equal(fact(facts, 'sha'), 'b1');
    });

    it('explains the three sides of a conflict', () => {
        assert.match(fact(explain(s, 'index', entryId('c.txt', 2)).facts, 'stage')!, /ours/);
    });

    it('says nothing about an entry that has gone', () => {
        assert.deepEqual(explain(s, 'index', entryId('gone.txt', 0)).facts, []);
    });
});

it('scene ids for refs carry a prefix the lookups do not want', () => {
    assert.equal(refName('ref:refs/heads/main'), 'refs/heads/main');
    assert.equal(refName('refs/heads/main'), 'refs/heads/main');
    assert.equal(entryId('a.txt', 3), 'index:3:a.txt');
});
