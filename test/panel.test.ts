/**
 * What the panel says about the thing you clicked. The decisions here are
 * which bytes to show and where they come from — the snapshot already has a
 * ref's contents, an object's has to be fetched — and getting that wrong shows
 * up as an empty panel, which looks like nothing having gone wrong at all.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { bodyText, panelModel, renderPanel } from '../web/panel.js';
import type { SceneNode } from '../src/layout.js';
import { fakeState } from './fixture.js';

const node = (over: Partial<SceneNode> & Pick<SceneNode, 'kind' | 'id'>): SceneNode => ({
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  label: over.id,
  ...over,
});

describe('what to read out', () => {
  const state = fakeState({ objects: { b1: { oid: 'b1', type: 'blob', size: 3 } } });

  it('fetches an object’s bytes, under a heading that fits what it is', () => {
    const headings = (['blob', 'tree', 'commit', 'tag', 'index'] as const).map(
      (kind) => panelModel(state, node({ kind, id: 'x', oid: 'b1' })).body?.heading,
    );
    assert.deepEqual(headings, ['contents', 'entries', 'raw object', 'raw object', 'contents']);
  });

  it('has nothing to fetch for a node that is not an object', () => {
    assert.equal(panelModel(state, node({ kind: 'more', id: 'more' })).body, null);
  });

  it('explains a submodule as the commit it is, in another repository', () => {
    const m = panelModel(state, node({ kind: 'submodule', id: 'c1' }));
    assert.equal(m.title, 'Commit');
    assert.equal(m.body, null);
  });
});

describe('the bytes the snapshot already has', () => {
  it('shows a loose ref as the one line the file holds', () => {
    const s = fakeState({ refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false }] });
    const m = panelModel(s, node({ kind: 'ref', id: 'ref:refs/heads/main' }));
    assert.equal(m.raw, 'aaa\n');
    assert.equal(m.body, null, 'a ref is never fetched — it is not an object');
  });

  it('shows a packed ref as the packed-refs line that replaced its file', () => {
    const s = fakeState({ refs: [{ name: 'refs/tags/v1', oid: 'ttt', objectType: 'tag', packed: true }] });
    assert.equal(panelModel(s, node({ kind: 'ref', id: 'ref:refs/tags/v1' })).raw, 'ttt refs/tags/v1\n');
  });

  it('shows nothing rather than guessing for a ref that has gone', () => {
    assert.equal(panelModel(fakeState(), node({ kind: 'ref', id: 'ref:refs/heads/gone' })).raw, '');
  });

  it('shows HEAD as the pointer to a pointer it is, or the raw sha when detached', () => {
    assert.equal(panelModel(fakeState(), node({ kind: 'head', id: 'HEAD' })).raw, 'ref: refs/heads/main\n');
    const off = fakeState({ head: { oid: 'ccc', detached: true, unborn: false } });
    assert.equal(panelModel(off, node({ kind: 'head', id: 'HEAD' })).raw, 'ccc\n');
  });
});

/**
 * Just enough document to hang elements off. The panel is the one place the
 * client builds DOM out of an answer that arrives later, and "later" is where
 * the bug is: an answer for the thing you clicked before must not land in the
 * panel for the thing you clicked after.
 */
class El {
  className = '';
  textContent = '';
  children: El[] = [];
  constructor(readonly tag: string) {}
  append(...kids: El[]) {
    this.children.push(...kids);
  }
  replaceChildren(...kids: El[]) {
    this.children = kids;
  }
  /** Everything written into this element and its children, in order. */
  get text(): string {
    return [this.textContent, ...this.children.map((c) => c.text)].filter(Boolean).join('\n');
  }
  find(tag: string): El | undefined {
    return this.children.find((c) => c.tag === tag) ?? this.children.flatMap((c) => c.find(tag) ?? []).at(0);
  }
}
globalThis.document = { createElement: (tag: string) => new El(tag) } as unknown as Document;

describe('the panel on screen', () => {
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
          answer: (body) => resolve({ json: async () => body } as Response),
          fail: () => reject(new Error('no')),
        });
      })) as unknown as typeof fetch;
    return asked;
  }

  const blob = (id: string) => node({ kind: 'blob', id, oid: id });
  const state = fakeState({ objects: { b1: { oid: 'b1', type: 'blob', size: 3 } } });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it('says what to do before anything has been clicked', () => {
    const el = new El('aside');
    renderPanel(el as unknown as HTMLElement, null, null);
    assert.match(el.text, /Click anything/);
  });

  it('writes the explanation first and fills the contents in when they arrive', async () => {
    const el = new El('aside');
    const asked = held();
    renderPanel(el as unknown as HTMLElement, state, blob('b1'));
    assert.match(el.text, /A blob is a file's contents/);
    assert.equal(el.find('pre')!.textContent, 'reading…');
    asked[0].answer({ text: 'alpha\n' });
    await settle();
    assert.equal(el.find('pre')!.textContent, 'alpha\n');
  });

  it('drops an answer for the thing that was clicked before', async () => {
    const el = new El('aside');
    const asked = held();
    renderPanel(el as unknown as HTMLElement, state, blob('b1'));
    renderPanel(el as unknown as HTMLElement, state, blob('b2'));
    asked[1].answer({ text: 'the one asked for last\n' });
    asked[0].answer({ text: 'the stale one\n' });
    await settle();
    assert.equal(el.find('pre')!.textContent, 'the one asked for last\n');
  });

  it('owns up when the body could not be read', async () => {
    const el = new El('aside');
    const asked = held();
    renderPanel(el as unknown as HTMLElement, state, blob('b1'));
    asked[0].fail();
    await settle();
    assert.equal(el.find('pre')!.textContent, 'could not read it');
  });

  it('shows a ref’s bytes without asking the server for anything', () => {
    const el = new El('aside');
    globalThis.fetch = (() => assert.fail('a ref is not fetched')) as unknown as typeof fetch;
    const s = fakeState({ refs: [{ name: 'refs/heads/main', oid: 'aaa', objectType: 'commit', packed: false }] });
    renderPanel(el as unknown as HTMLElement, s, node({ kind: 'ref', id: 'ref:refs/heads/main' }));
    assert.match(el.text, /raw content\naaa/);
  });
});

describe('what came back from the server', () => {
  it('lays a tree out the way git cat-file does', () => {
    const text = bodyText({ entries: [{ mode: '100644', type: 'blob', oid: 'abcdefgh12345', name: 'a.txt' }] });
    assert.equal(text, '100644 blob abcdefg\ta.txt');
  });

  it('says how big a binary blob is rather than printing it', () => {
    assert.equal(bodyText({ text: null, size: 4096 }), '4096 bytes, not text.');
  });

  it('prints text as it is, including empty text', () => {
    assert.equal(bodyText({ text: 'alpha\n' }), 'alpha\n');
    assert.equal(bodyText({ text: '', size: 0 }), '');
  });
});
