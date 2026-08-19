/**
 * The server: asks git the cheap question on a timer, does real work only when
 * the answer moves, and pushes whole states down a server-sent-events stream.
 *
 * No delta protocol. Bounding the view is what makes whole states permanently
 * affordable, and whole states are what make the diffing and the replay simple.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitError, changeSignal, measure, open, readBody, snapshot, type RepoHandle } from './git.js';
import type { Capabilities, Snapshot, View } from './types.js';
import { DEFAULT_VIEW } from './types.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
};

const POLL_MS = 400;

export interface Server {
  port: number;
  close(): Promise<void>;
}

export async function serve(repoPath: string, port = 0, host = '127.0.0.1'): Promise<Server> {
  // The repository need not exist yet: `gitva` in an empty directory waits for
  // `git init`, so the very first plumbing command the tutorial teaches can be
  // watched happening rather than assumed to have happened already.
  let opened: { handle: RepoHandle; caps: Capabilities } | null = null;
  async function repository() {
    if (!opened) {
      const handle = await open(repoPath).catch(() => {
        throw new GitError(`no repository at ${repoPath} yet — waiting for \`git init\``);
      });
      opened = { handle, caps: await measure(handle.repo, handle.gitDir) };
    }
    return opened;
  }

  let view: View = { ...DEFAULT_VIEW };
  let seq = 0;
  let last: Snapshot | null = null;
  let signal = '';
  const clients = new Set<ServerResponse>();

  /** Rebuilds run one at a time. Anything arriving mid-build asks for one more
   * pass; further requests join that pass instead of growing an unbounded queue. */
  let pending = false;
  let pendingMoved = false;
  let building: Promise<void> | null = null;
  function build(repoMoved: boolean): Promise<void> {
    pending = true;
    pendingMoved ||= repoMoved;
    building ??= drain();
    return building;
  }

  async function drain() {
    // A drain that ended without clearing this would be handed to every future
    // caller, and nothing would ever rebuild again.
    try {
      while (pending) {
        const repoMoved = pendingMoved;
        pending = false;
        pendingMoved = false;
        await rebuild(repoMoved);
      }
    } finally {
      building = null;
    }
  }

  /**
   * `seq` counts states of the *repository*, not broadcasts. Asking a different
   * question of the same repository is not a moment to step back to, so a
   * view rebuild reuses the number and the client redraws in place.
   */
  async function rebuild(repoMoved: boolean) {
    try {
      const { handle, caps } = await repository();
      const s = await snapshot(handle, view, caps, repoMoved ? ++seq : seq);
      last = s;
      const frame = `event: snapshot\ndata: ${JSON.stringify(s)}\n\n`;
      for (const c of clients) c.write(frame);
    } catch (err) {
      const frame = `event: trouble\ndata: ${JSON.stringify({ message: String(err) })}\n\n`;
      for (const c of clients) c.write(frame);
    }
  }

  // The overwhelmingly common case is "nothing happened", and it costs one
  // for-each-ref, one count-objects and one stat.
  const timer = setInterval(async () => {
    if (clients.size === 0) return;
    try {
      const { handle } = await repository();
      const next = await changeSignal(handle.repo, handle.gitDir);
      if (next === signal) return;
      signal = next;
      await build(true);
    } catch {
      /* no repository yet, or one mid-rewrite: try again on the next tick */
    }
  }, POLL_MS);
  timer.unref?.();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (url.pathname === '/events') return sse(req, res);
      if (url.pathname === '/view' && req.method === 'POST') return await setView(req, res);
      if (url.pathname === '/object') return await object(url, res);
      return await statik(url.pathname, res);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    }
  });

  function sse(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write(': hello\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    if (last) res.write(`event: snapshot\ndata: ${JSON.stringify(last)}\n\n`);
    else void first();
  }

  /**
   * Every client waiting for the first state shares the same read — but only
   * while it is in flight. A read that found no repository yet leaves nothing
   * to hand the next arrival, and the poller stays quiet until the signal moves,
   * so a later browser has to be allowed to ask again and be told the same
   * thing: `gitva` in an empty directory is waiting for `git init`.
   */
  let initial: Promise<void> | null = null;
  function first(): Promise<void> {
    return (initial ??= firstBuild().finally(() => {
      initial = null;
    }));
  }

  async function firstBuild() {
    signal = await repository()
      .then(({ handle }) => changeSignal(handle.repo, handle.gitDir))
      .catch(() => signal);
    await ensureFirstSnapshot(building, () => last !== null, () => build(true));
  }

  async function setView(req: IncomingMessage, res: ServerResponse) {
    const body = await text(req);
    view = sanitise(JSON.parse(body));
    res.writeHead(204).end();
    await build(false);
  }

  async function object(url: URL, res: ServerResponse) {
    const oid = url.searchParams.get('oid') ?? '';
    if (!/^[0-9a-f]{4,64}$/.test(oid)) return res.writeHead(400).end('bad oid');
    const body = await readBody((await repository()).handle, oid);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  async function statik(pathname: string, res: ServerResponse) {
    const file =
      pathname === '/' || pathname === '/index.html'
        ? 'web/index.html'
        : /^\/(web|src)\/[\w.-]+$/.test(pathname)
          ? `dist${pathname}`
          : null;
    if (!file) return res.writeHead(404).end('not found');
    try {
      const data = await readFile(ROOT + file);
      res
        .writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
        .end(data);
    } catch {
      res.writeHead(404).end('not found');
    }
  }

  await new Promise<void>((r) => server.listen(port, host, r));
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;

  return {
    port: bound,
    async close() {
      clearInterval(timer);
      for (const c of clients) c.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** A poll may answer while the first client is measuring the repository. */
export async function ensureFirstSnapshot(
  active: Promise<void> | null,
  hasSnapshot: () => boolean,
  build: () => Promise<void>,
): Promise<void> {
  if (active) await active;
  if (!hasSnapshot()) await build();
}

function text(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1e6) reject(new Error('view too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

/** The view arrives from the browser, so it is checked before it reaches git. */
export function sanitise(raw: unknown): View {
  const v = (raw ?? {}) as Partial<View>;
  const q = v.question;
  const question: View['question'] =
    q?.kind === 'refs'
      ? // No ref name begins with a dash, and a name that did would reach
        // `rev-list` as an option rather than as a thing to walk from.
        { kind: 'refs', refs: (q.refs ?? []).filter((r) => /^[\w./@^~][\w./@^~-]*$/.test(r)).slice(0, 200) }
      : q?.kind === 'search'
        ? {
            kind: 'search',
            text: String(q.text ?? '').slice(0, 200),
            in: (['message', 'author', 'path', 'content'] as const).includes(q.in) ? q.in : 'message',
          }
        : { kind: 'all' };
  return {
    question,
    // The ceiling is only there to keep a hostile number out of `rev-list -n`;
    // "load all" sends something huge on purpose and lands here.
    limit: Math.min(Math.max(Math.trunc(Number(v.limit) || DEFAULT_VIEW.limit), 1), 1_000_000),
    expanded: (v.expanded ?? []).filter((o) => /^[0-9a-f]{4,64}$/.test(o)).slice(0, 5_000),
    showIndex: v.showIndex !== false,
    showUnreachable: v.showUnreachable !== false,
  };
}
