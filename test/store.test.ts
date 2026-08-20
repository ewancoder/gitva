/**
 * The recording that outlives the process. The point of it is that restarting
 * gitva on a repository does not throw away what the session recorded, so the
 * cases that matter are: it comes back, it comes back filed under the same
 * name, and nothing about it can stop the server drawing.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { lastSeq, loadRecording, recordingFile, recordingKey, saveRecording, stateDir } from '../src/store.js';

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
    assert.equal(stateDir({ GITVA_STATE_DIR: '/tmp/anywhere', XDG_STATE_HOME: '/x' }, 'linux'), '/tmp/anywhere');
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
    assert.deepEqual(await loadRecording(file), { signal: 'abc', steps: ['{"seq":1}', '{"seq":2}'] });
    assert.equal(lastSeq((await loadRecording(file)).steps), 2);
  });

  it('starts a fresh one rather than dying on nothing, or on nonsense', async () => {
    assert.deepEqual(await loadRecording(join(dir, 'never-written.json')), { signal: '', steps: [] });
    const bad = join(dir, 'half-written.json');
    writeFileSync(bad, '{"signal":"a","steps":[{"seq":1}');
    assert.deepEqual(await loadRecording(bad), { signal: '', steps: [] });
    // Written by something that meant something else by the same filename.
    writeFileSync(bad, '{"signal":"a"}');
    assert.deepEqual(await loadRecording(bad), { signal: '', steps: [] });
    // Steps and no signal is not nonsense: it means every step is still there
    // and the repository has to be looked at again to know where it stands.
    writeFileSync(bad, '{"steps":[{"seq":4}]}');
    assert.deepEqual(await loadRecording(bad), { signal: '', steps: ['{"seq":4}'] });
    // A recording that never began is step zero, not step NaN.
    assert.equal(lastSeq([]), 0);
    assert.equal(lastSeq(['{}']), 0);
  });

  it('writes the newest state in one move, so a kill costs one step at most', async () => {
    const file = join(dir, 'atomic.json');
    await saveRecording(file, { signal: 'a', steps: ['{"seq":1}'] });
    await saveRecording(file, { signal: 'b', steps: ['{"seq":1}', '{"seq":2}'] });
    // No leftover half-file beside it, and the whole of the last write is there.
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).steps.length, 2);
    assert.throws(() => readFileSync(`${file}.tmp`, 'utf8'));
  });

  it('says nothing and carries on when it cannot be written at all', async () => {
    const wall = join(dir, 'a-file-not-a-directory');
    writeFileSync(wall, 'in the way');
    // Drawing the repository matters; keeping the recording is a convenience.
    await saveRecording(join(wall, 'nope.json'), { signal: '', steps: [] });
  });
});
