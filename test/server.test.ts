import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ensureFirstSnapshot, record, sanitise, sanitiseQuestion, serve, type Server } from '../src/server.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plumbedRepo, fakeState, type Repo } from './fixture.js';
import { DEFAULT_VIEW, TAPE_CAP, type Snapshot } from '../src/types.js';

describe('the view arriving from the browser', () => {
  it('falls back to everything when it makes no sense', () => {
    assert.deepEqual(sanitise({ question: { kind: 'nonsense' } }).question, { kind: 'all' });
    assert.equal(sanitise(null).limit, 120);
  });
  it('asks for everything however hard the browser asks for a filter', () => {
    // One shared view: a question from one viewer would rewrite every canvas.
    assert.deepEqual(sanitise({ question: { kind: 'search', text: 'a', in: 'content' } }).question, { kind: 'all' });
    assert.deepEqual(sanitise({ question: { kind: 'refs', refs: ['refs/heads/main'] } }).question, { kind: 'all' });
  });
  it('refuses a ref name that is not one', () => {
    // A name beginning with a dash would reach `rev-list` as an option.
    assert.deepEqual(sanitiseQuestion({ kind: 'refs', refs: ['--objects', '-n1'] }), {
      kind: 'refs',
      refs: [],
    });
    assert.deepEqual(sanitiseQuestion({ kind: 'refs', refs: ['refs/heads/ok', '; rm -rf /'] }), {
      kind: 'refs',
      refs: ['refs/heads/ok'],
    });
  });
  it('keeps a search inside what the plumbing will take', () => {
    const q = sanitiseQuestion({ kind: 'search', text: 'x'.repeat(500), in: 'sausage' as 'message' });
    assert.deepEqual(q, { kind: 'search', text: 'x'.repeat(200), in: 'message' });
    assert.equal(sanitiseQuestion({ kind: 'search', text: 'a', in: 'content' }).kind, 'search');
    assert.deepEqual(sanitiseQuestion(undefined), { kind: 'all' });
  });

  it('refuses an oid that is not one, and clamps the window', () => {
    assert.deepEqual(sanitise({ expanded: ['abc123', 'not an oid'] }).expanded, ['abc123']);
    assert.deepEqual(sanitise({ folded: ['abc123', 'rm -rf /'] }).folded, ['abc123']);
    assert.equal(sanitise({ limit: 1e9 }).limit, 1_000_000);
    assert.equal(sanitise({ limit: Number.MAX_SAFE_INTEGER }).limit, 1_000_000);
    assert.equal(sanitise({ limit: -4 }).limit, 1);
  });

  it('carries --learning back and forth with the view the browser hands over', () => {
    assert.equal(sanitise({ learning: true }).learning, true);
    assert.equal(sanitise({}).learning, false);
  });
});

/** The snapshots off an event stream, one frame at a time. `quietMs` ends it
 *  when nothing more arrives, which is how a test asserts that nothing did. */
async function* snapshots(res: Response, quietMs = 0) {
  const reader = res.body!.getReader();
  let buf = '';
  try {
  for (;;) {
    const read = reader.read();
    const { value, done } = await (quietMs
      ? Promise.race([read, quiet<typeof read>(quietMs)])
      : read);
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
  } finally {
    await reader.cancel();
  }
}

/** Silence, as an end of stream. */
function quiet<T>(ms: number): Promise<Awaited<T>> {
  return new Promise((r) => setTimeout(() => r({ value: undefined, done: true } as Awaited<T>), ms));
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

  it('serves the favicon the page asks for', async () => {
    const res = await fetch(base + 'favicon.png');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
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

  it('has the cross links up already under --learning', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0, '127.0.0.1', true);
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/events`);
      const stream = snapshots(res);
      const first = (await stream.next()).value;
      assert.equal(first.view.showCrossLinks, true);
      await stream.return(undefined);
    } finally {
      await server.close();
      repo.dispose();
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

describe('the page the server hands the browser', () => {
  // The canvas collapsed to its content height once, because a toolbar was
  // deleted and the body's row list still had a track for it: `main` landed on
  // an `auto` row and the `1fr` went to an empty one.
  it('gives the canvas the leftover height, not a row meant for a toolbar', () => {
    const html = readFileSync('web/index.html', 'utf8');
    const rows = /grid-template-rows:([^;]+);/.exec(html)![1].trim().split(/\s+/);
    const children = html
      .slice(html.indexOf('<body>'), html.indexOf('</body>'))
      .match(/^ {4}<(?!\/)([a-z]+)/gm)!
      .map((t) => t.slice(5));
    assert.deepEqual(
      children.filter((t) => t !== 'script' && t !== 'dialog'),
      ['header', 'div', 'div', 'main'],
    );
    assert.equal(rows.length, 4, 'one track per row of the page');
    assert.equal(rows[rows.length - 1], '1fr', 'the canvas is last and takes the rest');
  });
});

/**
 * Restarting gitva is not a step. The recording belongs to the repository, so
 * everything the last run recorded is still there — and the run that recorded
 * it having ended is not something git did.
 */
describe('a recording that outlives the process', () => {
  /** Every state a browser is handed before the stream goes quiet. */
  async function watch(port: number): Promise<Snapshot[]> {
    const seen: Snapshot[] = [];
    for await (const s of snapshots(await fetch(`http://127.0.0.1:${port}/events`), 900)) seen.push(s);
    return seen;
  }

  it('picks the same one back up, and carries on numbering steps of the repository', async () => {
    const repo = plumbedRepo();
    try {
      const first = await serve(repo.dir, 0);
      const before = await watch(first.port);
      assert.equal(before.length, 1);
      await first.close();

      // Off the air while git works: the step is missed, as it always was, but
      // the ones already recorded are not lost with the process.
      repo.write('e.txt', 'epsilon\n');
      repo.git('hash-object', '-w', 'e.txt');

      const second = await serve(repo.dir, 0);
      try {
        const after = await watch(second.port);
        assert.deepEqual(
          after.map((s) => s.seq),
          [before[0].seq, before[0].seq + 1],
          'the replayed step, then the one the repository moved to while nobody was watching',
        );
      } finally {
        await second.close();
      }
    } finally {
      repo.dispose();
    }
  });

  it('does not record a step for a restart onto a repository nothing happened to', async () => {
    const repo = plumbedRepo();
    try {
      const first = await serve(repo.dir, 0);
      await watch(first.port);
      await first.close();

      const second = await serve(repo.dir, 0);
      try {
        assert.equal((await watch(second.port)).length, 1, 'still one step, not one per run');
      } finally {
        await second.close();
      }
    } finally {
      repo.dispose();
    }
  });

  it('files it under --id when given one, so the folder may move or be cloned', async () => {
    const one = plumbedRepo();
    const two = plumbedRepo();
    try {
      const first = await serve(one.dir, 0, '127.0.0.1', false, 'teaching');
      const before = await watch(first.port);
      await first.close();

      // A different folder entirely, and the same recording: the identifier is
      // the repository, not the path it happens to be sitting at.
      const second = await serve(two.dir, 0, '127.0.0.1', false, 'teaching');
      try {
        const after = await watch(second.port);
        assert.equal(after[0].repo, one.dir.split('/').pop());
        assert.equal(after.at(-1)!.seq, before[0].seq + 1);
      } finally {
        await second.close();
      }
    } finally {
      one.dispose();
      two.dispose();
    }
  });

  /** The identifier the header shows, which is what a click on it copies. */
  async function recordingId(port: number): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    let buf = '';
    let found: RegExpExecArray | null = null;
    while (!(found = /event: recording\ndata: (.*)\n/.exec(buf))) {
      const { value, done } = await reader.read();
      if (done) assert.fail('the stream never said which recording it is');
      buf += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return (JSON.parse(found[1]) as { id: string }).id;
  }

  // What the identifier in the header is for: copy it before you move the
  // folder, and the recording is still yours afterwards.
  it('tells the browser what it filed the recording under, and takes it back as --id', async () => {
    const here = plumbedRepo();
    const moved = plumbedRepo();
    try {
      const first = await serve(here.dir, 0);
      const id = await recordingId(first.port);
      assert.match(id, /^[0-9a-f]{10}$/);
      const before = await watch(first.port);
      await first.close();

      const second = await serve(moved.dir, 0, '127.0.0.1', false, id);
      try {
        assert.equal(await recordingId(second.port), id, 'the identifier survives being handed back');
        const after = await watch(second.port);
        assert.equal(after[0].repo, here.dir.split('/').pop(), 'the step recorded before the move');
        assert.equal(after.at(-1)!.seq, before[0].seq + 1);
      } finally {
        await second.close();
      }
    } finally {
      here.dispose();
      moved.dispose();
    }
  });

  it('clears the recording when a browser asks, and tells every browser watching', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0);
    const base = `http://127.0.0.1:${server.port}/`;
    try {
      assert.equal((await watch(server.port)).length, 1, 'a step to throw away');
      // A viewer left holding steps the server has forgotten would be scrubbing
      // a session nobody else can see, so everyone is told, not just the asker.
      const res = await fetch(base + 'events');
      const reader = res.body!.getReader();
      let buf = '';
      assert.equal((await fetch(base + 'clear', { method: 'POST' })).status, 204);
      while (!buf.includes('event: cleared')) {
        const { value, done } = await reader.read();
        if (done) assert.fail('the stream ended without saying it had been cleared');
        buf += new TextDecoder().decode(value);
      }
      await reader.cancel();

      // What a browser coming back finds: the repository as it is now, step one.
      assert.deepEqual((await watch(server.port)).map((s) => s.seq), [1]);
      await server.close();

      // And the kept recording was cleared with it, not just the one in memory.
      const again = await serve(repo.dir, 0);
      try {
        assert.deepEqual((await watch(again.port)).map((s) => s.seq), [1]);
      } finally {
        await again.close();
      }
    } finally {
      await server.close();
      repo.dispose();
    }
  });

  /** The whole kept recording, as a browser is handed it on connect. */
  async function historyOf(port: number): Promise<Snapshot[]> {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    let buf = '';
    let found: RegExpExecArray | null = null;
    while (!(found = /event: history\ndata: (.*)\n/.exec(buf))) {
      const { value, done } = await reader.read();
      if (done) assert.fail('the stream handed over no recording');
      buf += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return JSON.parse(found[1]) as Snapshot[];
  }

  // The bug this exists for: a step carries the view it was answered under, so
  // a resumed recording used to answer with the *last* run's view. Restarting
  // with `--learning` opened nothing, restarting without it left everything
  // open, and clicking `clear` was the only way to change your mind — because
  // clearing rebuilds and rebuilding stamps the current view on.
  it('answers a kept recording with this run\'s view, not the one it was recorded under', async () => {
    const repo = plumbedRepo();
    try {
      const plain = await serve(repo.dir, 0);
      const before = await watch(plain.port);
      assert.equal(before.at(-1)!.view.learning, false);
      await plain.close();

      const learning = await serve(repo.dir, 0, '127.0.0.1', true);
      const kept = await historyOf(learning.port);
      // Answered again, not recorded again: restarting is still not a step.
      assert.equal(kept.length, before.length);
      assert.equal(kept.at(-1)!.seq, before.at(-1)!.seq);
      assert.equal(kept.at(-1)!.view.learning, true);
      assert.equal(kept.at(-1)!.view.showCrossLinks, true, 'links from unreachable, the same way');
      await learning.close();

      // And back the other way: without the flag, nothing arrives expanded
      // because the last run said it should.
      const again = await serve(repo.dir, 0);
      const back = await historyOf(again.port);
      assert.equal(back.at(-1)!.view.learning, false);
      assert.equal(back.at(-1)!.view.showCrossLinks, false);

      // It is not only the flags: every part of the view is this run's. A
      // window a browser widened last time is not one this run has asked for.
      await fetch(`http://127.0.0.1:${again.port}/view`, { method: 'POST', body: JSON.stringify({ limit: 3 }) });
      await again.close();

      const fresh = await serve(repo.dir, 0);
      try {
        assert.equal((await historyOf(fresh.port)).at(-1)!.view.limit, DEFAULT_VIEW.limit);
      } finally {
        await fresh.close();
      }
    } finally {
      repo.dispose();
    }
  });

  it('keeps the steps when the repository they were recorded from has gone', async () => {
    const repo = plumbedRepo();
    const first = await serve(repo.dir, 0);
    const before = await watch(first.port);
    await first.close();
    // Nothing to re-answer the newest step against, and nothing to say about
    // it: the recording is what is left of the repository, so it stands.
    repo.dispose();
    const second = await serve(repo.dir, 0);
    try {
      assert.deepEqual((await historyOf(second.port)).map((s) => s.seq), before.map((s) => s.seq));
    } finally {
      await second.close();
    }
  });

  it('starts a recording of its own for a folder nothing was kept for', async () => {
    const repo = plumbedRepo();
    const server = await serve(repo.dir, 0);
    try {
      assert.equal((await watch(server.port))[0].seq, 1, 'step one');
    } finally {
      await server.close();
      repo.dispose();
    }
  });
});
