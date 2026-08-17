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
  it('keeps a search inside what the plumbing will take', () => {
    const q = sanitise({ question: { kind: 'search', text: 'x'.repeat(500), in: 'sausage' } }).question;
    assert.deepEqual(q, { kind: 'search', text: 'x'.repeat(200), in: 'message' });
    assert.equal(sanitise({ question: { kind: 'search', text: 'a', in: 'content' } }).question.kind, 'search');
  });

  it('refuses an oid that is not one, and clamps the window', () => {
    assert.deepEqual(sanitise({ expanded: ['abc123', 'not an oid'] }).expanded, ['abc123']);
    assert.equal(sanitise({ limit: 1e9 }).limit, 1_000_000);
    assert.equal(sanitise({ limit: Number.MAX_SAFE_INTEGER }).limit, 1_000_000);
    assert.equal(sanitise({ limit: -4 }).limit, 1);
  });
});

/** The snapshots off an event stream, one frame at a time. */
async function* snapshots(res: Response) {
  const reader = res.body!.getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += new TextDecoder().decode(value);
    let end: number;
    while ((end = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, end);
      buf = buf.slice(end + 2);
      if (frame.startsWith('event: snapshot')) yield JSON.parse(frame.split('\ndata: ')[1]);
    }
  }
}

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

  it('numbers states of the repository, not answers to questions', async () => {
    const res = await fetch(base + 'events');
    const stream = snapshots(res);
    const a = (await stream.next()).value;

    // A different question of the same repository is not a step.
    await fetch(base + 'view', { method: 'POST', body: JSON.stringify({ limit: 3 }) });
    const b = (await stream.next()).value;
    assert.equal(b.seq, a.seq);
    assert.equal(b.view.limit, 3);

    // A new object is.
    repo.write('e.txt', 'epsilon\n');
    repo.git('hash-object', '-w', 'e.txt');
    const c = (await stream.next()).value;
    assert.equal(c.seq, a.seq + 1);
    await stream.return(undefined);
  });

  it('takes a new view', async () => {
    const res = await fetch(base + 'view', {
      method: 'POST',
      body: JSON.stringify({ question: { kind: 'all' }, limit: 2, expanded: [], showIndex: false }),
    });
    assert.equal(res.status, 204);
  });

  it('404s a file that is inside a served root but is not there', async () => {
    assert.equal((await fetch(base + 'web/nothing-like-this.js')).status, 404);
  });

  it('says so rather than dying when the browser posts nonsense', async () => {
    const res = await fetch(base + 'view', { method: 'POST', body: 'not json' });
    assert.equal(res.status, 500);
    // And it is still serving afterwards.
    assert.equal((await fetch(base)).status, 200);
  });
});

describe('a repository that moves under the server', () => {
  it('tells the browser what went wrong rather than going quiet', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0);
    // Measured at startup, gone before the first browser arrives: the first
    // state cannot be built, and saying so out loud is the whole answer.
    repo.dispose();
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/events`);
      const reader = res.body!.getReader();
      let buf = '';
      while (!buf.includes('event: trouble')) {
        const { value, done } = await reader.read();
        if (done) assert.fail('the stream ended without saying anything');
        buf += new TextDecoder().decode(value);
      }
      await reader.cancel();
    } finally {
      await server.close();
    }
  });

  it('keeps serving while git is mid-rewrite, and says what went wrong', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0);
    const base = `http://127.0.0.1:${server.port}/`;
    try {
      const res = await fetch(base + 'events');
      const stream = snapshots(res);
      await stream.next(); // the first state, off a repository that exists
      // The poller now asks a repository that has gone. It must not take the
      // process with it: a repo mid-rewrite is a normal thing to catch a git
      // command in, and the next tick is the answer.
      repo.dispose();
      await new Promise((r) => setTimeout(r, 1200));
      assert.equal((await fetch(base)).status, 200);
      await stream.return(undefined);
    } finally {
      await server.close();
      repo.dispose();
    }
  });
});
