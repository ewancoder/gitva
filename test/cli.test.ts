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
import { browseUrl, entryPath, main, parseArgs, version } from '../src/cli.js';
import { plumbedRepo } from './fixture.js';

describe('arguments', () => {
  it('watches the directory you are standing in, on a port the OS picks', () => {
    assert.deepEqual(parseArgs([]), {
      repo: '.',
      port: 0,
      host: '127.0.0.1',
      open: true,
      help: false,
      version: false,
      learning: false,
      fresh: false,
      id: undefined,
    });
  });

  it('takes a repository as the one positional argument', () => {
    assert.equal(parseArgs(['/tmp/x', '--no-open']).repo, '/tmp/x');
    assert.equal(parseArgs(['--no-open']).open, false);
  });

  it('takes --learning, for showing a repository to a room', () => {
    assert.equal(parseArgs(['--learning']).learning, true);
    // A flag is not a repository.
    assert.equal(parseArgs(['--learning']).repo, '.');
  });

  it('takes --fresh, to start the recording over', () => {
    assert.equal(parseArgs(['--fresh']).fresh, true);
    assert.equal(parseArgs([]).fresh, false);
  });

  // The recording is filed under the folder's full path, which is not the same
  // repository after a move or a second clone.
  it('takes --id, the name to keep the recording under instead of the path', () => {
    assert.equal(parseArgs(['--id', 'teaching']).id, 'teaching');
    // The name it ate is not the repository.
    assert.equal(parseArgs(['--id', 'teaching']).repo, '.');
    assert.equal(parseArgs([]).id, undefined);
  });

  it('takes -h and -v as well as their long spellings', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help, true);
    assert.equal(parseArgs(['--version']).version, true);
    assert.equal(parseArgs(['-v']).version, true);
  });

  it('takes a port, and stays on the loopback address with it', () => {
    const o = parseArgs(['--port', '4321']);
    assert.deepEqual([o.port, o.host], [4321, '127.0.0.1']);
  });

  it('opens onto every interface for a bare --serve, on a port that does not move', () => {
    assert.deepEqual(parseArgs(['--serve']), {
      repo: '.',
      port: 4200,
      host: '0.0.0.0',
      open: true,
      help: false,
      version: false,
      learning: false,
      fresh: false,
      id: undefined,
    });
  });

  it('takes an address for --serve, and a port on its own', () => {
    assert.deepEqual(parseArgs(['--serve', '10.0.0.2:9000']).host, '10.0.0.2');
    assert.equal(parseArgs(['--serve', '10.0.0.2:9000']).port, 9000);
    assert.deepEqual(parseArgs(['--serve', ':9000']).host, '0.0.0.0');
    assert.deepEqual(parseArgs(['--serve', '[::1]:9000']).host, '::1');
  });

  it('does not mistake the address it consumed for the repository', () => {
    assert.equal(parseArgs(['--serve', '10.0.0.2:9000', '/tmp/x']).repo, '/tmp/x');
    // Anything that is not an address is not eaten: the repo is still the repo.
    assert.equal(parseArgs(['--serve', '/tmp/x']).repo, '/tmp/x');
  });
});

describe('the address it tells you to visit', () => {
  it('sends you to loopback for a wildcard bind, which is not somewhere to visit', () => {
    assert.equal(browseUrl('0.0.0.0', 4200), 'http://127.0.0.1:4200/');
    assert.equal(browseUrl('::', 4200), 'http://127.0.0.1:4200/');
  });

  // Binding one LAN address means loopback is not listening at all.
  it('sends you to the one address it bound, when it bound one', () => {
    assert.equal(browseUrl('10.0.0.2', 9000), 'http://10.0.0.2:9000/');
    assert.equal(browseUrl('::1', 9000), 'http://[::1]:9000/');
  });
});

describe('starting up', () => {
  const repo = plumbedRepo();
  after(() => repo.dispose());

  it('serves the repository it was pointed at', async () => {
    const server = await main([repo.dir, '--no-open']);
    assert.ok(server);
    try {
      assert.ok(server.port > 0);
      const res = await fetch(`http://127.0.0.1:${server.port}/`);
      assert.equal(res.status, 200);
    } finally {
      await server.close();
    }
  });

  // `git init` is the first thing the tutorial teaches, so gitva has to be
  // watching before it is run: a directory with no .git in it starts a server
  // and waits rather than refusing.
  it('starts in a directory that is not a repository yet', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gitva-nogit-'));
    const server = await main([empty, '--no-open']);
    assert.ok(server);
    try {
      assert.equal((await fetch(`http://127.0.0.1:${server.port}/`)).status, 200);
    } finally {
      await server.close();
      rmSync(empty, { recursive: true, force: true });
    }
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

  // Asking what the flags are must not start a server or open a browser: the
  // question is answered on stdout and the process is free to exit.
  it('answers --help and --version without serving anything', async () => {
    const said: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((s: string) => (said.push(s), true)) as typeof process.stdout.write;
    try {
      assert.equal(await main(['--help']), undefined);
      assert.equal(await main(['--version']), undefined);
    } finally {
      process.stdout.write = write;
    }
    assert.match(said[0], /usage: gitva \[repo\] \[options\]/);
    // Every flag the parser understands is a flag the help names.
    for (const flag of ['--port', '--serve', '--no-open', '--learning', '--id', '--fresh'])
      assert.ok(said[0].includes(flag), flag);
    assert.equal(said[1], `${version()}\n`);
  });

  it('compares argv[1] as given when there is nothing on disk to resolve', () => {
    assert.equal(entryPath('/no/such/gitva'), '/no/such/gitva');
  });
});
