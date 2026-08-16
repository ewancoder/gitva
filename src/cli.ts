#!/usr/bin/env node
/** `npm i -g gitva`, then `gitva` in a repo. That is the whole installation story. */

import { spawn } from 'node:child_process';
import { serve } from './server.js';

const args = process.argv.slice(2);
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
const repo = positional[0] ?? '.';

try {
  const server = await serve(repo, port, host);
  const url = `http://127.0.0.1:${server.port}/`;
  process.stdout.write(`gitva watching ${repo}\n${url}\n`);
  // Reaching other machines has no authentication: whoever reaches the port
  // reads the whole repository.
  if (host !== '127.0.0.1')
    process.stdout.write(`serving ${host}:${server.port} to the network — no auth\n`);
  if (!args.includes('--no-open')) openBrowser(url);
  process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

function openBrowser(url: string) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
    .on('error', () => {})
    .unref();
}
