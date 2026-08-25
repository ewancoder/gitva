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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/**
 * `src/` is the server and `web/` is the browser. One file is held by both, and
 * it is named here rather than worked out from the imports: a second one is a
 * decision about widening the seam, and a decision belongs in a table someone
 * has to edit.
 */
const SERVER_ONLY = ['src/git.ts', 'src/store.ts', 'src/server.ts', 'src/cli.ts'];
const SEAM = ['src/types.ts'];

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

/** Every `.ts` under a directory, subfolders included — `web/localization/` is
 *  served to a browser exactly as `web/app.ts` is. */
const treeOf = (dir: string) =>
    (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
        .map((f) => f.split(sep).join('/'))
        .filter((f) => f.endsWith('.ts'))
        .map((f) => `${dir}/${f}`);

const webFiles = treeOf('web');

describe('the line between the server and the browser', () => {
    it('classifies every file in src/, so a new one is a decision', () => {
        assert.deepEqual(
            treeOf('src').sort(),
            [...SERVER_ONLY, ...SEAM].sort(),
            'a file in src/ is either the server’s alone or the seam both halves hold — say which',
        );
    });

    /**
     * The direction that used to be impossible to get wrong, now that the words
     * live in `web/`: the server printing a translated sentence would mean asking
     * a viewer's browser what language a terminal is in.
     */
    it('never lets the server reach into the browser’s half', () => {
        for (const entry of SERVER_ONLY) {
            const reached = [...reachable(entry).files].filter((f) => f.startsWith('web/'));
            assert.deepEqual(reached, [], `${entry} reaches into web/`);
        }
    });

    it('never lets the browser reach the half that spawns git or writes the recording', () => {
        for (const entry of webFiles) {
            const { files } = reachable(entry);
            for (const server of SERVER_ONLY) {
                assert.ok(!files.has(server), `${entry} reaches ${server}`);
            }
        }
    });

    /**
     * The browser half is published as well as served: `gitva/canvas` is how a
     * page that is not ours mounts the canvas and hands it steps. What
     * package.json points at is checked here rather than found out by whoever
     * installs it — and it is checked against the build, because a published
     * entry point that npm does not pack is a broken install and nothing else.
     */
    it('publishes an entry point that is built and packed', () => {
        const pkg = JSON.parse(source('package.json')) as {
            exports: Record<string, { types: string; default: string }>;
            files: string[];
        };
        const entry = pkg.exports['./canvas'];
        assert.equal(entry.default, './dist/web/canvas.js');
        assert.ok(existsSync(join(ROOT, entry.default)), `${entry.default} is not built`);
        assert.ok(existsSync(join(ROOT, entry.types)), `${entry.types} is not built`);
        for (const f of [entry.default, entry.types])
            assert.ok(
                pkg.files.some((packed) => f.startsWith(`./${packed}/`)),
                `${f} is published but not packed`,
            );
    });

    /**
     * `web/app.ts` is a page around the canvas, and `samples/webapp` is another
     * one. They are the same component only for as long as they enter it the
     * same way — so this is the door, and `canvas.ts` is the whole of it.
     *
     * Without this, `app.ts` importing `./inspector.js` or `./theme.js` reads as
     * harmless: it resolves, it type-checks, and it is even the same file the
     * canvas itself imports. What it costs is the seam — those files travel with
     * the canvas if it is ever split into its own package, and every one app.ts
     * reached past `canvas.ts` for is a re-export somebody has to discover by
     * breaking the build. Re-export it now and the split is a move plus one
     * import line.
     */
    it('lets the page reach the canvas only through the entry point it publishes', () => {
        const reached = imports('web/app.ts')
            .filter((spec) => spec.startsWith('.'))
            .filter((spec) => spec !== './canvas.js');
        assert.deepEqual(
            reached,
            [],
            'web/app.ts imports past canvas.ts — re-export it from canvas.ts instead, so a page that is not ours can have it too',
        );
    });

    it('never lets a node: builtin reach the browser', () => {
        for (const entry of webFiles) {
            const { builtins } = reachable(entry);
            assert.deepEqual(
                [...builtins].map(([spec, where]) => `${where} imports ${spec}`),
                [],
                `${entry} is served to a browser, which has no node: builtins`,
            );
        }
    });

    it('keeps the seam free of the server, so it stays servable', () => {
        for (const shared of SEAM) {
            const { files, builtins } = reachable(shared);
            assert.deepEqual(
                [...builtins.keys()],
                [],
                `${shared} is shared and must hold no builtin`,
            );
            for (const server of SERVER_ONLY)
                assert.ok(!files.has(server), `${shared} reaches ${server}`);
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
    const REACHES_OUT =
        /\b(fetch|EventSource|XMLHttpRequest|WebSocket|sendBeacon)\s*\(\s*(['"`])?([^'"`,)]*)/g;

    it('gives the browser no way to change anything the server holds', () => {
        const calls = webFiles.flatMap((f) =>
            [...source(f).matchAll(REACHES_OUT)].map(
                ([, what, quoted, where]) => `${f}: ${what} ${quoted ? where : '(not a literal)'}`,
            ),
        );
        assert.deepEqual(calls.sort(), [
            'web/app.ts: EventSource /events',
            'web/inspector.ts: fetch /object?oid=${m.body.oid}',
        ]);
        for (const f of webFiles) {
            // Both halves of a write: the verb, and any way of choosing one.
            assert.ok(
                !/method\s*:/.test(source(f)),
                `${f} sets a request method, so it is sending something`,
            );
            assert.ok(
                !NO_COMPUTED_IMPORT.test(source(f)),
                `${f} imports something this test cannot follow`,
            );
        }
    });
});
