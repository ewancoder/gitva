import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ensureFirstSnapshot, record, sanitise, serve, type Server } from '../src/server.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plumbedRepo, fakeState, type Repo } from './fixture.js';
import { DEFAULT_VIEW, TAPE_CAP, type Snapshot } from '../src/types.js';

describe('the view arriving from the browser', () => {
  it('falls back to everything when it makes no sense', () => {
    assert.deepEqual(sanitise({ question: { kind: 'nonsense' } }).question, { kind: 'all' });
    assert.equal(sanitise(null).limit, 120);
  });
  it('refuses a ref name that is not one', () => {
    // A name beginning with a dash would reach `rev-list` as an option.
    assert.deepEqual(sanitise({ question: { kind: 'refs', refs: ['--objects', '-n1'] } }).question, {
      kind: 'refs',
      refs: [],
    });
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
    assert.deepEqual(sanitise({ folded: ['abc123', 'rm -rf /'] }).folded, ['abc123']);
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
      const data = frame.split('\ndata: ')[1];
      // A connect hands over every state at once; the live tail is one at a
      // time. Either way what a reader wants is states, in order.
      if (frame.startsWith('event: history')) yield* JSON.parse(data);
      else if (frame.startsWith('event: snapshot')) yield JSON.parse(data);
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
    const stream = snapshots(await fetch(base + 'events'));
    const snap = (await stream.next()).value;
    assert.equal(snap.repo, repo.dir.split('/').pop());
    assert.ok(snap.window.commits.length >= 3);
    await stream.return(undefined);
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

  // Questions that pile up while one is being answered coalesce, so an
  // intermediate one may never be drawn — but the newest one always is.
  it('answers the newest question asked while it is busy answering one', async () => {
    const res = await fetch(base + 'events');
    const stream = snapshots(res);
    await stream.next();

    await Promise.all(
      [7, 9].map((limit) =>
        fetch(base + 'view', { method: 'POST', body: JSON.stringify({ limit }) }),
      ),
    );
    let frame = (await stream.next()).value;
    while (frame.view.limit !== 9) frame = (await stream.next()).value;
    assert.equal(frame.view.limit, 9);
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
  it('does not count the first state twice when the poller answers first', async () => {
    let recorded = false;
    let finish!: () => void;
    const active = new Promise<void>((resolve) => {
      finish = () => {
        recorded = true;
        resolve();
      };
    });
    let builds = 0;
    const first = ensureFirstSnapshot(active, () => recorded, async () => {
      builds++;
    });
    finish();
    await first;
    assert.equal(builds, 0);
  });

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

describe('a directory that is not a repository yet', () => {
  it('waits for `git init` rather than refusing to start', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitva-empty-'));
    const server = await serve(dir, 0);
    try {
      // Two viewers arriving together share the first repository read. Without
      // that, the same state is recorded twice merely because a room joined.
      const [a, b] = await Promise.all([
        fetch(`http://127.0.0.1:${server.port}/events`),
        fetch(`http://127.0.0.1:${server.port}/events`),
      ]);
      const streams = [snapshots(a), snapshots(b)];
      // `git init` is the first plumbing command the tutorial teaches, so the
      // browser has to be able to watch it happen.
      execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      });
      const [s, same] = await Promise.all(streams.map(async (stream) => (await stream.next()).value));
      assert.equal(s.head.unborn, true);
      assert.deepEqual(s.refs, []);
      assert.equal(same.seq, s.seq);

      // The next frame really is the next repository state, not a duplicate
      // initial build that was waiting behind the first one.
      const oid = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], {
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
        input: 'alpha\n',
        encoding: 'utf8',
      }).trim();
      const next = await Promise.all(streams.map(async (stream) => (await stream.next()).value));
      assert.ok(next.every((state) => state.seq === s.seq + 1 && state.objects[oid]));
      await Promise.all(streams.map((stream) => stream.return(undefined)));
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The first read finds nothing to hand the next arrival, and the poller stays
  // quiet until the signal moves — so a browser opened second must still be
  // told what it is waiting for instead of sitting on a blank page.
  it('tells a browser that joins later that it is still waiting for `git init`', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitva-empty-'));
    const server = await serve(dir, 0);
    const waiting = async () => {
      const res = await fetch(`http://127.0.0.1:${server.port}/events`);
      const reader = res.body!.getReader();
      let buf = '';
      while (!buf.includes('\n\n') || !buf.includes('event: trouble')) {
        const { value, done } = await reader.read();
        if (done) assert.fail('the stream ended without saying anything');
        buf += new TextDecoder().decode(value);
      }
      await reader.cancel();
      return buf;
    };
    try {
      await waiting();
      assert.match(await waiting(), /waiting for/);
    } finally {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the history everyone shares', () => {
  /** States reach the history the way they reach the wire: already serialised. */
  const state = (seq: number, extra: Partial<Snapshot> = {}) => JSON.stringify(fakeState({ seq, ...extra }));
  const seqs = (history: string[]) => history.map((s) => JSON.parse(s).seq);
  /** A state of a repository big enough for the byte ceiling to be the one that bites. */
  const heavy = (seq: number, mb: number) => state(seq, { notes: ['x'.repeat(mb << 20)] });

  it('replaces the top rather than stepping when the same state is asked a different question', () => {
    const history: string[] = [];
    record(history, state(1), true);
    record(history, state(1, { view: { ...DEFAULT_VIEW, limit: 3 } }), false);
    assert.equal(history.length, 1);
    assert.equal(JSON.parse(history[0]).view.limit, 3);
    record(history, state(2), true);
    assert.deepEqual(seqs(history), [1, 2]);
  });

  it('forgets the oldest states at the same cap the browser’s tape uses', () => {
    const history: string[] = [];
    for (let seq = 1; seq <= TAPE_CAP + 5; seq++) record(history, state(seq), true);
    assert.equal(history.length, TAPE_CAP);
    assert.equal(seqs(history)[0], 6);
  });

  // Measured: a state of a tutorial repository is ~3 KB and all 400 fit in a
  // megabyte, but a state of a repository with a few thousand objects is a
  // third of a megabyte, and 400 of those is not something to hand a browser
  // that has just opened.
  it('forgets sooner than that when the states are heavy enough to be unpleasant', () => {
    const history: string[] = [];
    for (const seq of [1, 2, 3]) record(history, heavy(seq, 6), true);
    assert.deepEqual(seqs(history), [2, 3], 'the tail was not trimmed to what fits');

    record(history, heavy(4, 20), true);
    assert.deepEqual(seqs(history), [4], 'a state too big to fit on its own still has to be sent');
  });

  // The situation this was found in: `gitva` left running, a handful of
  // plumbing commands typed, the browser opened afterwards — and one step on
  // the tape instead of a handful. A state nobody was connected for cannot be
  // built later, because by then the repository has moved on.
  it('records what happened while nobody was watching', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0);
    /** Long enough for the poller to have asked, whoever is or is not there. */
    const polled = () => new Promise((r) => setTimeout(r, 700));
    try {
      await polled();
      for (const name of ['e', 'f']) {
        repo.write(`${name}.txt`, `${name}\n`);
        repo.git('hash-object', '-w', `${name}.txt`);
        await polled();
      }

      const watching = snapshots(await fetch(`http://127.0.0.1:${server.port}/events`));
      const seen: Snapshot[] = [];
      for (let i = 0; i < 3; i++) seen.push((await watching.next()).value);
      assert.deepEqual(seen.map((s) => s.seq), [1, 2, 3]);
      assert.ok(seen[2].objects[repo.git('hash-object', 'f.txt')], 'the newest state is the repository now');
      await watching.return(undefined);
    } finally {
      await server.close();
      repo.dispose();
    }
  });

  it('hands a browser opened later every state that happened before it', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0);
    const base = `http://127.0.0.1:${server.port}/`;
    try {
      // Somebody has to be watching for the poller to be asking at all.
      const watching = snapshots(await fetch(base + 'events'));
      const start = (await watching.next()).value;
      for (const name of ['e', 'f']) {
        repo.write(`${name}.txt`, `${name}\n`);
        repo.git('hash-object', '-w', `${name}.txt`);
        await watching.next();
      }

      const late = snapshots(await fetch(base + 'events'));
      const seen: Snapshot[] = [];
      for (let i = 0; i < 3; i++) seen.push((await late.next()).value);
      assert.deepEqual(
        seen.map((s) => s.seq),
        [start.seq, start.seq + 1, start.seq + 2],
        'the second browser started where the first one did, not where it happened to arrive',
      );
      await Promise.all([watching.return(undefined), late.return(undefined)]);
    } finally {
      await server.close();
      repo.dispose();
    }
  });
});
