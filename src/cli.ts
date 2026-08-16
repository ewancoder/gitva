#!/usr/bin/env node
/** `npm i -g gitva`, then `gitva` in a repo. That is the whole installation story. */

import { spawn } from 'node:child_process';
import { serve } from './server.js';

const args = process.argv.slice(2);
const positional: string[] = [];
let port = 0;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (!args[i].startsWith('-')) positional.push(args[i]);
}
const repo = positional[0] ?? '.';

try {
  const server = await serve(repo, port);
  const url = `http://127.0.0.1:${server.port}/`;
  process.stdout.write(`gitva watching ${repo}\n${url}\n`);
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
