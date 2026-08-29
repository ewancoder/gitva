import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ensureFirstStep, record, serve, type Server } from '../src/server.js';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plumbedRepo, fakeStep, type Repo } from './fixture.js';
import { loadRecording, lockFile, recordingFile, recordingKey } from '../src/store.js';
import { resolve } from 'node:path';
import { RECORDING_CAP, type Step } from '../src/types.js';

/** The steps off an event stream, one frame at a time. `quietMs` ends it
 *  when nothing more arrives, which is how a test asserts that nothing did. */
async function* stepsOf(res: Response, quietMs = 0): AsyncGenerator<Step, void> {
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
                // A connect hands over every step at once; the live tail is one at a
                // time. Either way what a viewer wants is steps, in order.
                if (frame.startsWith('event: steps\n')) yield* JSON.parse(data) as Step[];
                else if (frame.startsWith('event: step\n')) yield JSON.parse(data) as Step;
            }
        }
    } finally {
        await reader.cancel();
    }
}

/** The next step off a stream. A test that asks has already made one happen. */
async function nextStep(stream: AsyncGenerator<Step, void>): Promise<Step> {
    const { value } = await stream.next();
    assert.ok(value, 'the stream ended before the step the test was waiting for');
    return value;
}

/** Silence, as an end of stream. */
function quiet<T>(ms: number): Promise<Awaited<T>> {
    return new Promise((r) =>
        setTimeout(() => r({ value: undefined, done: true } as Awaited<T>), ms),
    );
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
        assert.match(await res.text(), /<canvas id="canvas">/);
    });

    it('serves the favicon the page asks for', async () => {
        const res = await fetch(base + 'favicon.png');
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'image/png');
    });

    it('refuses anything outside the two static roots', async () => {
        assert.equal((await fetch(base + 'etc/passwd')).status, 404);
        assert.equal((await fetch(base + '../package.json')).status, 404);
        assert.equal((await fetch(base + 'web/../../package.json')).status, 404);
    });

    /**
     * The page is a module graph, and a module it cannot fetch is a blank screen
     * — which no other test here would notice, because every one of them talks to
     * the server rather than loading the page. The static route once matched a
     * single path segment, so the day the words moved into `web/localization/`
     * the browser stopped being able to load them and the suite stayed green.
     */
    it('serves every module the page imports, subfolders and all', async () => {
        const seen = new Set<string>();
        const queue = ['web/app.js'];
        while (queue.length) {
            const file = queue.pop()!;
            if (seen.has(file)) continue;
            seen.add(file);
            const res = await fetch(base + file);
            assert.equal(res.status, 200, file);
            const dir = file.slice(0, file.lastIndexOf('/'));
            for (const [, spec] of (await res.text()).matchAll(
                /from\s*['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]/g,
            )) {
                if (spec?.startsWith('.'))
                    queue.push(new URL(spec, `http://x/${dir}/`).pathname.slice(1));
            }
        }
        assert.ok(seen.has('web/localization/languages/en.js'), 'the words are part of the graph');
        assert.ok(seen.has('src/types.js'), 'the seam is served too');
    });

    it('pushes a whole step down the stream', async () => {
        const stream = stepsOf(await fetch(base + 'events'));
        const step = await nextStep(stream);
        assert.equal(step.repo, repo.dir.split('/').pop());
        assert.ok(step.window.commits.length >= 3);
        await stream.return(undefined);
    });

    it('reads one body only when asked, and checks the oid first', async () => {
        const a = repo.git('hash-object', 'a.txt');
        const body = (await (await fetch(`${base}object?oid=${a}`)).json()) as { text: string };
        assert.equal(body.text, 'alpha\n');
        assert.equal((await fetch(`${base}object?oid=../../etc/passwd`)).status, 400);
    });

    // A step is what git did, and only git makes one. There is no route a browser
    // can reach that changes what is recorded — the view it draws with is its own,
    // and every step already carries everything that view could ask about.
    it('numbers steps of the repository, and takes nothing from a browser', async () => {
        const res = await fetch(base + 'events');
        const stream = stepsOf(res);
        const a = await nextStep(stream);

        for (const method of ['POST', 'GET']) {
            const said = await fetch(base + 'view', {
                method,
                body: method === 'POST' ? '{}' : undefined,
            });
            assert.equal(said.status, 404, `no ${method} /view to change anyone's canvas with`);
        }

        // A new object is a step, and the only kind of thing that is.
        repo.write('e.txt', 'epsilon\n');
        repo.git('hash-object', '-w', 'e.txt');
        const c = await nextStep(stream);
        assert.equal(c.seq, a.seq + 1);
        await stream.return(undefined);
    });

    it('says what went wrong rather than dying, when the object asked for is not there', async () => {
        const missing = await fetch(base + 'object?oid=' + 'd'.repeat(40));
        assert.equal(missing.status, 500);
        // And it is still serving afterwards.
        assert.equal((await fetch(base)).status, 200);
    });

    it('404s a file that is inside a served root but is not there', async () => {
        assert.equal((await fetch(base + 'web/nothing-like-this.js')).status, 404);
    });
});

/** What the stream says about the run itself, before any step. */
async function recordingFrame(port: number): Promise<{ id: string; learning: boolean }> {
    const res = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = res.body!.getReader();
    let buf = '';
    let found: RegExpExecArray | null = null;
    while (!(found = /event: recording\ndata: (.*)\n/.exec(buf))) {
        const { value, done } = await reader.read();
        if (done) assert.fail('the stream said nothing about the recording');
        buf += new TextDecoder().decode(value);
    }
    await reader.cancel();
    return JSON.parse(found[1]) as { id: string; learning: boolean };
}

describe('a repository that moves under the server', () => {
    it('does not count the first step twice when the poller answers first', async () => {
        let recorded = false;
        let finish!: () => void;
        const active = new Promise<boolean>((resolve) => {
            finish = () => {
                recorded = true;
                resolve(true);
            };
        });
        let builds = 0;
        const first = ensureFirstStep(
            active,
            () => recorded,
            () => {
                builds++;
                return Promise.resolve(true);
            },
        );
        finish();
        await first;
        assert.equal(builds, 0);
        assert.equal(await first, true, 'a step somebody else recorded is a step');
    });

    // The signal stands for a change that was drawn. The poller only commits it
    // once one was; the first build, which a browser connecting inside the first
    // tick asks for, has to make the same bargain. Committing it there left the
    // poller with nothing to notice, and that browser watching an empty canvas
    // for as long as the repository sat still.
    it('retries a first step git refused to build, on a repository that then sits still', async () => {
        const repo = plumbedRepo();
        const head = repo.git('rev-parse', 'HEAD');
        const object = join(repo.dir, '.git', 'objects', head.slice(0, 2), head.slice(2));
        // An object git cannot read: the change signal is refs, the object count
        // and the index, so none of it moves while this is on or when it comes off.
        // Only a retry can produce a step.
        chmodSync(object, 0o000);
        const server = await serve(repo.dir, 0);
        try {
            // Inside the first poll, which is what a browser opened for you is.
            const stream = stepsOf(await fetch(`http://127.0.0.1:${server.port}/events`), 3000);
            setTimeout(() => chmodSync(object, 0o444), 700);
            const step = await nextStep(stream);
            assert.equal(step.seq, 1, 'the first step, retried rather than stepped past');
            await stream.return(undefined);
        } finally {
            chmodSync(object, 0o444);
            await server.close();
            repo.dispose();
        }
    });

    it('tells the browser what went wrong rather than going quiet', async () => {
        const repo = plumbedRepo();
        const server = await serve(repo.dir, 0);
        // Measured at startup, gone before the first browser arrives: the first
        // step cannot be built, and saying so out loud is the whole answer.
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

    // `--learning` is a fact about the run, not about a step: the presenter said
    // it, every viewer hears it once on connecting, and a step scrubbed back to
    // does not un-say it.
    it('tells a browser that this run is a demonstration', async () => {
        const repo = plumbedRepo();
        const plain = await serve(repo.dir, 0);
        try {
            assert.equal((await recordingFrame(plain.port)).learning, false);
        } finally {
            await plain.close();
        }
        const server = await serve(repo.dir, 0, '127.0.0.1', true);
        try {
            const frame = await recordingFrame(server.port);
            assert.equal(frame.learning, true);
            assert.ok(frame.id.length > 0, 'and which recording it is');
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
            const stream = stepsOf(res);
            await stream.next(); // the first step, off a repository that exists
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

    // The change signal moves for a repository git then refuses to read — an
    // index half-rewritten is the everyday case. Stepping past that change would
    // lose it out of the shared recording for good, and spend a step number on an
    // attempt no viewer ever saw.
    it('retries a change whose step could not be built', async () => {
        const repo = plumbedRepo();
        const server = await serve(repo.dir, 0);
        const index = join(repo.dir, '.git', 'index');
        const base = `http://127.0.0.1:${server.port}/`;
        try {
            const stream = stepsOf(await fetch(base + 'events'));
            const before = await nextStep(stream);
            // Every command that has to read the index now fails, while
            // for-each-ref and count-objects answer perfectly well.
            writeFileSync(index, 'not an index');
            // A change made while git is unreadable: it has to survive the failure.
            repo.write('later.txt', 'written while git could not answer\n');
            const oid = repo.git('hash-object', '-w', 'later.txt');
            await new Promise((r) => setTimeout(r, 1200));
            repo.git('read-tree', 'HEAD');
            const after = await nextStep(stream);
            assert.equal(after.seq, before.seq + 1, 'a failed attempt burnt a step number');
            assert.ok(after.objects[oid], 'the change made during the failure was lost');
            await stream.return(undefined);
        } finally {
            await server.close();
            repo.dispose();
        }
    });
});

describe('a port that cannot be listened on', () => {
    // `listen` says so with an `error` event, and an event nothing is listening
    // for is thrown past the CLI's own handler as a node stack trace about
    // `options.port` — starting gitva twice is how you meet it.
    it('says which address, rather than throwing a node stack trace', async () => {
        const held = plumbedRepo();
        const taken = await serve(held.dir, 0);
        const other = plumbedRepo();
        try {
            await assert.rejects(
                serve(other.dir, taken.port, '127.0.0.1'),
                /cannot listen on 127\.0\.0\.1:\d+ — .*EADDRINUSE/,
            );
            // And it let go of the recording it had just taken on the way out, so
            // the next run walks straight in rather than waiting the lock out.
            assert.equal(
                existsSync(lockFile(recordingKey(resolve(other.dir)))),
                false,
                'a run that never started is not one holding a recording',
            );
        } finally {
            await taken.close();
            other.dispose();
            held.dispose();
        }
    });
});

describe('a directory that is not a repository yet', () => {
    it('waits for `git init` rather than refusing to start', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'gitva-empty-'));
        const server = await serve(dir, 0);
        try {
            // Two viewers arriving together share the first repository read. Without
            // that, the same step is recorded twice merely because a viewer joined.
            const [a, b] = await Promise.all([
                fetch(`http://127.0.0.1:${server.port}/events`),
                fetch(`http://127.0.0.1:${server.port}/events`),
            ]);
            const streams = [stepsOf(a), stepsOf(b)];
            // `git init` is the first plumbing command the tutorial teaches, so the
            // browser has to be able to watch it happen.
            execFileSync('git', ['-C', dir, 'init', '-q', '-b', 'main'], {
                env: {
                    ...process.env,
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                },
            });
            const [s, same] = await Promise.all(streams.map((stream) => nextStep(stream)));
            assert.equal(s.head.unborn, true);
            assert.deepEqual(s.refs, []);
            assert.equal(same.seq, s.seq);

            // The next frame really is the next repository step, not a duplicate
            // initial build that was waiting behind the first one.
            const oid = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], {
                env: {
                    ...process.env,
                    GIT_CONFIG_GLOBAL: '/dev/null',
                    GIT_CONFIG_SYSTEM: '/dev/null',
                },
                input: 'alpha\n',
                encoding: 'utf8',
            }).trim();
            const next = await Promise.all(streams.map((stream) => nextStep(stream)));
            assert.ok(next.every((step) => step.seq === s.seq + 1 && step.objects[oid]));
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

describe('the steps everyone shares', () => {
    /** Steps reach the steps the way they reach the wire: already serialised. */
    const step = (seq: number, extra: Partial<Step> = {}) =>
        JSON.stringify(fakeStep({ seq, ...extra }));
    const seqs = (steps: string[]) => steps.map((s) => (JSON.parse(s) as Step).seq);
    /** A step of a repository big enough for the byte ceiling to be the one that bites. */
    const heavy = (seq: number, mb: number) => step(seq, { repo: 'x'.repeat(mb << 20) });

    it('forgets the oldest steps at the same cap the browser’s recording uses', () => {
        const steps: string[] = [];
        for (let seq = 1; seq <= RECORDING_CAP + 5; seq++) record(steps, step(seq));
        assert.equal(steps.length, RECORDING_CAP);
        assert.equal(seqs(steps)[0], 6);
    });

    // Measured: a step of a tutorial repository is ~3 KB and all 400 fit in a
    // megabyte, but a step of a repository with a few thousand objects is a
    // third of a megabyte, and 400 of those is not something to hand a browser
    // that has just opened.
    it('forgets sooner than that when the steps are heavy enough to be unpleasant', () => {
        const steps: string[] = [];
        for (const seq of [1, 2, 3]) record(steps, heavy(seq, 6));
        assert.deepEqual(seqs(steps), [2, 3], 'the tail was not trimmed to what fits');

        record(steps, heavy(4, 20));
        assert.deepEqual(seqs(steps), [4], 'a step too big to fit on its own still has to be sent');
    });

    // The situation this was found in: `gitva` left running, a handful of
    // plumbing commands typed, the browser opened afterwards — and one step on
    // the recording instead of a handful. A step nobody was connected for cannot be
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

            const watching = stepsOf(await fetch(`http://127.0.0.1:${server.port}/events`));
            const seen: Step[] = [];
            for (let i = 0; i < 3; i++) seen.push(await nextStep(watching));
            assert.deepEqual(
                seen.map((s) => s.seq),
                [1, 2, 3],
            );
            assert.ok(
                seen[2].objects[repo.git('hash-object', 'f.txt')],
                'the newest step is the repository now',
            );
            await watching.return(undefined);
        } finally {
            await server.close();
            repo.dispose();
        }
    });

    it('hands a browser opened later every step that happened before it', async () => {
        const repo = plumbedRepo();
        const server = await serve(repo.dir, 0);
        const base = `http://127.0.0.1:${server.port}/`;
        try {
            // Somebody has to be watching for the poller to be asking at all.
            const watching = stepsOf(await fetch(base + 'events'));
            const start = await nextStep(watching);
            for (const name of ['e', 'f']) {
                repo.write(`${name}.txt`, `${name}\n`);
                repo.git('hash-object', '-w', `${name}.txt`);
                await watching.next();
            }

            const late = stepsOf(await fetch(base + 'events'));
            const seen: Step[] = [];
            for (let i = 0; i < 3; i++) seen.push(await nextStep(late));
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
            ['div', 'div', 'div', 'main'],
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
    /** Every step a browser is handed before the stream goes quiet. */
    async function watch(port: number): Promise<Step[]> {
        const seen: Step[] = [];
        for await (const s of stepsOf(await fetch(`http://127.0.0.1:${port}/events`), 900))
            seen.push(s);
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
                assert.equal(
                    (await watch(second.port)).length,
                    1,
                    'still one step, not one per run',
                );
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

    /** The identifier the view toolbar shows, which is what a click on it copies. */
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

    // What the identifier in the view toolbar is for: copy it before you move the
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
                assert.equal(
                    await recordingId(second.port),
                    id,
                    'the identifier survives being handed back',
                );
                const after = await watch(second.port);
                assert.equal(
                    after[0].repo,
                    here.dir.split('/').pop(),
                    'the step recorded before the move',
                );
                assert.equal(after.at(-1)!.seq, before[0].seq + 1);
            } finally {
                await second.close();
            }
        } finally {
            here.dispose();
            moved.dispose();
        }
    });

    it('starts the recording over with --fresh, and lets no browser do it', async () => {
        const repo = plumbedRepo();
        const server = await serve(repo.dir, 0);
        try {
            assert.equal((await watch(server.port)).length, 1, 'a step to throw away');
            // No browser may end everyone's session: the recording is shared, and
            // clearing it is the presenter's call at startup.
            const res = await fetch(`http://127.0.0.1:${server.port}/clear`, { method: 'POST' });
            assert.equal(res.status, 404);
            await res.text();
            assert.equal((await watch(server.port)).length, 1, 'and the step is still there');
        } finally {
            await server.close();
        }

        // What `--fresh` leaves: the repository as it is now, step one, with the
        // kept steps gone from disk too.
        const again = await serve(repo.dir, 0, '127.0.0.1', false, undefined, true);
        try {
            assert.deepEqual(
                (await watch(again.port)).map((s) => s.seq),
                [1],
            );
        } finally {
            await again.close();
        }

        const back = await serve(repo.dir, 0);
        try {
            assert.deepEqual(
                (await watch(back.port)).map((s) => s.seq),
                [1],
            );
        } finally {
            await back.close();
            repo.dispose();
        }
    });

    /** The whole kept recording, as a browser is handed it on connect. */
    async function historyOf(port: number): Promise<Step[]> {
        const res = await fetch(`http://127.0.0.1:${port}/events`);
        const reader = res.body!.getReader();
        let buf = '';
        let found: RegExpExecArray | null = null;
        while (!(found = /event: steps\ndata: (.*)\n/.exec(buf))) {
            const { value, done } = await reader.read();
            if (done) assert.fail('the stream handed over no recording');
            buf += new TextDecoder().decode(value);
        }
        await reader.cancel();
        return JSON.parse(found[1]) as Step[];
    }

    // The bug this exists for: a step used to carry the view it was answered
    // under, so a resumed recording answered with the *last* run's view, and
    // restarting was the only way to change your mind. A step carries no view at
    // all now — it is what git did — so a kept recording is handed over exactly
    // as it was kept, whatever this run's flags say.
    it('hands a kept recording over untouched, and says separately what this run is', async () => {
        const repo = plumbedRepo();
        try {
            const plain = await serve(repo.dir, 0);
            const before = await watch(plain.port);
            await plain.close();

            const learning = await serve(repo.dir, 0, '127.0.0.1', true);
            try {
                const kept = await historyOf(learning.port);
                // Not re-answered and not re-recorded: restarting is not a step.
                assert.deepEqual(
                    kept.map((s) => s.seq),
                    before.map((s) => s.seq),
                );
                assert.deepEqual(kept.at(-1), before.at(-1));
                assert.equal((await recordingFrame(learning.port)).learning, true);
            } finally {
                await learning.close();
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
            assert.deepEqual(
                (await historyOf(second.port)).map((s) => s.seq),
                before.map((s) => s.seq),
            );
        } finally {
            await second.close();
        }
    });

    /**
     * Two gitva on one folder file under the same key, so both used to write the
     * same file from their own `seq` and leave a recording of a session that
     * never happened. The second one still draws every step — it is watching the
     * same repository — it simply is not the one keeping them.
     */
    it('lets a second gitva draw the repository without writing the recording', async () => {
        const repo = plumbedRepo();
        const first = await serve(repo.dir, 0);
        try {
            assert.equal((await watch(first.port)).length, 1, 'the step the holder recorded');
            const second = await serve(repo.dir, 0);
            try {
                repo.write('f.txt', 'zeta\n');
                repo.git('hash-object', '-w', 'f.txt');
                assert.deepEqual(
                    (await watch(second.port)).map((s) => s.seq),
                    [1, 2],
                    'the kept step, then the one it watched happen',
                );
            } finally {
                await second.close();
            }
        } finally {
            await first.close();
        }
        // One sequence on disk, not two interleaved: only the holder wrote it.
        const kept = await loadRecording(recordingFile(recordingKey(resolve(repo.dir))));
        assert.deepEqual(
            kept.steps.map((s) => (JSON.parse(s) as Step).seq),
            [1, 2],
        );
        repo.dispose();
    });

    // Letting go is the last thing it does. A step still being built when the
    // process is asked to stop would otherwise be written to the recording after
    // the next gitva has taken it, and both would be numbering into that file.
    it('finishes the step it was building before it lets go of the recording', async () => {
        const repo = plumbedRepo();
        const file = recordingFile(recordingKey(resolve(repo.dir)));
        const server = await serve(repo.dir, 0);
        // A browser arriving before the poller has anything is what asks for the
        // first step, so by the time the headers are back it is being built.
        const res = await fetch(`http://127.0.0.1:${server.port}/events`);
        await server.close();
        const written = readFileSync(file, 'utf8');
        await res.body?.cancel();
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(readFileSync(file, 'utf8'), written, 'and writes nothing after');
        repo.dispose();
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
