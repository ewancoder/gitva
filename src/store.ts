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
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Steps as the server holds them — already serialised — and the change signal
 *  they were built at, so a restart onto an untouched repository does not
 *  record a step for nothing having happened. */
export interface Kept {
  signal: string;
  steps: string[];
}

/** Where the system keeps state a program owns. `GITVA_STATE_DIR` overrides,
 *  which is also how the tests keep out of the real one. */
export function stateDir(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  if (env.GITVA_STATE_DIR) return env.GITVA_STATE_DIR;
  if (platform === 'win32')
    return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'gitva');
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'gitva');
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'gitva');
}

/** Long enough that two of a person's repositories will not land on the same
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
 * `--id teaching` is still a name a person can choose and remember.
 */
export function recordingKey(id: string): string {
  return KEY.test(id) ? id : createHash('sha1').update(id).digest('hex').slice(0, KEY_CHARS);
}

export function recordingFile(key: string, dir: string = stateDir()): string {
  return join(dir, `${key}.json`);
}

export async function loadRecording(file: string): Promise<Kept> {
  try {
    const kept = JSON.parse(await readFile(file, 'utf8')) as { signal?: string; steps: unknown[] };
    // Back to text, because text is how the server holds a step and how it
    // sends one.
    return { signal: String(kept.signal ?? ''), steps: kept.steps.map((s) => JSON.stringify(s)) };
  } catch {
    // Nothing kept yet, half-written, or written by a version that wrote
    // something else: a fresh recording always works.
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
    await writeFile(`${file}.tmp`, `{"signal":${JSON.stringify(kept.signal)},"steps":[${kept.steps.join(',')}]}`);
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
