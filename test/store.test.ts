/**
 * The recording that outlives the process. The point of it is that restarting
 * gitva on a repository does not throw away what the session recorded, so the
 * cases that matter are: it comes back, it comes back filed under the same
 * name, and nothing about it can stop the server drawing.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
    FORMAT,
    lastSeq,
    loadRecording,
    lockFile,
    recordingFile,
    recordingKey,
    saveRecording,
    stateDir,
    takeLock,
} from '../src/store.js';

const dir = mkdtempSync(join(tmpdir(), 'gitva-store-'));
after(() => rmSync(dir, { recursive: true, force: true }));

describe('where a recording is kept', () => {
    it('is the state directory the system keeps for a program, per platform', () => {
        assert.equal(stateDir({ XDG_STATE_HOME: '/x' }, 'linux'), '/x/gitva');
        assert.match(stateDir({}, 'linux'), /\.local\/state\/gitva$/);
        assert.equal(stateDir({ LOCALAPPDATA: 'C:\\s' }, 'win32'), 'C:\\s/gitva');
        assert.match(stateDir({}, 'win32'), /AppData.Local.gitva$/);
        assert.match(stateDir({}, 'darwin'), /Library.Application Support.gitva$/);
    });

    it('lets the environment say, which is how the tests stay out of the real one', () => {
        assert.equal(
            stateDir({ GITVA_STATE_DIR: '/tmp/anywhere', XDG_STATE_HOME: '/x' }, 'linux'),
            '/tmp/anywhere',
        );
        // And it is this process's environment that is read when nobody says.
        const was = process.env.GITVA_STATE_DIR;
        process.env.GITVA_STATE_DIR = dir;
        try {
            assert.equal(stateDir(), dir);
            assert.equal(recordingFile('x').startsWith(dir), true);
        } finally {
            if (was === undefined) delete process.env.GITVA_STATE_DIR;
            else process.env.GITVA_STATE_DIR = was;
        }
    });

    it('keys a recording by the whole identifier, and only by that', () => {
        const a = recordingKey('/home/you/projects/gitva');
        assert.match(a, /^[0-9a-f]{10}$/);
        // Paths a shorter name would have run together are separate recordings.
        assert.notEqual(recordingKey('/home/you-projects/gitva'), a);
        assert.notEqual(recordingKey('/home/you/projects/gitva/'), a);
        // An identifier need not be a path: `--id` is whatever was typed.
        assert.match(recordingKey('teaching'), /^[0-9a-f]{10}$/);
        // However long or however odd, a key comes out the same length.
        assert.equal(recordingKey('/a'.repeat(500)).length, 10);
        assert.equal(recordingKey('///').length, 10);
        assert.equal(recordingFile(a, dir), join(dir, `${a}.json`));
    });

    // The interface shows the key and copies it on a click, which is only worth
    // doing if handing it back to `--id` reaches the same recording.
    it('takes a key back as an identifier, so the one it shows you resumes it', () => {
        const key = recordingKey('/home/you/projects/gitva');
        assert.equal(recordingKey(key), key);
        // Not any hex-looking thing, though: a name of the wrong length is a name.
        assert.notEqual(recordingKey('deadbeef'), 'deadbeef');
        assert.notEqual(recordingKey('0123456789a'), '0123456789a');
    });
});

describe('keeping the recording', () => {
    it('hands back the steps and the signal it was told', async () => {
        const file = join(dir, 'round-trip.json');
        await saveRecording(file, { signal: 'abc', steps: ['{"seq":1}', '{"seq":2}'] });
        assert.deepEqual(await loadRecording(file), {
            signal: 'abc',
            steps: ['{"seq":1}', '{"seq":2}'],
        });
        assert.equal(lastSeq((await loadRecording(file)).steps), 2);
    });

    it('starts a fresh one rather than dying on nothing, or on nonsense', async () => {
        assert.deepEqual(await loadRecording(join(dir, 'never-written.json')), {
            signal: '',
            steps: [],
        });
        const bad = join(dir, 'half-written.json');
        writeFileSync(bad, '{"signal":"a","steps":[{"seq":1}');
        assert.deepEqual(await loadRecording(bad), { signal: '', steps: [] });
        // Written by something that meant something else by the same filename.
        writeFileSync(bad, `{"format":${FORMAT},"signal":"a"}`);
        assert.deepEqual(await loadRecording(bad), { signal: '', steps: [] });
        // Steps and no signal is not nonsense: it means every step is still there
        // and the repository has to be looked at again to know where it stands.
        writeFileSync(bad, `{"format":${FORMAT},"steps":[{"seq":4}]}`);
        assert.deepEqual(await loadRecording(bad), { signal: '', steps: ['{"seq":4}'] });
        // A recording that never began is step zero, not step NaN.
        assert.equal(lastSeq([]), 0);
        assert.equal(lastSeq(['{}']), 0);
    });

    // The steps are the same JSON either way, so nothing here can tell an old
    // step from a new one by looking at it. Under format 1 a step on a repository
    // too big to hold whole carried only the trees the one shared view had
    // expanded, and expanding a commit in one of those steps would now draw
    // nothing at all: there is no route left for the browser to ask for the rest.
    // Starting the recording over is the honest answer.
    it('does not resume a recording that means something else by a step', async () => {
        const file = join(dir, 'older-format.json');
        writeFileSync(file, '{"signal":"a","steps":[{"seq":1},{"seq":2}]}'); // format 1: no field
        assert.deepEqual(await loadRecording(file), { signal: '', steps: [] });
        writeFileSync(file, '{"format":99,"signal":"a","steps":[{"seq":1}]}');
        assert.deepEqual(await loadRecording(file), { signal: '', steps: [] });

        // And what this version writes is what this version reads back.
        await saveRecording(file, { signal: 'a', steps: ['{"seq":1}'] });
        assert.equal((JSON.parse(readFileSync(file, 'utf8')) as { format: number }).format, FORMAT);
        assert.deepEqual(await loadRecording(file), { signal: 'a', steps: ['{"seq":1}'] });
    });

    it('writes the newest step in one move, so a kill costs one step at most', async () => {
        const file = join(dir, 'atomic.json');
        await saveRecording(file, { signal: 'a', steps: ['{"seq":1}'] });
        await saveRecording(file, { signal: 'b', steps: ['{"seq":1}', '{"seq":2}'] });
        // No leftover half-file beside it, and the whole of the last write is there.
        assert.equal(
            (JSON.parse(readFileSync(file, 'utf8')) as { steps: string[] }).steps.length,
            2,
        );
        assert.throws(() => readFileSync(`${file}.tmp`, 'utf8'));
    });

    it('says nothing and carries on when it cannot be written at all', async () => {
        const wall = join(dir, 'a-file-not-a-directory');
        writeFileSync(wall, 'in the way');
        // Drawing the repository matters; keeping the recording is a convenience.
        await saveRecording(join(wall, 'nope.json'), { signal: '', steps: [] });
    });
});

/**
 * One gitva writes a recording at a time. Two watching the same folder — which
 * happens for the ordinary reason, you forgot one was running — used to number
 * steps from their own `seq` into the same file, and what was left of it was a
 * session that never happened. Nothing here ever waits: a second gitva draws,
 * it just does not keep what it drew.
 */
describe('holding the recording', () => {
    /** A lock file as a crashed gitva leaves one: written, then never touched again. */
    function abandoned(file: string, secondsAgo: number) {
        writeFileSync(file, '');
        const then = new Date(Date.now() - secondsAgo * 1000);
        utimesSync(file, then, then);
    }

    it('takes a lock nobody holds', async () => {
        const file = lockFile('nobody-holds-it', dir);
        const lock = await takeLock(file);
        assert.ok(lock, 'the recording was free');
        assert.equal(existsSync(file), true);
        await lock.release();
    });

    it('leaves a fresh lock alone and says so', async () => {
        const file = lockFile('held-by-another', dir);
        abandoned(file, 0);
        const before = readFileSync(file, 'utf8');
        assert.equal(await takeLock(file), null, 'the second gitva does not persist');
        // And it did not take it by force on the way past.
        assert.equal(readFileSync(file, 'utf8'), before);
        rmSync(file);
    });

    it('takes over a lock whose holder died', async () => {
        const file = lockFile('holder-died', dir);
        abandoned(file, 60);
        const lock = await takeLock(file);
        assert.ok(lock, 'a lock nothing is beating on is nobody holding it');
        await lock.release();
    });

    // The heartbeat is the whole difference between the two cases above: without
    // it a gitva left running through a lecture would look dead after ten seconds.
    it('keeps its own lock looking alive', async () => {
        const file = lockFile('still-here', dir);
        const lock = await takeLock(file, 5);
        assert.ok(lock);
        try {
            abandoned(file, 60); // as if the holder had gone quiet a minute ago
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(await takeLock(file), null, 'beaten on since, so still held');
        } finally {
            await lock.release();
        }
    });

    // Clearing the state directory mid-session is a thing people do. The beat
    // has nothing left to touch, and a throw out of a timer takes the process
    // with it — so it does not throw.
    it('carries on when its lock file is taken away underneath it', async () => {
        const file = lockFile('swept-away', dir);
        const lock = await takeLock(file, 5);
        assert.ok(lock);
        rmSync(file);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(existsSync(file), false, 'and it does not put it back');
        await lock.release();
    });

    it('lets go of the lock when it closes', async () => {
        const file = lockFile('let-go', dir);
        const lock = await takeLock(file);
        assert.ok(lock);
        await lock.release();
        assert.equal(existsSync(file), false);
        const next = await takeLock(file);
        assert.ok(next, 'the next gitva walks straight in');
        await next.release();
    });

    it('draws anyway when the lock cannot be written at all', async () => {
        const wall = join(dir, 'a-wall-not-a-directory');
        writeFileSync(wall, 'in the way');
        // Nobody is holding the recording — the disk is simply unwritable, and
        // `saveRecording` has always failed quietly rather than stop the canvas.
        const lock = await takeLock(join(wall, 'nope.lock'));
        assert.ok(lock, 'not held is not the same as unavailable');
        await lock.release();
    });
});
