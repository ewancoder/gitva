/**
 * The server: asks git the cheap question on a timer, does real work only when
 * the answer moves, and pushes whole steps down a server-sent-events stream.
 *
 * It is the source of truth and the only writer. Nothing a browser does reaches
 * here — there is no route that changes what is recorded — because a step is
 * what git did, and a view is how you look at it. A step therefore carries
 * everything any view could want to draw.
 *
 * No delta protocol. A bounded window is what makes whole steps permanently
 * affordable, and whole steps are what make the diffing and the replay simple.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    GitError,
    changeSignal,
    measure,
    open,
    readBody,
    readStep,
    type Repository,
} from './git.js';
import {
    lastSeq,
    loadRecording,
    lockFile,
    recordingFile,
    recordingKey,
    saveRecording,
    takeLock,
} from './store.js';
import type { Capabilities } from './types.js';
import { RECORDING_CAP } from './types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.map': 'application/json',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
};

const POLL_MS = 400;

/**
 * What the shared recording is allowed to weigh. Measured: a step of a repository
 * small enough to teach on is about 12 KB, so all 400 of them are a few
 * megabytes; a step of one with a few thousand objects is a couple of
 * megabytes on its own, and 400 of those is not something to hand a browser
 * that has just opened. Bytes are the ceiling that bites first, so bytes are
 * the ceiling — a shorter tail rather than a delta protocol.
 */
const RECORDING_BYTES = 16 << 20;

export interface Server {
    port: number;
    close(): Promise<void>;
}

export async function serve(
    repoPath: string,
    port = 0,
    host = '127.0.0.1',
    learning = false,
    id?: string,
    fresh = false,
): Promise<Server> {
    // The recording belongs to the repository, so it outlives the process: the
    // full path of the folder identifies it, unless `--id` named something that
    // travels — the same repository cloned somewhere else, or moved. The browser
    // is shown the key and copies it on a click, so `--id` can be handed it back.
    const key = recordingKey(id ?? resolve(repoPath));
    const file = recordingFile(key);
    // `--fresh`: start the recording over. Throwing the kept steps away is the
    // presenter's call at startup, not a button any viewer can reach — the
    // recording is shared, so one browser must not be able to end everyone's
    // session. The file is overwritten by the first step of this run.
    const kept = fresh ? { signal: '', steps: [] } : await loadRecording(file);
    // One gitva writes a recording at a time. Forgetting that one is already
    // watching this folder used to leave two processes numbering steps from
    // their own `seq` into the same file, and a viewer resuming it saw a session
    // that never happened. A second gitva draws exactly as before — it simply
    // does not keep what it drew, and nothing ever waits for the first to finish.
    const lock = await takeLock(lockFile(key));
    if (!lock)
        process.stdout.write(
            `another gitva is already recording this repository (${key}) — this run will not be saved\n`,
        );
    // The repository need not exist yet: `gitva` in an empty directory waits for
    // `git init`, so the very first plumbing command the tutorial teaches can be
    // watched happening rather than assumed to have happened already.
    let opened: { handle: Repository; capabilities: Capabilities } | null = null;
    async function repository() {
        if (!opened) {
            const handle = await open(repoPath).catch(() => {
                throw new GitError(`no repository at ${repoPath} yet — waiting for \`git init\``);
            });
            opened = { handle, capabilities: await measure(handle.repo, handle.gitDir) };
        }
        return opened;
    }

    let seq = lastSeq(kept.steps);
    /** Every step of the repository, oldest first, already serialised — not
     *  just the newest one. A browser opened halfway through a session gets the
     *  whole thing on connect, so every viewer can walk the same steps.
     *  Kept as text because that is what it is sent as, and what it is measured
     *  by, and it survives a restart: see `store.ts`. Nothing here looks inside a
     *  step, bar the step number a restart carries on from. */
    const steps: string[] = kept.steps;
    // Kept with the steps: an untouched repository is not a step, so a restart
    // that changed nothing adds nothing.
    let signal = kept.signal;
    const clients = new Set<ServerResponse>();

    /** Rebuilds run one at a time. Anything arriving mid-build asks for one more
     * pass; further requests join that pass instead of growing an unbounded queue. */
    let pending = false;
    let building: Promise<boolean> | null = null;
    /** Resolves to whether the last pass recorded a step, so the caller can tell
     *  a change that was drawn from one that has still to be tried again. */
    function build(): Promise<boolean> {
        pending = true;
        building ??= drain();
        return building;
    }

    async function drain() {
        // A drain that ended without clearing this would be handed to every future
        // caller, and nothing would ever rebuild again.
        let recorded = false;
        try {
            while (pending) {
                pending = false;
                recorded = await rebuild();
            }
        } finally {
            building = null;
        }
        return recorded;
    }

    /** `seq` counts steps of the repository, and only git moves it: every
     *  rebuild there is is a step, because only a change signal asks for one. */
    async function rebuild() {
        // The step is built before the number is taken: git can fail against a
        // repository mid-rebase or with a half-written index, and a `seq` spent on
        // an attempt nobody ever saw is a gap in the shared recording.
        let recorded = false;
        try {
            const { handle, capabilities } = await repository();
            const s = JSON.stringify(await readStep(handle, capabilities, seq + 1));
            seq++;
            record(steps, s);
            recorded = true;
            const frame = `event: step\ndata: ${s}\n\n`;
            for (const c of clients) c.write(frame);
            if (lock) await saveRecording(file, { signal, steps: steps });
        } catch (err) {
            const frame = `event: trouble\ndata: ${JSON.stringify({ message: String(err) })}\n\n`;
            for (const c of clients) c.write(frame);
        }
        return recorded;
    }

    // The overwhelmingly common case is "nothing happened", and it costs one
    // for-each-ref, one count-objects and one stat.
    //
    // It is asked whether anyone is watching or not: the recording is the repository's,
    // not one browser's, and a step nobody was connected for cannot be
    // reconstructed later —
    // the repository has moved on. Typing ten plumbing commands and *then*
    // opening the browser has to show ten steps.
    async function poll() {
        try {
            const { handle } = await repository();
            const next = await changeSignal(handle.repo, handle.gitDir);
            if (next === signal) return;
            // The signal is only committed once the change it stands for was drawn.
            // Moving it first would step past a change git happened to fail on, and
            // that change is gone for good — the repository has moved on and the
            // next step would diff against a state nobody ever saw. `build()`
            // collapses callers, so a failing repository retries once a tick.
            const previous = signal;
            signal = next;
            if (!(await build())) signal = previous;
        } catch {
            /* no repository yet, or one mid-rewrite: try again on the next tick */
        }
    }
    const timer = setInterval(() => void poll(), POLL_MS);
    timer.unref?.();

    async function route(req: IncomingMessage, res: ServerResponse) {
        const url = new URL(req.url ?? '/', 'http://localhost');
        try {
            if (url.pathname === '/events') return sse(req, res);
            if (url.pathname === '/object') return await object(url, res);
            return await statik(url.pathname, res);
        } catch (err) {
            res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
        }
    }
    const server = createServer((req, res) => void route(req, res));

    function sse(req: IncomingMessage, res: ServerResponse) {
        res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
        });
        res.write(': hello\n\n');
        // Which recording this is, and whether this run is a demonstration. Neither
        // is part of a step: the identifier is a fact about the recording, and
        // `--learning` is a fact about the run — the presenter saying every commit
        // should arrive expanded, for whoever is watching, including a viewer who
        // scrubs back to a step recorded before they said so.
        res.write(`event: recording\ndata: ${JSON.stringify({ id: key, learning })}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        // The whole recording in one frame; `step` stays the live tail, so the
        // client replays once instead of deciding per step what to animate.
        if (steps.length) res.write(`event: steps\ndata: [${steps.join(',')}]\n\n`);
        else void first();
    }

    /**
     * Every client waiting for the first step shares the same read — but only
     * while it is in flight. A read that found no repository yet leaves nothing
     * to hand the next arrival, and the poller stays quiet until the signal moves,
     * so a later browser has to be allowed to ask again and be told the same
     * thing: `gitva` in an empty directory is waiting for `git init`.
     */
    let initial: Promise<void> | null = null;
    function first(): Promise<void> {
        return (initial ??= firstBuild().finally(() => {
            initial = null;
        }));
    }

    async function firstBuild() {
        signal = await repository()
            .then(({ handle }) => changeSignal(handle.repo, handle.gitDir))
            .catch(() => signal);
        await ensureFirstStep(
            building,
            () => steps.length > 0,
            () => build(),
        );
    }

    async function object(url: URL, res: ServerResponse) {
        const oid = url.searchParams.get('oid') ?? '';
        if (!/^[0-9a-f]{4,64}$/.test(oid)) return res.writeHead(400).end('bad oid');
        const body = await readBody((await repository()).handle, oid);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    }

    async function statik(pathname: string, res: ServerResponse) {
        const file =
            pathname === '/' || pathname === '/index.html'
                ? 'web/index.html'
                : // Shipped beside index.html, not compiled, so it is served from source too.
                  pathname === '/favicon.png'
                  ? 'web/favicon.png'
                  : // Subfolders count: `web/localization/languages/en.js` is loaded by
                    // the page exactly as `web/app.js` is. `..` is refused outright
                    // rather than resolved — the roots are the whole permission.
                    /^\/(web|src)\/(?:[\w.-]+\/)*[\w.-]+$/.test(pathname) &&
                      !pathname.split('/').includes('..')
                    ? `dist${pathname}`
                    : null;
        if (!file) return res.writeHead(404).end('not found');
        try {
            const data = await readFile(ROOT + file);
            res
                // Rebuild, reload, see the change: without this a browser is free to
                // keep yesterday's module and the edit never reaches the screen.
                .writeHead(200, {
                    'content-type': MIME[extname(file)] ?? 'application/octet-stream',
                    'cache-control': 'no-cache',
                })
                .end(data);
        } catch {
            res.writeHead(404).end('not found');
        }
    }

    await new Promise<void>((r) => server.listen(port, host, r));
    const address = server.address();
    const bound = typeof address === 'object' && address ? address.port : port;

    return {
        port: bound,
        async close() {
            clearInterval(timer);
            await lock?.release();
            for (const c of clients) c.end();
            await new Promise<void>((r) => server.close(() => r()));
        },
    };
}

/**
 * The shared recording. Every step git made, in order, with the oldest falling
 * off the far end at the cap the browser's own recording uses or at `RECORDING_BYTES`,
 * whichever the repository reaches first.
 */
export function record(steps: string[], step: string): void {
    steps.push(step);
    let bytes = steps.reduce((n, s) => n + s.length, 0);
    // Whichever ceiling is reached first. The newest step is never dropped: on
    // a repository big enough to be over the budget on its own, a browser that
    // joins is still owed the canvas everyone else is looking at.
    while (steps.length > 1 && (steps.length > RECORDING_CAP || bytes > RECORDING_BYTES)) {
        bytes -= steps.shift()!.length;
    }
}

/** A poll may answer while the first client is measuring the repository. */
export async function ensureFirstStep(
    active: Promise<unknown> | null,
    hasStep: () => boolean,
    build: () => Promise<unknown>,
): Promise<void> {
    if (active) await active;
    if (!hasStep()) await build();
}
