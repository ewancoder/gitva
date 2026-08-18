#!/usr/bin/env node
/** `npm i -g gitva`, then `gitva` in a repo. That is the whole installation story. */

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve, type Server } from './server.js';

export interface Options {
  repo: string;
  port: number;
  host: string;
  open: boolean;
}

export function parseArgs(args: string[]): Options {
  const positional: string[] = [];
  let port = 0;
  let host = '127.0.0.1';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--serve') {
      // `--serve [HOST:PORT]`, bare meaning every interface on 4200. A shared
      // address is no use if the port moves every run, so this one is fixed.
      const at = /^(.*):(\d+)$/.exec(args[i + 1] ?? '');
      host = at ? at[1] || '0.0.0.0' : '0.0.0.0';
      port = at ? Number(at[2]) : 4200;
      if (at) i++;
    } else if (!args[i].startsWith('-')) positional.push(args[i]);
  }
  return { repo: positional[0] ?? '.', port, host, open: !args.includes('--no-open') };
}

export async function main(args: string[]): Promise<Server> {
  const { repo, port, host, open } = parseArgs(args);
  const server = await serve(repo, port, host);
  const url = `http://127.0.0.1:${server.port}/`;
  process.stdout.write(`gitva watching ${repo}\n${url}\n`);
  // Reaching other machines has no authentication: whoever reaches the port
  // reads the whole repository.
  if (host !== '127.0.0.1')
    process.stdout.write(`serving ${host}:${server.port} to the network — no auth\n`);
  if (open) openBrowser(url);
  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
  return server;
}

function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    .on('error', () => {})
    .unref();
}

/** argv[1] as Node sees the module it loaded: absolute, with symlinks resolved. */
export function entryPath(arg: string): string {
  try {
    return realpathSync(arg);
  } catch {
    return arg; // nothing on disk to resolve; compare what we were given
  }
}

// Run only when this file *is* the command — importing it, which is how the
// argument rules get tested, must not start a server.
// `npm i -g` puts a symlink on PATH, so argv[1] must be resolved the same way
// Node resolved import.meta.url — otherwise the installed command does nothing.
if (process.argv[1] && fileURLToPath(import.meta.url) === entryPath(process.argv[1])) {
  await main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
