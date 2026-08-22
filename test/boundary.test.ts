/**
 * The split, enforced. `src/` holds the server and the shared vocabulary;
 * `web/` holds the browser. The rule that matters is one-way: the browser may
 * read the shared half, and may not reach the half that spawns git, writes the
 * recording, or answers HTTP.
 *
 * It is a test rather than a convention because the compiler will not catch it
 * — `dist/src` is served to the browser too, so an import of `git.js` from
 * `web/` type-checks perfectly and fails at the first `node:child_process`.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * Every file in `src/`, and which half it is in. Listed by hand on purpose: a
 * new file there is a decision about whether the browser may hold it, and the
 * decision belongs in a table someone has to edit rather than in whatever the
 * imports happen to allow.
 */
const SERVER_ONLY = ['src/git.ts', 'src/store.ts', 'src/server.ts', 'src/cli.ts'];
const SHARED = [
  'src/types.ts',
  'src/layout.ts',
  'src/diff.ts',
  'src/explain.ts',
  'src/strings.ts',
  'src/strings-en.ts',
  'src/strings-ru.ts',
];

const source = (file: string) => readFileSync(join(ROOT, file), 'utf8');

/**
 * Every module a file names: `from '…'`, a bare `import '…'`, and `import('…')`
 * — in either quote, because a boundary that only holds for one of them is not
 * a boundary.
 *
 * ponytail: a regex, not TypeScript's parser. It cannot see an import whose
 * specifier is computed, which is a thing no file here does and one this test
 * would rather fail on than pretend about — hence `NO_COMPUTED_IMPORT` below.
 */
const imports = (file: string) =>
  [...source(file).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);

/** An import whose target is worked out at runtime, which the walk above cannot
 *  follow — so it is refused outright rather than quietly skipped. */
const NO_COMPUTED_IMPORT = /import\s*\(\s*[^'"\s)]/;

/** Where an import lands, as a repo-relative `.ts` path — or null for a builtin. */
function target(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  return relative(ROOT, resolve(ROOT, dirname(from), spec.replace(/\.js$/, '.ts')));
}

/** Everything reachable from `entry`, following relative imports. */
function reachable(entry: string): { files: Set<string>; builtins: Map<string, string> } {
  const files = new Set<string>();
  const builtins = new Map<string, string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of imports(file)) {
      const to = target(file, spec);
      if (to === null) {
        if (spec.startsWith('node:')) builtins.set(spec, file);
        continue;
      }
      queue.push(to);
    }
  }
  return { files, builtins };
}

const webFiles = readdirSync(join(ROOT, 'web'))
  .filter((f) => f.endsWith('.ts'))
  .map((f) => `web/${f}`);

describe('the line between the server and the browser', () => {
  it('classifies every file in src/, so a new one is a decision', () => {
    const on = readdirSync(join(ROOT, 'src'))
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/${f}`);
    assert.deepEqual(
      on.slice().sort(),
      [...SERVER_ONLY, ...SHARED].sort(),
      'a file in src/ is either the browser’s to hold or the server’s alone — say which',
    );
  });

  it('never lets the browser reach the half that spawns git or writes the recording', () => {
    for (const entry of webFiles) {
      const { files } = reachable(entry);
      for (const server of SERVER_ONLY) {
        assert.ok(!files.has(server), `${entry} reaches ${server}`);
      }
    }
  });

  it('never lets a node builtin reach the browser', () => {
    for (const entry of webFiles) {
      const { builtins } = reachable(entry);
      assert.deepEqual(
        [...builtins].map(([spec, where]) => `${where} imports ${spec}`),
        [],
        `${entry} is served to a browser, which has no node builtins`,
      );
    }
  });

  it('keeps the shared half free of the server, so it stays servable', () => {
    for (const shared of SHARED) {
      const { files, builtins } = reachable(shared);
      assert.deepEqual([...builtins.keys()], [], `${shared} is shared and must hold no builtin`);
      for (const server of SERVER_ONLY) assert.ok(!files.has(server), `${shared} reaches ${server}`);
    }
  });

  /**
   * The other direction is the premise: *a step is what git did, a view is how
   * you look at it.* The browser reads — the recording off the event stream, and
   * one object's bytes on selection — and has nothing it can send. A second way
   * out of `web/` would be a browser reaching for the repository, so the list is
   * asserted whole rather than reviewed.
   *
   * Every way a page can reach the network is looked for, not just `fetch`, and
   * each one has to name where it is going *as a literal*: a call whose URL is
   * worked out at runtime is one this test cannot vouch for, so it fails as
   * loudly as a new route would.
   */
  const REACHES_OUT = /\b(fetch|EventSource|XMLHttpRequest|WebSocket|sendBeacon)\s*\(\s*(['"`])?([^'"`,)]*)/g;

  it('gives the browser no way to change anything the server holds', () => {
    const calls = webFiles.flatMap((f) =>
      [...source(f).matchAll(REACHES_OUT)].map(
        ([, what, quoted, where]) => `${f}: ${what} ${quoted ? where : '(not a literal)'}`,
      ),
    );
    assert.deepEqual(calls.sort(), [
      'web/app.ts: EventSource /events',
      'web/panel.ts: fetch /object?oid=${m.body.oid}',
    ]);
    for (const f of webFiles) {
      // Both halves of a write: the verb, and any way of choosing one.
      assert.ok(!/method\s*:/.test(source(f)), `${f} sets a request method, so it is sending something`);
      assert.ok(!NO_COMPUTED_IMPORT.test(source(f)), `${f} imports something this test cannot follow`);
    }
  });
});
