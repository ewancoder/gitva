/**
 * The recording that outlives the process. The point of it is that restarting
 * gitva on a repository does not throw away what the session recorded, so the
 * cases that matter are: it comes back, it comes back filed under the same
 * name, and nothing about it can stop the server drawing.
 */

import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    utimesSync,
    writeFileSync,
} from 'node:fs';
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
    /** A lock file as a crashed gitva leaves one: its name in it, then never
     *  touched again. */
    function abandoned(file: string, secondsAgo: number) {
        writeFileSync(file, 'the gitva that died');
        stopped(file, secondsAgo);
    }

    /** As if nothing had beaten on it for that long. */
    function stopped(file: string, secondsAgo: number) {
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

    /**
     * Two gitva starting on a repository somebody is already watching. Taking the
     * lock means moving it aside before asking whose it is, so for the length of
     * that question the file is not there — and a second contender starting inside
     * it takes it cleanly. Putting the original back by renaming used to land on
     * top of that one: two processes then believed they held the recording, and
     * both wrote it, until the next beat put one right. Repeated, because the
     * window is a real one rather than one a test can stand in.
     */
    it('never hands two gitva the recording at once', async () => {
        for (let i = 0; i < 400; i++) {
            const file = lockFile(`contended-${i}`, dir);
            abandoned(file, 0);
            const both = await Promise.all([takeLock(file), takeLock(file)]);
            const held = both.filter((l) => l?.held);
            // Whoever holds it is the name in the file; if it still says the gitva
            // that was there, nobody else may be writing the recording.
            if (readFileSync(file, 'utf8') === 'the gitva that died')
                assert.deepEqual(held, [], `round ${i}: a lock taken out from under a live holder`);
            else assert.equal(held.length, 1, `round ${i}: two gitva holding one recording`);
            for (const lock of both) await lock?.release();
            rmSync(file, { force: true });
        }
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
            stopped(file, 60); // as if the holder had gone quiet a minute ago
            await new Promise((r) => setTimeout(r, 50));
            assert.equal(await takeLock(file), null, 'beaten on since, so still held');
        } finally {
            await lock.release();
        }
    });

    // Clearing the state directory mid-session is a thing people do. The beat
    // has nothing left to touch, and a throw out of a timer takes the process
    // with it — so it does not throw. `saveRecording` makes the directory again
    // on the next step, so the lock goes back beside it: a recording being
    // written with nothing saying who by is how two gitva end up writing it.
    it('puts its lock back when the file is taken away underneath it', async () => {
        const file = lockFile('swept-away', dir);
        const lock = await takeLock(file, 5);
        assert.ok(lock);
        rmSync(file);
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(lock.held, true, 'still writing the recording');
        assert.equal(await takeLock(file), null, 'and still nobody else is');
        await lock.release();
    });

    // And the folder goes as often as the file does: `rm -rf` on the state
    // directory took the lock with it, and the beat had nowhere to put a name
    // back — so the run stopped writing the recording for good, quietly, even
    // once `saveRecording` had made the directory again.
    it('puts its lock back when the whole state directory goes', async () => {
        const gone = join(dir, 'swept-away-entirely');
        mkdirSync(gone, { recursive: true });
        const file = lockFile('k', gone);
        const lock = await takeLock(file, 5);
        assert.ok(lock);
        rmSync(gone, { recursive: true });
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(lock.held, true, 'still the one keeping the recording');
        assert.equal(existsSync(file), true, 'and its name is back beside it');
        await lock.release();
        rmSync(gone, { recursive: true });
    });

    // The other way the file can go: swept away, and another gitva through the
    // door before the beat came round. Nothing to put back, and nothing to write.
    it('stops writing when the lock it lost went to somebody else', async () => {
        const file = lockFile('gone-to-another', dir);
        const lock = await takeLock(file, 5);
        assert.ok(lock);
        rmSync(file);
        const next = await takeLock(file);
        assert.ok(next, 'nothing was holding it');
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(lock.held, false, 'the first one may no longer save');
        await lock.release();
        assert.equal(existsSync(file), true, 'and let go of nothing');
        await next.release();
    });

    // Two gitva started on a lock a crash left behind both find it stale. The
    // taking is a rename, so exactly one of them can move the file that is
    // there — before this, both removed it and both wrote it, and two processes
    // numbered steps into the same recording.
    it('hands a stale lock to one of the two gitva that find it', async () => {
        const file = lockFile('both-found-it-stale', dir);
        for (let attempt = 0; attempt < 20; attempt++) {
            abandoned(file, 60);
            // Straight away, with no beat to settle it: whichever way the two
            // interleave, one of them was told no before it wrote anything.
            const taken = await Promise.all([takeLock(file, 60_000), takeLock(file, 60_000)]);
            assert.equal(
                taken.filter((l) => l !== null).length,
                1,
                'one gitva keeps the recording, never both',
            );
            for (const lock of taken) await lock?.release();
        }
    });

    // The other order: one gitva has already taken the stale lock over, and the
    // second is still on its way in. It moves a lock that has become somebody's
    // since it last looked, so it puts it back rather than take it over.
    it('gives a lock back to the gitva that took it over first', async () => {
        const file = lockFile('taken-over-already', dir);
        abandoned(file, 60);
        const first = await takeLock(file, 60_000);
        assert.ok(first);
        const written = readFileSync(file, 'utf8');
        assert.equal(await takeLock(file), null, "the recording is the first one's");
        assert.equal(readFileSync(file, 'utf8'), written, 'and its lock is where it left it');
        assert.equal(first.held, true);
        await first.release();
    });

    // Both halves of the taking are somebody else's to lose: the file moved out
    // of the way, and the file put back. Whichever goes to another gitva, this
    // one draws without keeping what it draws.
    it('leaves a stale lock to whoever got to it first', async () => {
        const file = lockFile('someone-got-there-first', dir);
        abandoned(file, 60);
        // Nothing can move the dead lock aside, exactly as if another gitva had
        // already moved it: the taking is not this one's to finish.
        mkdirSync(join(`${file}.dead`, 'in the way'), { recursive: true });
        assert.equal(await takeLock(file), null, 'held, and by then it is');
        rmSync(`${file}.dead`, { recursive: true });
        rmSync(file);
    });

    // A laptop lid closed for a minute is a holder presumed dead: the recording
    // is taken off it while it is stopped. Waking up, it must not beat on, write
    // over, or remove the lock of the gitva that has it now.
    it('lets go of a lock that was taken over while it was stopped', async () => {
        const file = lockFile('taken-over', dir);
        const lock = await takeLock(file, 5);
        assert.ok(lock);
        writeFileSync(file, 'the gitva that took over');
        stopped(file, 60);
        const untouched = statSync(file).mtimeMs;
        await new Promise((r) => setTimeout(r, 30));
        assert.equal(lock.held, false, 'and it knows it may no longer save');
        assert.equal(statSync(file).mtimeMs, untouched, 'not beaten on');
        await lock.release();
        assert.equal(readFileSync(file, 'utf8'), 'the gitva that took over', 'not removed');
        rmSync(file);
    });

    // The beat is not the only moment ownership can change: one that changed
    // hands a millisecond ago is not this one's to remove, and the file is the
    // only thing that says whose it is.
    it('checks whose the lock is as it lets go, not when it last looked', async () => {
        const file = lockFile('changed-hands', dir);
        const lock = await takeLock(file, 60_000); // no beat comes round in this test
        assert.ok(lock);
        writeFileSync(file, 'the gitva that took over');
        await lock.release();
        assert.equal(readFileSync(file, 'utf8'), 'the gitva that took over', 'left alone');
        rmSync(file);
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

    // Nothing to check whose it is, and nothing to remove: the state directory
    // went while this gitva was still in it.
    it('lets go quietly when the lock file is gone already', async () => {
        const file = lockFile('nothing-to-let-go-of', dir);
        const lock = await takeLock(file, 60_000); // no beat comes round to put it back
        assert.ok(lock);
        rmSync(file);
        await lock.release();
        assert.equal(existsSync(file), false);
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
