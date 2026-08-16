import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { sanitise, serve, type Server } from '../src/server.js';
import { plumbedRepo, type Repo } from './fixture.js';

describe('the view arriving from the browser', () => {
  it('falls back to everything when it makes no sense', () => {
    assert.deepEqual(sanitise({ question: { kind: 'nonsense' } }).question, { kind: 'all' });
    assert.equal(sanitise(null).limit, 120);
  });
  it('refuses a ref name that is not one', () => {
    assert.deepEqual(sanitise({ question: { kind: 'refs', refs: ['refs/heads/ok', '; rm -rf /'] } }).question, {
      kind: 'refs',
      refs: ['refs/heads/ok'],
    });
  });
  it('refuses an oid that is not one, and clamps the window', () => {
    assert.deepEqual(sanitise({ expanded: ['abc123', 'not an oid'] }).expanded, ['abc123']);
    assert.equal(sanitise({ limit: 1e9 }).limit, 20_000);
    assert.equal(sanitise({ limit: -4 }).limit, 1);
  });
});

describe('the server', () => {
  let repo: Repo;
  let server: Server;
  let base: string;

  before(async () => {
    repo = plumbedRepo();
    server = await serve(repo.dir, 0);
    base = `http://127.0.0.1:${server.port}/`;
  });
  after(async () => {
    await server.close();
    repo.dispose();
  });

  it('serves the page', async () => {
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /<canvas id="graph">/);
  });

  it('refuses anything outside the two static roots', async () => {
    assert.equal((await fetch(base + 'etc/passwd')).status, 404);
    assert.equal((await fetch(base + '../package.json')).status, 404);
  });

  it('pushes a whole state down the stream', async () => {
    const res = await fetch(base + 'events');
    const reader = res.body!.getReader();
    let buf = '';
    while (!buf.includes('\n\n') || !buf.includes('event: snapshot')) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
    }
    const line = buf.split('\n').find((l) => l.startsWith('data: '))!;
    const snap = JSON.parse(line.slice(6));
    assert.equal(snap.repo, repo.dir.split('/').pop());
    assert.ok(snap.window.commits.length >= 3);
    await reader.cancel();
  });

  it('reads one body only when asked, and checks the oid first', async () => {
    const a = repo.git('hash-object', 'a.txt');
    const body = await (await fetch(`${base}object?oid=${a}`)).json();
    assert.equal(body.text, 'alpha\n');
    assert.equal((await fetch(`${base}object?oid=../../etc/passwd`)).status, 400);
  });

  it('takes a new view', async () => {
    const res = await fetch(base + 'view', {
      method: 'POST',
      body: JSON.stringify({ question: { kind: 'all' }, limit: 2, expanded: [], showIndex: false }),
    });
    assert.equal(res.status, 204);
  });
});
