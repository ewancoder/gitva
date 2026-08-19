/**
 * The teaching text. It is the product — the graph is only how you get to it —
 * so every kind gitva draws has to have something true to say about itself,
 * and every fact it offers has to come out of the state rather than out of a
 * guess about it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { entryId, explain, explainKind, refName } from '../src/explain.js';
import { fakeState } from './fixture.js';

const fact = (facts: [string, string][], key: string) => facts.find(([k]) => k === key)?.[1];

describe('what each kind is', () => {
  it('has plain language and a command for every kind it draws', () => {
    for (const kind of ['blob', 'tree', 'commit', 'tag', 'ref', 'head', 'index', 'more']) {
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
  const state = fakeState({
    objects: {
      b1: { oid: 'b1', type: 'blob', size: 6 },
      b2: { oid: 'b2', type: 'blob', size: 2048 },
    },
    trees: { t1: [{ mode: '100644', name: 'a.txt', oid: 'b1', type: 'blob' }] },
  });

  it('gives a blob its sha and its size in the units a person reads', () => {
    assert.equal(fact(explain(state, 'blob', 'b1').facts, 'size'), '6 B');
    assert.equal(fact(explain(state, 'blob', 'b2').facts, 'size'), '2.0 KiB');
  });

  it('says nothing about the size of an object the state does not carry', () => {
    const facts = explain(state, 'blob', 'nope').facts;
    assert.deepEqual(facts, [['sha', 'nope']]);
  });

  it('says an unreachable object is still rescuable', () => {
    const s = fakeState({ objects: state.objects, unreachable: ['b1'] });
    assert.match(fact(explain(s, 'blob', 'b1').facts, 'reachable')!, /rescued/);
  });

  it('says a staged-only blob is held up by the index alone', () => {
    const s = fakeState({ objects: state.objects, stagedOnly: ['b1'] });
    assert.match(fact(explain(s, 'blob', 'b1').facts, 'reachable')!, /only through the index/);
  });

  it('counts a tree’s entries, and says nothing when the tree was never read', () => {
    assert.equal(fact(explain(state, 'tree', 't1').facts, 'entries'), '1');
    assert.equal(fact(explain(state, 'tree', 'unread').facts, 'entries'), undefined);
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
    subject: 'a subject',
    message: 'a subject\n\nand a body\n',
  });

  it('names the tree it points at, its parents, and what it says', () => {
    const s = fakeState({ commits: { c1: commit(['p123456789', 'p223456789']) } });
    const facts = explain(s, 'commit', 'c1').facts;
    assert.equal(fact(facts, 'tree'), 'tree567');
    assert.equal(fact(facts, 'parents'), 'p123456, p223456');
    assert.equal(fact(facts, 'message'), 'a subject\n\nand a body');
    assert.ok(fact(facts, 'authored'));
  });

  it('calls a commit with no parents what it is', () => {
    const s = fakeState({ commits: { c1: commit([]) } });
    assert.equal(fact(explain(s, 'commit', 'c1').facts, 'parents'), 'none (root)');
  });

  it('leaves out the date when git gave none', () => {
    const s = fakeState({ commits: { c1: { ...commit([]), authorDate: 0 } } });
    assert.equal(fact(explain(s, 'commit', 'c1').facts, 'authored'), undefined);
  });

  it('says only the sha of a commit outside the window', () => {
    assert.deepEqual(explain(fakeState(), 'commit', 'c9').facts, [['sha', 'c9']]);
  });
});

describe('tags', () => {
  it('reads an annotated tag out: its name, its target and its message', () => {
    const s = fakeState({
      tags: {
        g1: { oid: 'g1', target: 'c123456789', targetType: 'commit', name: 'v1', tagger: 'A <a@b>', message: 'the first release\n' },
      },
    });
    const facts = explain(s, 'tag', 'g1').facts;
    assert.equal(fact(facts, 'tag name'), 'v1');
    assert.equal(fact(facts, 'points at'), 'commit c123456');
    assert.equal(fact(facts, 'message'), 'the first release');
  });

  it('says only the sha of a tag object it has not read', () => {
    assert.deepEqual(explain(fakeState(), 'tag', 'g9').facts, [['sha', 'g9']]);
  });
});

describe('pointers', () => {
  const ref = (packed: boolean, target?: string) =>
    fakeState({ refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed, target }] });

  it('says a branch is a file with a sha in it, and where', () => {
    const e = explain(ref(false), 'ref', 'ref:refs/heads/main');
    assert.match(e.what, /a file with a sha in it/);
    assert.equal(fact(e.facts, 'file'), '/tmp/fake/.git/refs/heads/main');
    assert.equal(fact(e.facts, 'contains'), 'aaa');
    assert.match(fact(e.facts, 'stored')!, /loose/);
  });

  it('says where a packed ref went, and what an annotated tag peels to', () => {
    const e = explain(ref(true, 'ccc'), 'ref', 'ref:refs/heads/main');
    assert.match(fact(e.facts, 'stored')!, /packed-refs/);
    assert.equal(fact(e.facts, 'peels to'), 'ccc');
  });

  it('says nothing about a ref that is not in this state', () => {
    assert.deepEqual(explain(fakeState(), 'ref', 'ref:refs/heads/gone').facts, []);
  });

  it('explains HEAD as a pointer to a pointer', () => {
    const e = explain(fakeState(), 'head', 'HEAD');
    assert.equal(fact(e.facts, 'contains'), 'ref: refs/heads/main');
    assert.equal(fact(e.facts, 'resolves to'), 'a'.repeat(40));
  });

  it('explains what an unborn HEAD is', () => {
    const s = fakeState({ head: { ref: 'refs/heads/main', detached: false, unborn: true } });
    assert.match(fact(explain(s, 'head', 'HEAD').facts, 'contains')!, /does not exist yet/);
  });

  it('explains a detached HEAD as the raw sha it is', () => {
    const s = fakeState({ head: { oid: 'ccc', detached: true, unborn: false } });
    assert.match(fact(explain(s, 'head', 'HEAD').facts, 'contains')!, /ccc — detached/);
  });
});

describe('the index', () => {
  const s = fakeState({
    index: [
      { path: 'a.txt', oid: 'b1', mode: '100644', stage: 0 },
      { path: 'c.txt', oid: 'b2', mode: '100644', stage: 2 },
    ],
  });

  it('names the path, the blob and the mode of a staged entry', () => {
    const facts = explain(s, 'index', entryId('a.txt', 0)).facts;
    assert.deepEqual(
      facts.map(([k]) => k),
      ['path', 'blob', 'mode'],
    );
    assert.equal(fact(facts, 'blob'), 'b1');
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
