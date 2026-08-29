/**
 * The recording, kept between runs. A recording belongs to the repository, so
 * restarting gitva on the same folder picks the same one up rather than
 * starting the tutorial over.
 *
 * None of it goes anywhere near the repository being watched — that stays
 * read-only, and a tool that littered `.git` while teaching what is in `.git`
 * would be teaching the wrong thing. It goes where the system keeps a
 * program's own state, one file per identifier.
 */

import { createHash } from 'node:crypto';
import { utimesSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
// The node one, so `unref()` is simply there: `lib.dom` makes the global's
// return type a union, and this file is the server's alone.
import { setInterval } from 'node:timers';

/** Steps as the server holds them — already serialised — and the change signal
 *  they were built at, so a restart onto an untouched repository does not
 *  record a step for nothing having happened. */
export interface Kept {
    signal: string;
    steps: string[];
}

/**
 * What a step means. Bumped whenever an old step would be drawn wrongly rather
 * than merely differently, and a recording written under another number is
 * dropped instead of half-drawn.
 *
 * 2: a step carries everything any view could draw. Under 1 it carried only the
 * trees the one shared view happened to have expanded, so on a repository too
 * big to hold whole, expanding a commit in a kept step would silently draw
 * nothing — there is no longer a route for the browser to ask for the rest.
 *
 * 3: a step says `capabilities`, not `caps`. The same facts under the domain's
 * own word — but a step read under the old name loses its limits, and a canvas
 * that cannot tell whether unreachable detection was on would draw a repository
 * as having nothing unreachable in it.
 */
export const FORMAT = 6;

/** Where the system keeps state a program owns. `GITVA_STATE_DIR` overrides,
 *  which is also how the tests keep out of the real one. */
export function stateDir(
    env: NodeJS.ProcessEnv = process.env,
    platform: string = process.platform,
): string {
    if (env.GITVA_STATE_DIR) return env.GITVA_STATE_DIR;
    if (platform === 'win32')
        return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'gitva');
    if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'gitva');
    return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'gitva');
}

/** Long enough that two of your repositories will not land on the same
 *  one, short enough to read out, copy, and type after `--id`. */
const KEY_CHARS = 10;
const KEY = new RegExp(`^[0-9a-f]{${KEY_CHARS}}$`);

/**
 * What a recording is filed under: the sha of the identifier, which is the
 * repository's full path unless `--id` named something else. A path is not a
 * filename and half a path is not an identifier, so the whole thing is hashed
 * and nothing else goes in the name.
 *
 * A key is an identifier too. That is what makes the one the interface shows
 * you worth copying: `--id` takes it back verbatim, so the same recording is
 * resumable from a folder that has moved, or from a second clone — while
 * `--id teaching` is still a name you can choose and remember.
 */
export function recordingKey(id: string): string {
    return KEY.test(id) ? id : createHash('sha1').update(id).digest('hex').slice(0, KEY_CHARS);
}

export function recordingFile(key: string, dir: string = stateDir()): string {
    return join(dir, `${key}.json`);
}

export async function loadRecording(file: string): Promise<Kept> {
    try {
        const kept = JSON.parse(await readFile(file, 'utf8')) as {
            format?: number;
            signal?: string;
            steps: unknown[];
        };
        // Steps that mean something else are steps this version cannot draw. Better
        // to start the recording over — which is what a viewer would see anyway —
        // than to hand over a step with holes in it and let the canvas lie.
        if (kept.format !== FORMAT) return { signal: '', steps: [] };
        // Back to text, because text is how the server holds a step and how it
        // sends one.
        return {
            signal: String(kept.signal ?? ''),
            steps: kept.steps.map((s) => JSON.stringify(s)),
        };
    } catch {
        // Nothing kept yet, or half-written: a fresh recording always works.
        return { signal: '', steps: [] };
    }
}

export async function saveRecording(file: string, kept: Kept): Promise<void> {
    try {
        await mkdir(dirname(file), { recursive: true });
        // ponytail: the whole recording is rewritten per step. It is bounded by the
        // server's own cap on it and only happens when git did something, so a few
        // megabytes at worst, a few times a minute. Append instead if it ever shows
        // up in a profile.
        await writeFile(
            `${file}.tmp`,
            `{"format":${FORMAT},"signal":${JSON.stringify(kept.signal)},"steps":[${kept.steps.join(',')}]}`,
        );
        // Renamed into place so a kill mid-write costs the newest step, not the
        // whole session.
        await rename(`${file}.tmp`, file);
    } catch {
        // A recording that cannot be written down is not a reason to stop drawing.
    }
}

/** Where the kept recording left off. A restart carries on numbering steps of
 *  the repository rather than renumbering over ones the browser already has. */
export function lastSeq(steps: string[]): number {
    return steps.length ? ((JSON.parse(steps[steps.length - 1]) as { seq: number }).seq ?? 0) : 0;
}

/**
 * How often the holder touches its lock, and how old a lock has to be before
 * its holder is presumed dead. `POLL_MS` in `server.ts` is 400 ms, so a beat a
 * second is unhurried, and ten beats of slack means an ordinary scheduling
 * hiccup — or a laptop lid — never makes a live gitva look dead.
 */
const HEARTBEAT_MS = 1_000;
const STALE_MS = 10 * HEARTBEAT_MS;

export function lockFile(key: string, dir: string = stateDir()): string {
    return join(dir, `${key}.lock`);
}

/** What holding the recording gets you: the right to write it, until you let go. */
export interface Lock {
    release(): Promise<void>;
}

/** Takes the file, or answers that a live gitva is holding it. Throws only for
 *  a reason that is the disk's rather than anybody's. */
async function claim(file: string): Promise<boolean> {
    await mkdir(dirname(file), { recursive: true });
    try {
        // Exclusive, so two gitva starting on the same instant cannot both
        // believe they took it.
        await writeFile(file, '', { flag: 'wx' });
        return true;
    } catch {
        // Fresh means another gitva is alive and beating on it.
        if (Date.now() - (await stat(file)).mtimeMs < STALE_MS) return false;
        // Stale: the holder died without letting go, which is what a crash or a
        // `kill -9` leaves behind. Unlink and retake — two processes arriving on
        // this instant could still both take it, and the cost of that is an
        // incoherent recording, never anything in the repository.
        await rm(file, { force: true });
        await writeFile(file, '', { flag: 'wx' });
        return true;
    }
}

/**
 * One gitva writes a recording at a time. A second one still draws — it just
 * does not persist — so nothing ever waits and there is no deadlock to have.
 *
 * `null` means a live gitva is holding it. A lock is handed back even when the
 * file could not be written at all, because that is the disk being unwritable
 * rather than the recording being taken, and a recording that cannot be kept
 * has never been a reason to stop drawing.
 */
export async function takeLock(file: string, beatMs = HEARTBEAT_MS): Promise<Lock | null> {
    try {
        if (!(await claim(file))) return null;
    } catch {
        return { release: async () => {} };
    }
    // The heartbeat is the whole difference between a holder that is alive and
    // one that died: without it a gitva left running through a lecture would
    // look dead a few seconds in. Unref'd, as the server's poll timer is, so it
    // cannot hold the process open by itself.
    const beat = setInterval(() => {
        try {
            const now = new Date();
            utimesSync(file, now, now);
        } catch {
            // The lock went out from under us. Anything to do about that is a
            // protocol, and the point of this one is that it never waits.
        }
    }, beatMs);
    beat.unref();
    return {
        async release() {
            clearInterval(beat);
            await rm(file, { force: true });
        },
    };
}
