# gitva

A visual tutorial for git, taught from the internals upward. It shows a repository's `.git`
as a live graph in a browser, to make one sentence obvious on screen:

> **git is just a key-value store plus a few pointers**

The product is: author types a plumbing command in a terminal, the browser updates on its own
within a second and visibly shows what changed. Every feature serves that.

`INITIAL_DESIGN.md` is the original design brief — the *why* behind everything below, plus a
record of how a previous build failed. Read it before any substantial change; do not treat this
file as a replacement for it.

## Commands

```
npm test                    # tsc, then node:test over dist/test/*.test.js, with a coverage table
npm run build               # tsc
node dist/src/cli.js <repo> [--port N] [--no-open]
```

Node ≥20, TypeScript, ESM, strict. **Zero runtime dependencies** — keep it that way unless a
dependency passes the one-sentence test in `INITIAL_DESIGN.md` §14.

## Layout

| | |
|---|---|
| `src/types.ts` | shared vocabulary: `Snapshot`, `View`, `Capabilities`. Imported by both sides. |
| `src/git.ts` | the **only** place that spawns git. Parsers, `measure`, `changeSignal`, `snapshot`, `findUnreachable`, `readBody`. |
| `src/layout.ts` | `layout(snapshot, view, pins) → Scene`. Pure. Knows nothing about painting. |
| `src/diff.ts` | `diffScenes` (what to flash), `describe` (the header sentence). Pure. |
| `src/explain.ts` | the teaching text, per node kind. Pure. |
| `src/server.ts` | `node:http`: static files, SSE `/events`, `POST /view`, `GET /object`. |
| `src/cli.ts` | `parseArgs` (pure), `main`; opens the browser. Runs only when it *is* the command, so importing it for a test starts nothing. |
| `web/` | `index.html` (all CSS), `tape.ts` (states, cursor, view, pins, paging — no DOM), `camera.ts` (where the graph sits under the window — arithmetic only), `panel.ts` (`panelModel` pure, then the elements), `render.ts` (canvas), `theme.ts`, `app.ts` (DOM, events, painting — and nothing else). |
| `test/` | `fixture.ts` builds real repos with real plumbing, and `fakeState` for what is said rather than what git did; the rest are `node:test`. |

`src/*` is compiled to `dist/src` and served to the browser too — `web/app.ts` imports
`../src/{diff,layout,types,explain}.js`. **Nothing under `src/` that the browser imports may
touch `node:` builtins.** `git.ts` and `server.ts` are server-only and never imported by `web/`.

`dist/` is build output and gitignored.

## The five things that must not be broken

1. **Never write to the observed repo.** `src/git.ts` has a `READ_ONLY` allowlist of
   subcommands and sets `GIT_OPTIONAL_LOCKS=0`. Adding a subcommand means editing that set —
   which is the moment to check it cannot write.
2. **Everything is learned from git's own plumbing.** No git library, no reading `.git` files by
   hand (`stat` for existence/mtime is fine, parsing is not). One exception, deliberate and
   commented: the raw tree format out of `cat-file --batch`, because the alternative is one
   process per tree.
3. **One conversation, many answers.** Never one git process per object. `cat-file --batch` with
   a list on stdin is the pattern; `readObjects()` walks trees level by level that way.
4. **Layout is a pure function of state.** Same snapshot + view ⇒ identical scene, always.
   Positions must not depend on what was on screen before or on processing order — otherwise
   change highlighting stops meaning anything. Tested in `test/layout.test.ts`.
5. **Idle costs nothing.** The client's rAF loop stops when no animation is running; the server
   polls a signal that costs O(refs), not O(objects), and only builds a snapshot when it moves.
   It polls whether or not a browser is connected — the history is the room's tape, and a state
   nobody was watching for cannot be built after the repository has moved on.

## How it works, briefly

**The view is the one architectural idea.** The browser never holds the repository, it holds a
`View`: a question (all / refs / search), a `limit`, which commits are `expanded`, and whether
the index is included. Every user action — filtering, search, paging, drill-down — is a mutation
of that object, posted to `/view`. Everything downstream is bounded by construction, so nothing
has to care how big the repo is.

**Whole states, never deltas.** The server sends the entire `Snapshot` on every change, and
keeps them: a browser connecting gets the whole shared history in one `event: history` frame and
replays it silently, so a second tab or a late joiner stands where everyone else does. That is
affordable *because* the view is bounded, and it is what keeps diffing, replay and change
highlighting simple. If profiling ever argues for deltas, the burden of proof is on the delta.

**Capabilities, not modes.** `measure()` runs once at startup and derives what is on offer.
Above `LIMITS.fullLoad` (12,000 objects) orphan detection is off; above `LIMITS.indexNodes`
(400) the index is drawn as its delta from HEAD. Both limits were **measured** — reading every
tree costs ~8.5 µs/object, and the rebuild budget is 100 ms. When something is not on offer,
the interface says why, in `snapshot()`'s `notes[]`, shown under the toolbar. Test degradation
by faking the `Capabilities` object, not by building a huge repo.

**The change signal** hashes `for-each-ref` + HEAD + `count-objects -v` + `stat(.git/index)`.
It must keep noticing a bare new object nothing points at, and an index rewrite — those are the
first two things the tutorial teaches.

**Object bodies are fetched on selection** via `/object?oid=`, never broadcast.

## Visual rules that are load-bearing

- **Three hues only** for the three object kinds: commit warm, tree green, blob blue. A fourth
  fails the contrast/colour-vision floors on this surface — measured, not felt. Object kinds are
  separated by silhouette and label from there; states are not hues (`staged` is the blob blue
  tilted, unreachable is a ghost). Pointer chips and the reader's own mark are outlines outside
  the silhouettes, so they carry their own colours without joining that count — see `web/theme.ts`.
- **One accent** (`--accent`, magenta) means "this just changed" and nothing else. Not hover,
  not selection, not focus.
- **Unreachable is a state, not a kind** — a ghost (dashed outline), never a hue.
- Monospace for machine text only (shas, paths, modes, contents); sans for anything a human
  wrote. Short shas on nodes; the full forty live in the panel.
- Hidden means absent: folding and the index toggle remove nodes from the `Scene`, they do not
  make them invisible.

## Conventions

- Small, obvious code — the codebase is part of the teaching material. If an optimisation stops
  reading as an explanation of how git works, it has to justify itself.
- Comments explain *why* (usually citing the design brief), not what.
- **Everything is covered, and the whole suite is run before any change is called finished.**
  `npm test` builds, runs every test and prints a coverage table; every file in it is at 100%
  of lines bar the three exemptions below, and it stays that way. Each branch exists because some git situation demanded it,
  so an untested branch is a git situation nobody checked. A new feature is not done when it
  works — it is done when it has tests and `npm test` is green with nothing newly uncovered.
- **If a thing cannot be tested, split it until it can.** That is what `web/app.ts` is: DOM,
  events and painting, with every decision it makes moved into `tape.ts` (states, folds, pins,
  paging, what the header says), `camera.ts` (bounds, gliding, zooming, fitting) and
  `panel.ts`'s `panelModel`, all of which are pure and all of which are tested. Painting is
  checked by looking at it, but *what* to paint is not: `path()` and `hitTest()` decide things,
  so they have tests, and `draw()` is walked over every kind and every zoom tier with a stub
  canvas so a shape nobody drew in anger cannot throw.
- Three things are deliberately not covered, and are the only three: `openBrowser` in `cli.ts`
  (it launches the reader's browser), the entry-point guard beside it, and the `stdin` error
  swallow in `git.ts`. Anything else uncovered is an oversight, not a policy.
- **Every edge case found by hand gets a test in the same pass** — a bug that reached the screen
  is a case nobody thought of, so the fix is not done until something fails when it comes back.
  Name the test after the situation, not the function.
- Tests run against real fixture repos built with real plumbing, including a deliberate orphan.
  Fixtures set `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_SYSTEM=/dev/null` — the author's
  global config signs commits and tags, and a signing prompt hangs the suite. **Never touch the
  author's global git config, and never commit to a repo they own unless asked.**
- Write performance numbers down when you change something that affects them; the README's
  Speed table is the record.
- **Finish every change by asking whether it added or altered something a user would want to
  know about** — a gesture, a key, a toolbar control, a flag, a limit, a new thing on screen.
  If so, update the README in the same pass. The README stays minimal: only what someone needs
  to understand the project, run it, and know the features they would look for. Internal
  refactors, bug fixes and anything invisible from the browser get no mention.

## The canonical scenario

Must always work, and is a test (`test/scenario.test.ts`):

```
git add a.txt b.txt   → two blobs, two index entries appear
git reset b.txt       → the index entry goes; the blob survives, now marked unreachable
```

## Known open work

- **The visual pass has never been looked at by a human.** It was built to the brief but no
  screenshot has been taken. `INITIAL_DESIGN.md` §12 sets the bar: screenshot it on a real repo
  with a couple of hundred commits and ask whether you would put that image at the top of the
  README. Whatever is wrong with it is the next task.
- No README screenshot yet, for the same reason.
