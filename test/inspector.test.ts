/**
 * What the inspector says about the thing you clicked. The decisions here are
 * which bytes to show and where they come from — the step already has a
 * ref's contents, an object's has to be fetched — and getting that wrong shows
 * up as an empty inspector, which looks like nothing having gone wrong at all.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { bodyText, inspectorModel, renderInspector } from '../web/inspector.js';
import type { Shape } from '../web/layout.js';
import { fakeStep } from './fixture.js';

const shape = (over: Partial<Shape> & Pick<Shape, 'kind' | 'id'>): Shape => ({
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    label: over.id,
    ...over,
});

describe('what to read out', () => {
    const step = fakeStep({ objects: { b1: { oid: 'b1', type: 'blob', size: 3 } } });

    it('fetches the bytes of everything that has some', () => {
        const asked = (['blob', 'tree', 'commit', 'tag', 'index'] as const).map(
            (kind) => inspectorModel(step, shape({ kind, id: 'x', oid: 'b1' })).body?.oid,
        );
        assert.deepEqual(asked, ['b1', 'b1', 'b1', 'b1', 'b1']);
    });

    it('asks for nothing on a submodule index entry — that commit is not in this database', () => {
        // The gitlink is the one index entry whose sha names something this
        // repository does not have, so a fetch could only ever fail.
        const staged = fakeStep({
            index: [{ path: 'sub', oid: 'c9', mode: '160000', stage: 0 }],
        });
        const m = inspectorModel(staged, shape({ kind: 'index', id: 'index:0:sub', oid: 'c9' }));
        assert.equal(m.title, 'Submodule entry');
        assert.equal(m.body, null);
        assert.deepEqual(
            m.facts,
            [
                ['sha', 'c9'],
                ['path', 'sub'],
                ['mode', '160000'],
            ],
            'the title and mode 160000 are what say the sha is a commit\u2019s',
        );
    });

    it('explains a submodule as the commit it is, in another repository', () => {
        const m = inspectorModel(step, shape({ kind: 'submodule', id: 'c1' }));
        assert.equal(m.title, 'Commit');
        assert.equal(m.body, null);
    });
});

describe('the bytes the step already has', () => {
    it('shows a loose ref as the one line the file holds', () => {
        const s = fakeStep({
            refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false }],
        });
        const m = inspectorModel(s, shape({ kind: 'ref', id: 'ref:refs/heads/main' }));
        assert.equal(m.raw, 'aaa\n');
        assert.equal(m.body, null, 'a ref is never fetched — it is not an object');
    });

    it('shows a packed ref as the packed-refs line that replaced its file', () => {
        const s = fakeStep({
            refs: [{ name: 'refs/tags/v1', oid: 'ttt', objectType: 'tag', packed: true }],
        });
        assert.equal(
            inspectorModel(s, shape({ kind: 'ref', id: 'ref:refs/tags/v1' })).raw,
            'ttt refs/tags/v1\n',
        );
    });

    it('shows nothing rather than guessing for a ref that has gone', () => {
        assert.equal(
            inspectorModel(fakeStep(), shape({ kind: 'ref', id: 'ref:refs/heads/gone' })).raw,
            '',
        );
    });

    it('shows HEAD as the pointer to a pointer it is, or the raw sha when detached', () => {
        assert.equal(
            inspectorModel(fakeStep(), shape({ kind: 'head', id: 'HEAD' })).raw,
            'ref: refs/heads/main\n',
        );
        const off = fakeStep({ head: { oid: 'ccc', detached: true, unborn: false } });
        assert.equal(inspectorModel(off, shape({ kind: 'head', id: 'HEAD' })).raw, 'ccc\n');
    });
});

/**
 * Just enough document to hang elements off. The inspector is the one place the
 * client builds DOM out of an answer that arrives later, and "later" is where
 * the bug is: an answer for the thing you clicked before must not land in the
 * inspector for the thing you clicked after.
 */
class El {
    className = '';
    textContent = '';
    dataset: Record<string, string> = {};
    children: El[] = [];
    constructor(readonly tag: string) {}
    append(...kids: El[]) {
        this.children.push(...kids);
    }
    insertBefore(kid: El, before: El | null) {
        const at = before ? this.children.indexOf(before) : this.children.length;
        this.children.splice(at, 0, kid);
    }
    replaceChildren(...kids: El[]) {
        this.children = kids;
    }
    /** Everything written into this element and its children, in order. */
    get text(): string {
        return [this.textContent, ...this.children.map((c) => c.text)].filter(Boolean).join('\n');
    }
    find(tag: string): El | undefined {
        return (
            this.children.find((c) => c.tag === tag) ??
            this.children.flatMap((c) => c.find(tag) ?? []).at(0)
        );
    }
}
globalThis.document = { createElement: (tag: string) => new El(tag) } as unknown as Document;

describe('the inspector on screen', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    /** A server that answers when this test says so, not before. */
    function held() {
        const asked: { oid: string; answer: (body: unknown) => void; fail: () => void }[] = [];
        globalThis.fetch = ((url: string) =>
            new Promise((resolve, reject) => {
                asked.push({
                    oid: new URL(url, 'http://x/').searchParams.get('oid')!,
                    answer: (body) => resolve({ json: () => Promise.resolve(body) }),
                    fail: () => reject(new Error('no')),
                });
            })) as unknown as typeof fetch;
        return asked;
    }

    const blob = (id: string) => shape({ kind: 'blob', id, oid: id });
    const step = fakeStep({ objects: { b1: { oid: 'b1', type: 'blob', size: 3 } } });
    const settle = () => new Promise((r) => setTimeout(r, 0));

    it('says what to do before anything has been clicked', () => {
        const el = new El('aside');
        renderInspector(el as unknown as HTMLElement, null, null);
        assert.match(el.text, /Click anything/);
    });

    it('writes the explanation first and fills the contents in when they arrive', async () => {
        const el = new El('aside');
        const asked = held();
        renderInspector(el as unknown as HTMLElement, step, blob('b1'));
        assert.match(el.text, /A blob is a file's contents/);
        assert.equal(el.find('pre')!.textContent, 'reading…');
        asked[0].answer({ text: 'alpha\n' });
        await settle();
        assert.equal(el.find('pre')!.textContent, 'alpha\n');
    });

    it('leaves the teaching text out when compact is on', () => {
        const el = new El('aside');
        held();
        renderInspector(el as unknown as HTMLElement, step, blob('b1'), true);
        assert.doesNotMatch(el.text, /A blob is a file's contents/);
        assert.match(el.text, /^Blob/, 'the title still says what it is');
        assert.equal(el.find('dl')!.children.length, 4, 'the facts stay');
    });

    it('drops an answer for the thing that was clicked before', async () => {
        const el = new El('aside');
        const asked = held();
        renderInspector(el as unknown as HTMLElement, step, blob('b1'));
        renderInspector(el as unknown as HTMLElement, step, blob('b2'));
        asked[1].answer({ text: 'the one asked for last\n' });
        asked[0].answer({ text: 'the stale one\n' });
        await settle();
        assert.equal(el.find('pre')!.textContent, 'the one asked for last\n');
    });

    it('owns up when the body could not be read', async () => {
        const el = new El('aside');
        const asked = held();
        renderInspector(el as unknown as HTMLElement, step, blob('b1'));
        asked[0].fail();
        await settle();
        assert.equal(el.find('pre')!.textContent, 'could not read it');
        assert.equal(
            el.find('pre')!.className,
            'unreadable danger',
            'a failure reads as a warning',
        );
    });

    it('marks the sha field alone, so a click can hand the key over', () => {
        const el = new El('aside');
        held();
        renderInspector(el as unknown as HTMLElement, step, blob('b1'));
        const fields = el.find('dl')!.children.filter((c) => c.tag === 'dd');
        assert.deepEqual(
            fields.map((c) => [c.textContent, c.className]),
            [
                ['b1', 'sha'],
                ['3 B', ''],
            ],
        );
    });

    it('puts the file it is stored in under the sha, whole path hidden behind it', async () => {
        const el = new El('aside');
        const asked = held();
        renderInspector(el as unknown as HTMLElement, step, blob('b1'));
        asked[0].answer({ text: 'alpha\n', path: 'objects/b1/xyz' });
        await settle();
        const rows = el.find('dl')!.children.map((c) => c.textContent);
        assert.deepEqual(rows, ['sha', 'b1', 'file', 'objects/b1/xyz', 'size', '3 B']);
        const dd = el.find('dl')!.children.find((c) => c.textContent === 'objects/b1/xyz')!;
        // Shown inside .git, copied in full — the sha field's own bargain.
        assert.equal(dd.className, 'sha');
        assert.equal(dd.dataset.copy, '/tmp/fake/.git/objects/b1/xyz');
    });

    it('puts it under an index entry’s sha, not at the end', async () => {
        const el = new El('aside');
        const asked = held();
        const staged = fakeStep({
            index: [{ path: 'a.txt', oid: 'b1', mode: '100644', stage: 0 }],
        });
        renderInspector(
            el as unknown as HTMLElement,
            staged,
            shape({ kind: 'index', id: 'index:0:a.txt', oid: 'b1' }),
        );
        asked[0].answer({ text: 'alpha\n', path: 'objects/b1/xyz' });
        await settle();
        assert.deepEqual(
            el.find('dl')!.children.map((c) => c.textContent),
            ['sha', 'b1', 'file', 'objects/b1/xyz', 'path', 'a.txt', 'mode', '100644'],
        );
    });

    it('draws every sha a commit holds as one you can take, and the root’s words as words', async () => {
        const el = new El('aside');
        const asked = held();
        const c = {
            oid: 'c1',
            tree: 'tree567890',
            parents: ['p123456789', 'p223456789'],
            author: 'A <a@b>',
            authorDate: 1_700_000_000_000,
            committer: 'A <a@b>',
            committerDate: 1_700_000_000_000,
            subject: 's',
            message: 's\n',
        };
        const s = fakeStep({
            commits: { c1: c },
            objects: { c1: { oid: 'c1', type: 'commit', size: 9 } },
        });
        renderInspector(
            el as unknown as HTMLElement,
            s,
            shape({ kind: 'commit', id: 'c1', oid: 'c1' }),
        );
        asked[0].answer({ text: 'tree tree567890\n', path: 'objects/c1/xyz' });
        await settle();
        const rows = el.find('dl')!.children;
        assert.deepEqual(
            rows.filter((r) => r.className === 'sha').map((r) => r.textContent),
            ['c1', 'objects/c1/xyz'],
            'the object\u2019s own sha and where it is kept fill the field',
        );
        // What a commit holds is shown short and copied whole, and its two parents
        // are two chips in one field rather than two fields.
        assert.deepEqual(
            rows
                .filter((r) => r.className === 'shas')
                .map((r) => r.children.map((c) => [c.className, c.textContent, c.dataset.copy])),
            [
                [['sha key', 'tree567', 'tree567890']],
                [
                    ['sha key', 'p123456', 'p123456789'],
                    ['sha key', 'p223456', 'p223456789'],
                ],
            ],
        );
        assert.deepEqual(
            rows
                .filter((r) => r.tag === 'dt')
                .map((r) => r.textContent)
                .slice(0, 4),
            ['sha', 'file', 'tree', 'parents'],
        );
    });

    it('leaves a root commit’s parents as words, because there is no key there', () => {
        const el = new El('aside');
        held();
        const root = {
            oid: 'c1',
            tree: 'tree567890',
            parents: [],
            author: 'A <a@b>',
            authorDate: 1_700_000_000_000,
            committer: 'A <a@b>',
            committerDate: 1_700_000_000_000,
            subject: 's',
            message: 's\n',
        };
        renderInspector(
            el as unknown as HTMLElement,
            fakeStep({ commits: { c1: root } }),
            shape({ kind: 'commit', id: 'c1', oid: 'c1' }),
        );
        const parents = el.find('dl')!.children.find((r) => r.textContent === 'none (root)')!;
        assert.equal(parents.className, '');
    });

    it('hands over an index entry’s sha', () => {
        const el = new El('aside');
        held();
        const staged = fakeStep({
            index: [{ path: 'a.txt', oid: 'b1', mode: '100644', stage: 0 }],
        });
        renderInspector(
            el as unknown as HTMLElement,
            staged,
            shape({ kind: 'index', id: 'index:0:a.txt', oid: 'b1' }),
        );
        const clickable = el
            .find('dl')!
            .children.filter((c) => c.className === 'sha')
            .map((c) => c.textContent);
        assert.deepEqual(clickable, ['b1']);
    });

    it('shows a ref’s bytes without asking the server for anything', () => {
        const el = new El('aside');
        globalThis.fetch = () => assert.fail('a ref is not fetched');
        const s = fakeStep({
            refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false }],
        });
        renderInspector(
            el as unknown as HTMLElement,
            s,
            shape({ kind: 'ref', id: 'ref:refs/heads/main' }),
        );
        assert.match(el.text, /contents\naaa/);
    });
});

describe('what came back from the server', () => {
    it('lays a tree out the way git cat-file does', () => {
        const text = bodyText({
            entries: [{ mode: '100644', type: 'blob', oid: 'abcdefgh12345', name: 'a.txt' }],
        });
        assert.equal(text, '100644 blob abcdefg\ta.txt');
    });

    it('says how big a binary blob is rather than printing it', () => {
        assert.equal(bodyText({ text: null, size: 4096 }), '4096 bytes, not text.');
    });

    it('prints text as it is, including empty text', () => {
        assert.equal(bodyText({ text: 'alpha\n' }), 'alpha\n');
        // A big blob is read to 64 KiB only, and must not look like the whole thing.
        assert.match(
            bodyText({ text: 'alpha', size: 100_000, truncated: true }),
            /first 64 KiB of 100000 bytes/,
        );
        assert.equal(bodyText({ text: '', size: 0 }), '');
    });
});
