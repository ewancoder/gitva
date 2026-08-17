/**
 * The command line. `gitva` in a repo is the whole installation story, so the
 * flags around it are few — and `--serve`, the one that puts a repository on
 * the network with no authentication in front of it, has to mean exactly what
 * it looks like it means.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { entryPath, main, parseArgs } from '../src/cli.js';
import { plumbedRepo } from './fixture.js';

describe('arguments', () => {
  it('watches the directory you are standing in, on a port the OS picks', () => {
    assert.deepEqual(parseArgs([]), { repo: '.', port: 0, host: '127.0.0.1', open: true });
  });

  it('takes a repository as the one positional argument', () => {
    assert.equal(parseArgs(['/tmp/x', '--no-open']).repo, '/tmp/x');
    assert.equal(parseArgs(['--no-open']).open, false);
  });

  it('takes a port, and stays on the loopback address with it', () => {
    const o = parseArgs(['--port', '4321']);
    assert.deepEqual([o.port, o.host], [4321, '127.0.0.1']);
  });

  it('opens onto every interface for a bare --serve, on a port that does not move', () => {
    assert.deepEqual(parseArgs(['--serve']), { repo: '.', port: 4200, host: '0.0.0.0', open: true });
  });

  it('takes an address for --serve, and a port on its own', () => {
    assert.deepEqual(parseArgs(['--serve', '10.0.0.2:9000']).host, '10.0.0.2');
    assert.equal(parseArgs(['--serve', '10.0.0.2:9000']).port, 9000);
    assert.deepEqual(parseArgs(['--serve', ':9000']).host, '0.0.0.0');
  });

  it('does not mistake the address it consumed for the repository', () => {
    assert.equal(parseArgs(['--serve', '10.0.0.2:9000', '/tmp/x']).repo, '/tmp/x');
    // Anything that is not an address is not eaten: the repo is still the repo.
    assert.equal(parseArgs(['--serve', '/tmp/x']).repo, '/tmp/x');
  });
});

describe('starting up', () => {
  const repo = plumbedRepo();
  after(() => repo.dispose());

  it('serves the repository it was pointed at', async () => {
    const server = await main([repo.dir, '--no-open']);
    try {
      assert.ok(server.port > 0);
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      assert.equal(res.status, 200);
    } finally {
      await server.close();
    }
  });

  it('refuses a directory that is not a repository', async () => {
    await assert.rejects(main(['/', '--no-open']));
  });

  // `npm i -g gitva` puts a symlink on PATH; running that link must start the
  // server, which is exactly what the entry-point guard once got wrong.
  it('starts when run through the symlink an install puts on PATH', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'gitva-bin-'));
    const link = join(bin, 'gitva');
    symlinkSync(fileURLToPath(new URL('../src/cli.js', import.meta.url)), link);
    const child = spawn(process.execPath, [link, repo.dir, '--no-open']);
    try {
      const said = await new Promise<string>((resolve, reject) => {
        child.stdout.once('data', (d: Buffer) => resolve(d.toString()));
        child.once('exit', (code) => reject(new Error(`said nothing, exited ${code}`)));
      });
      assert.match(said, /gitva watching/);
    } finally {
      child.kill();
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('compares argv[1] as given when there is nothing on disk to resolve', () => {
    assert.equal(entryPath('/no/such/gitva'), '/no/such/gitva');
  });
});
