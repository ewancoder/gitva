# gitva

A visual tutorial for git, taught from the internals upward. It shows a repository's `.git`
as a live object graph in a browser, to make one sentence obvious on screen:

> **git is just a key-value store plus a few pointers**

The product is: you type a plumbing command in a terminal, the browser updates on its own
within a second and visibly shows what changed. Every feature serves that.

`INITIAL_DESIGN.md` is the original design brief — the *why* behind everything below, plus a
record of how a previous build failed. Read it before any substantial change; do not treat this
file as a replacement for it.

## IMPORTANT: the vocabulary

**This is the ubiquitous language of the project. Use these words and no others** — in the
interface, in the README, in comments, in commit messages, and in any new code. Every term below
was argued out and chosen over alternatives; the retired words are retired for a reason, and the
reason is usually that they teach something false about git.

**The rule that decides new words:** *the canvas uses git's own words for git things, and
invented words only for drawing things.* `shape` and `link` are ours, because git has no opinion
about drawings. `object`, `pointer`, `tree`, `blob`, `commit`, `index`, `unreachable` are git's,
and we do not improve on them.

### What git has

| term | means |
|---|---|
| **object** | blob, tree, commit, annotated tag. Content, addressed by its own hash. The sha is the key, the content is the value — which is why clicking one copies the sha: *a click hands you the key*. |
| **pointer** | a name holding a sha, living **outside** any object, and **mutable**. Refs, HEAD, index entries. Change one and no hash anywhere changes — that is why a branch can move. |
| **object graph** | objects, the links between them, and the pointers that root it. Reachability is defined from the pointers. The **index sits beside the object graph, not in it** — which is why staging something does not make it reachable. |
| **commit DAG** | the commits and their parent links specifically. **Never "commit graph"** — `git commit-graph` is a cache file git actually maintains, and gitva detects it. |
| **unreachable** | git's own word, from `git fsck --unreachable`. A **state**, not a kind. |

A **tree entry** and an **index entry** are the same mechanism — mode + name + sha — which is
what `write-tree` and `read-tree` convert between. The difference is the lesson: the index is
**flat** (full paths, sorted, no nesting), it carries **stages** (0 clean, 1/2/3 the sides of a
conflict — conflicts exist *only* in the index), and it caches stat data so `git status` need not
re-hash the working tree. Index entries point at blobs, except mode `160000` (a submodule), which
points at a commit.

Tree entries are **not** pointers, and the distinction is load-bearing: a link stored inside an
object's bytes is part of what was hashed, so "changing" it makes a *different object*. Pointers
are the only things that move. That is the difference between `git commit --amend` and
`git reset`.

### What gitva draws

| term | means |
|---|---|
| **shape** | anything on the canvas you can click or drag. **A docs-and-code word only** — the interface never says it. On screen, say "anything" (the inspector's empty state already does) or name the actual thing: object, pointer, commit, blob. |
| **link** | a drawn connection between shapes. A tree's links are **named links** — the name is on the link, never in the blob. |
| **canvas** | the region the object graph is painted on. Pans, zooms, holds pins. The `<canvas>` element and the term name exactly the same thing; the toolbars and inspector are the page around it. |
| **flash** | what a shape does when it changes: the one reserved accent, decaying to zero. |
| **state** | a condition a shape is in: **staged**, **unreachable**, **conflicted**, plus the two you create — **marked** and **pinned**. |
| **step** | one entry in the recording. **Only git causes a step** — expanding, filtering and paging redraw in place and add nothing. |
| **recording** | the server's list of steps. Written by the server, shared by every viewer, read-only to them. |

**Never `node`.** It makes a false claim — a branch chip is not a node in the object graph, and
that is the one thing about branches worth understanding. Never `arrow` or `edge` for a link
(edge is graph theory with node's exact defect).

### The gestures

**expand / collapse** (double-click) — show what a commit or tree links to. **Never "fold"**:
git already uses it (`explain.ts`: a packed ref is *"folded into .git/packed-refs"*). **Never
"open"**: it implies the tree is inside the commit, when a commit holds one 40-character sha and
the tree is a separate object. The tooltip carries the truth — *"show what this commit links to"*.

**select** (click) — read it in the inspector, and copy its sha. **mark** (right-click) — follow
it as the object graph moves. **pin** (drag) / **unpin** (shift-click).

### The regions

Everything horizontal across the top is a **toolbar**, each named for its job, never its position.

| region | holds |
|---|---|
| **view toolbar** | repo name (the path is its tooltip), the recording's identifier — a click copies it — load all commits (shown only while more remain), expand/collapse, index · unreachable · links from unreachable, then help, settings and the language buttons in the corner. Everything that changes what is drawn is a `View` field; the three in the corner are not — they open a dialog, or change the words. The question — branches and search — is built but hidden behind `QUESTIONS_ENABLED` in `src/types.ts`, because one shared view means one viewer's filter is everyone's. |
| **recording toolbar** | `reset view` · step back · pause · step forward · scrub · live · tally · what changed. `reset view` leads it, in its own group: it is the most-used control, and one button never earned a row of its own |
| **notes toolbar** | what the canvas isn't showing, what gitva won't do to your repo, and why |
| **canvas** | the object graph |
| **inspector** | what you selected: the full sha, the fields, the teaching text, the body |
| **help** | a dialog holding two sections: **legend** and the keys |
| **settings** | its own dialog, opened from the button beside help |

The canvas columns are **pointers and tags | commits | trees and blobs | index**. Not "objects"
— commits and tags are objects too, and a column labelled otherwise teaches the opposite of the
lesson.

### The people

**"you"** in the interface — it reads correctly for one person inspecting their own repo and for
each of 200 people in a lecture hall. **"viewer" / "viewers"** in the docs, and only where more
than one browser is genuinely in play (replay, a late joiner). Never *reader*, *watcher*,
*person*, or *room* — and never **author**, which is a hard collision: git commits have an author
and a committer.

**Shared or yours:** *the repository is shared, the view is yours.* Every viewer sees the same
steps, because that is what git did. Nobody sees your filter, your expansions, your marks, your
pins, or your camera. (Today the server holds one shared `view` and broadcasts it — see Known
open work.)

### Old term → new term

**The code deliberately keeps its old identifiers** — renaming working code is risk without
reward, and the test suite and `View`/`Snapshot` wire format depend on them. This table is for
**prose, UI strings, comments and new code**. When you touch a user-visible string, bring it
across; do not rename a symbol just to match.

| old (still in code, and some still on screen) | new |
|---|---|
| `node` | **shape** in docs/code; on screen say "anything" or the actual kind |
| `arrow`, `edge` | **link** |
| fold / unfold / `folded` / `expanded` (in copy) | **collapse / expand** |
| orphan, orphans, orphaned, "orphan detection" | **unreachable** (`--orphan` is a git flag for a *branch with no history*) |
| dangling | **unreachable** — gitva computes the full unreachable set; `dangling` is fsck's narrower term |
| tape | **recording** |
| state (as a recording entry), `Snapshot` (in prose) | **step** |
| picture | **canvas** |
| graph (as the drawn surface) | **canvas**; **object graph** only for the DAG itself |
| cross links | **links from unreachable** |
| column label "objects" | **trees and blobs** |
| column label "pointers" | **pointers and tags** |
| header, `transport`, `notes` | **view / recording / notes toolbar** |
| `panel` | **inspector** |
| legend (the dialog) | **help** — legend is one section inside it |
| Preferences | **settings** |
| reader, watcher, person, author | **you** (interface), **viewer(s)** (docs) |
| room | **viewers** |

The interface, the README and the teaching text have been brought across. `explain.ts` keeps one
deliberate "folded" — *"packed — folded into .git/packed-refs"* — because that is git's own use
of the word, and the reason ours had to give way.

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
| `src/strings-en.ts` | **every user-facing string**: the toolbars, tooltips, help, teaching text, notes, what the CLI prints. `ui` is one flat entry per `data-t*` key in `web/index.html`; the rest is what code asks for by name, a string or an arrow function where a number sits in the sentence. |
| `src/strings.ts` | the localization framework: `LANGUAGES` (the registry the buttons are drawn from), a loader per language, the live binding `S`, `setLanguage`, and `renderNote`. No language but English is loaded until it is chosen. |
| `src/types.ts` | shared vocabulary: `Snapshot`, `View`, `Capabilities`. Imported by both sides. |
| `src/git.ts` | the **only** place that spawns git. Parsers, `measure`, `changeSignal`, `snapshot`, `findUnreachable`, `readBody`. |
| `src/layout.ts` | `layout(snapshot, view, pins) → Scene`. Pure. Knows nothing about painting. |
| `src/diff.ts` | `diffScenes` (what to flash), `describe` (the recording toolbar's change line). Pure. |
| `src/explain.ts` | the inspector's facts, per shape kind (`NodeKind` in code); the wording is in `strings-en.ts`. Pure. |
| `src/store.ts` | the recording on disk: where the system keeps it, `recordingKey` (the ten-character identifier, shown in the view toolbar), one file per key, load and save. Server-only. |
| `src/server.ts` | `node:http`: static files, SSE `/events`, `POST /view`, `GET /object`. |
| `src/cli.ts` | `parseArgs` (pure), `main`; opens the browser. Runs only when it *is* the command, so importing it for a test starts nothing. |
| `web/` | `index.html` (all CSS), `tape.ts` (the recording: steps, cursor, view, pins, paging — no DOM), `camera.ts` (where the object graph sits under the canvas — arithmetic only), `panel.ts` (the inspector: `panelModel` pure, then the elements), `render.ts` (canvas), `theme.ts`, `app.ts` (DOM, events, painting — and nothing else). |
| `test/` | `fixture.ts` builds real repos with real plumbing, and `fakeState` for what is said rather than what git did; the rest are `node:test`. |

`src/*` is compiled to `dist/src` and served to the browser too — `web/app.ts` imports
`../src/{diff,layout,types,explain}.js`. **Nothing under `src/` that the browser imports may
touch `node:` builtins.** `git.ts`, `store.ts` and `server.ts` are server-only and never imported by `web/`.

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
4. **Layout is a pure function of its inputs.** Same `Snapshot` + `View` ⇒ identical `Scene`.
   Positions must not depend on what was on screen before or on processing order — otherwise
   change highlighting stops meaning anything. Tested in `test/layout.test.ts`.
5. **Idle costs nothing.** The client's rAF loop stops when no animation is running; the server
   polls a signal that costs O(refs), not O(objects), and only builds a snapshot when it moves.
   It polls whether or not a browser is connected — the recording belongs to the repository, and
   a step nobody was watching for cannot be built after the repository has moved on.

## How it works, briefly

**The view is the one architectural idea.** The browser never holds the repository, it holds a
`View`: a question (all / refs / search), a `limit`, which commits are `expanded`, and whether
the index is included. Every user action — filtering, search, paging, drill-down — is a mutation
of that object, posted to `/view`. Everything downstream is bounded by construction, so nothing
has to care how big the repo is.

**Whole steps, never deltas.** The server sends the entire `Snapshot` on every change, and
keeps them: a browser connecting gets the whole shared recording in one `event: history` frame
and replays it silently, so a second tab or a late joiner stands where every other viewer does.
That is affordable *because* the view is bounded, and it is what keeps diffing, replay and
change highlighting simple. If profiling ever argues for deltas, the burden of proof is on the
delta.

**The recording outlives the process.** It is written to the user's own state directory —
never into the observed repository — keyed by the repository's full path unless `--id` named
something else, along with the change signal it was built at, so a restart onto an untouched
repository adds no step. `src/store.ts`.

The key is the sha of the identifier, cut to ten characters, and it is **itself an identifier**:
`recordingKey` hands a key straight back, which is what makes the one the view toolbar shows —
and copies on a click — worth copying. A folder that moved is resumed with `--id <that key>`.
It reaches the browser in its own `event: recording` frame, because it is a fact about the
recording rather than about a step, and a step scrubbed back to must not change it.

**The view belongs to the run, not to the recording.** A `Snapshot` carries the `View` it was
answered under, so a kept recording's newest step is still answering the last run's question.
`serve()` answers it again — a *view* rebuild, which replaces that step rather than adding one —
before it listens, so `--learning` and the toolbar's toggles are this run's. Only while the
change signal still matches what was kept: if the repository has moved on, the poller is about to
build a step of its own under this run's view, and replacing the newest kept step would throw
away a step of something that has since changed. This was a bug: restarting with `--learning`
opened nothing, and restarting was the only way to change your mind, because a rebuild stamps
this run's view on.

**Starting the recording over is the presenter's, not a viewer's.** `--fresh` skips the kept
steps at startup and the first step of the run overwrites the file. There is no button and no
`POST /clear`: the recording is shared, so one browser must not be able to end everyone's
session — the same reason filtering is off (`QUESTIONS_ENABLED`).

**Capabilities, not modes.** `measure()` runs once at startup and derives what is on offer.
Above `LIMITS.fullLoad` (12,000 objects) unreachable detection is off; above `LIMITS.indexNodes`
(400) the index is drawn as its delta from HEAD. Both limits are estimates from the expensive
step — reading every tree — against a 100 ms rebuild budget; **they have never been benchmarked**,
so treat them as knobs to measure, not facts. When something is not on offer,
the interface says why, in `snapshot()`'s `notes[]`, shown in the notes toolbar. Test degradation
by faking the `Capabilities` object, not by building a huge repo.

**The change signal** hashes `for-each-ref` + HEAD + `count-objects -v` + `stat(.git/index)`.
It must keep noticing a bare new object nothing points at, and an index rewrite — those are the
first two things the tutorial teaches.

**The words are the viewer's.** A step carries note **ids** — `{ id, args }`, `Note` in
`types.ts` — never sentences, so the same recorded step reads in whatever language the browser
holding it is set to, including a language added long after the step was recorded. The choice is
a preference in `localStorage`, never posted: switching it changes nobody else's canvas, and
needs no round trip because `web/*` already imports the strings module. `S` is a live binding, so
nothing may cache a sentence — `setLanguage` swaps the words and the caller says everything
again (`applyWords` in `app.ts`). A language arrives when it is chosen, one module, the way every
i18n framework does it; the server's own prose — the CLI, and the one `trouble` message — stays
in the language the process was built with.

**Object bodies are fetched on selection** via `/object?oid=`, never broadcast.

## Visual rules that are load-bearing

- **Three hues only** for the three object kinds: commit warm, tree green, blob blue. A fourth
  fails the contrast/colour-vision floors on this surface — measured, not felt. Object kinds are
  separated by silhouette and label from there; states are not hues (`staged` is the blob blue
  tilted, unreachable is a ghost). Pointer chips and your own mark are outlines outside
  the silhouettes, so they carry their own colours without joining that count — see `web/theme.ts`.
- **One accent** (`--accent`, magenta) is the **flash**, and means "this just changed" and
  nothing else. Not hover, not selection, not focus.
- **Unreachable is drawn as a ghost** (dashed outline), never a hue — it is a state, not a kind.
- Monospace for machine text only (shas, paths, modes, contents); sans for anything a human
  wrote. Short shas on shapes; the full forty live in the inspector.
- Hidden means absent: collapsing and the index toggle remove shapes from the `Scene`, they do
  not make them invisible.

## Conventions

- **No user-facing string is written anywhere but `src/strings-en.ts`.** `web/index.html` holds
  keys — `data-t` for text, `data-t-title`, `data-t-placeholder`, and `data-t-html` for the
  handful that carry a `<kbd>` — and `web/app.ts` fills them in on load. `test/strings.test.ts` fails if a
  key has no string, if a string is unused, or if a `data-t-html` value smuggles in a tag other
  than `<kbd>`. New copy goes there and is reached through `S`; the strings module is pure data,
  so `src/` files the browser imports may use it freely. **A sentence never crosses the wire**:
  what the server has to say about a step is a `Note` id plus its numbers, and the browser makes
  the sentence — which is also why a count is passed raw and `toLocaleString()`d where it is read.
- Small, obvious code — the codebase is part of the teaching material. If an optimisation stops
  reading as an explanation of how git works, it has to justify itself.
- Comments explain *why* (usually citing the design brief), not what.
- **Everything is covered, and the whole suite is run before any change is called finished.**
  `npm test` builds, runs every test and prints a coverage table; every file in it is at 100%
  of lines bar the three exemptions below, and it stays that way. Each branch exists because
  some git situation demanded it, so an untested branch is a git situation nobody checked. A new
  feature is not done when it works — it is done when it has tests and `npm test` is green with
  nothing newly uncovered.
- **If a thing cannot be tested, split it until it can.** That is what `web/app.ts` is: DOM,
  events and painting, with every decision it makes moved into `tape.ts` (steps, collapses,
  pins, paging, what the recording toolbar says), `camera.ts` (bounds, gliding, zooming, fitting)
  and `panel.ts`'s `panelModel`, all of which are pure and all of which are tested. Painting is
  checked by looking at it, but *what* to paint is not: `path()` and `hitTest()` decide things,
  so they have tests, and `draw()` is walked over every kind and every zoom tier with a stub
  canvas so a shape nobody drew in anger cannot throw.
- Three things are deliberately not covered, and are the only three: `openBrowser` in `cli.ts`
  (it launches your browser), the entry-point guard beside it, and the `stdin` error
  swallow in `git.ts`. Anything else uncovered is an oversight, not a policy.
- **Every edge case found by hand gets a test in the same pass** — a bug that reached the screen
  is a case nobody thought of, so the fix is not done until something fails when it comes back.
  Name the test after the situation, not the function.
- Tests run against real fixture repos built with real plumbing, including a deliberate
  unreachable object. Fixtures set `GIT_CONFIG_GLOBAL=/dev/null` and
  `GIT_CONFIG_SYSTEM=/dev/null` — your global config signs commits and tags, and a signing
  prompt hangs the suite. **Never touch your global git config, and never commit to a repo you
  own unless asked.**
- Never write a performance number down that you did not measure. There is no benchmark in this
  repo and the README no longer claims any timings; if you add a real one, add the script that
  produced it in the same pass.
- **Neither CLAUDE.md nor the README is updated by default.** Touching them on every change
  muddles the diff; the code is the record, and a future session can read it. Both have their
  own bar, below.

### When to update the README

It is a user-facing document. Update it only when one of these is true, and in the same pass:

- a **new feature** appears that someone would look for — a gesture, a key, a toolbar control,
  a flag, a limit, a new thing on screen;
- an existing feature **changed or broke** compatibility;
- something in it is **outdated** or now wrong.

The README stays minimal: only what someone needs to understand the project, run it, and know
the features they would look for — **what the tool does, never what it is made of**. Internal
refactors, bug fixes, where a file lives and anything invisible from the browser get no mention,
however useful it would be to someone editing the code: that belongs here, or in a CONTRIBUTING
file if one is ever written. When in doubt, leave it alone.

### When to update CLAUDE.md

It is this file: what a future session needs that the code cannot tell it. Update it only when
one of these is true:

- a **core concept** changed — the vocabulary, an invariant, the architecture, a convention;
- something here is now **contradictory or outdated**;
- a fact is **important enough to belong here** and is not inferable from the code.

Everything else — a minor change, a bug fix, an implementation detail — goes unrecorded, because
future sessions can infer it from the code.

## The canonical scenario

Must always work, and is a test (`test/scenario.test.ts`):

```
git add a.txt b.txt   → two blobs, two index entries appear
git reset b.txt       → the index entry goes; the blob survives, now marked unreachable
```

## Known open work

- **One viewer can change what every other viewer sees.** The server holds a single `view` and
  broadcasts every rebuild to all clients, so "load all commits", expanding and the index toggle apply to
  everyone. Filtering — chosen branches, or a search — is switched off for that reason
  (`QUESTIONS_ENABLED` in `src/types.ts`): the control is hidden and `sanitise` forces
  `{ kind: 'all' }`, so no browser can ask a different question of the server. Turning it back on
  is one constant, once the view is per-viewer. Intended behaviour is *the repository is shared, the view is yours* — viewers may
  only watch the recording, never affect anyone else's canvas. The fix touches the recording's
  design: today it is a list of pre-built snapshots made under whatever view was current, and
  per-viewer views mean it has to hold the repository's state and let each browser ask its own
  question of it.
- **`--serve` has no authentication.** Any browser that reaches the port reads the whole
  repository. It can no longer throw the recording away — that moved to `--fresh`, in the
  presenter's hands — but the honest fix for the rest is the same one the view needs: know which
  browser is the presenter's.
- **The visual pass has been looked at once**, on a small repository — `docs/small-demo.png`, now
  at the top of the README. It has not been seen on a repo with a couple of hundred commits,
  which is the bar `INITIAL_DESIGN.md` §12 sets, and the column labels (`pointers and tags`,
  `trees and blobs`) are painted with no clipping, so they still want looking at on a narrow
  pointer gutter.
