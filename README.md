# gitva

A live picture of a repository's `.git` in your browser, to make one sentence obvious:

> **git is just a key-value store plus a few pointers**

Put a terminal beside the browser and type. Hash an object, update the index, write a tree,
commit, reset, tag — the graph updates on its own within a second and flashes what changed.

```
git add a.txt b.txt   → two blobs, two index entries appear
git reset b.txt       → the index entry goes; the blob survives, now a ghost
```

## Run

```
npm i -g gitva
cd some-repo
gitva
```

`gitva [repo] [--port N] [--no-open] [--serve [HOST:PORT]]` — repo defaults to `.`, port to a
free one, and the browser opens itself. Node ≥20. No runtime dependencies.

`--serve` binds every interface instead of loopback, so others can watch the same repository
from their own browsers — useful for teaching. Bare, it takes `0.0.0.0:4200`; give it
`HOST:PORT` to choose. There is no authentication: anyone who can reach the port reads the
whole repository. Pins and folding stay local to each browser.

## What you see

```
┌── pointers ──┬──────── commits ────────┬───── objects ─────┬── index ──┐
│              │  ● ─┐                   │                   │           │
│  main ──────▶│  ●  ●    (lanes)        │                   │           │
│  HEAD ─────▶ │  │ ╱                    │                   │           │
│              │  ●────────────────────▶ ◆ tree ─▶ ◆ ─▶ ○    │  ▭ a.txt  │
│              │  ●                      │        └──▶ ○ ◀───┼──▭ b.txt  │
└──────────────┴─────────────────────────┴───────────────────┴───────────┘
```

- **Objects** — blobs, trees, commits, annotated tags, submodule gitlinks; loose and packed
  alike, because to git there is no difference. Commit warm, tree green, blob blue.
- **Pointers** — branches, remotes, tags, packed refs, HEAD attached or detached, chips
  coloured by what kind of pointer each one is. A branch is drawn as what it is: a file with
  a sha in it.
- **The index**, apart, in its own column, each entry wired to the blob it stages — including
  the ones no commit names yet, drawn violet at the top of the page: written by `git add`,
  held by the index alone, and an orphan the moment you unstage them. Conflict stages are
  dashed.
- **Unreachable objects** as ghosts, found by walking out from the roots. A discarded commit
  keeps its tree and its parents, so you see the whole abandoned state sitting there
  waiting for `gc`.
- **What just changed**, in one accent spent on nothing else. An object that changes what it
  belongs to travels to its new place — a blob rising into the commit that just named it, a
  whole tree falling into the orphans after a reset — so the move is part of what you read.
- **What is not on screen and why**, always, in the strip under the toolbar.

Click anything to read what that file in `.git` actually does, which command creates it, and
its raw bytes — the contents of a blob, the entries of a tree, the text of a commit object,
the one line inside a ref.

## Controls

| | |
|---|---|
| wheel | pan; hold <kbd>ctrl</kbd> to zoom |
| drag background | pan |
| drag a node | pin it where you put it (*unpin all* in the toolbar drops every pin) |
| click | select: read what it is, and light the whole path through it |
| hover | light what it connects to |
| right-click a commit | fold or unfold what it contains (a commit git just made arrives unfolded, unless you turn that off in the legend) |
| right-click a tree, blob or tag | mark it with a red outline, so you can follow that sha as the graph moves; right-click again to unmark |
| double-click a node | unpin it, wherever the layout wants it |
| double-click background | fit to width again, centred on the point you clicked |
| click *load more history* | load another thousand commits (*load all* in the toolbar loads the lot) |
| <kbd>f</kbd> <kbd>[</kbd> <kbd>]</kbd> <kbd>space</kbd> <kbd>i</kbd> | fit · step back · step forward · pause · index |

In the toolbar: ask for everything, for chosen branches, or search by message, author, path or
content; load the whole history; fold or unfold every commit at once; drop every pin; hide the
index. Every one of those is the same
mechanism — a change to the *view* the browser holds, which is why none of them care how big
the repository is.

Every state is kept. Pause and the tape keeps recording behind you, so a demo can be
**replayed instead of redone**; stepping backwards highlights the change in reverse, which is
how you show a reset twice without doing it twice. Going back to a state asks the question that
was being asked then — except for folding: a commit you opened stays open wherever you stand in
the tape, and one you folded stays folded, until you say otherwise.

The legend dialog also holds preferences, which survive a reload — whether clicking a node centres
the view on it, and whether a commit git just made arrives unfolded.

## Two promises

**It never writes to the repository it watches.** Not the index, not a cache, not a config
value. `src/git.ts` will only spawn git subcommands from a read-only allowlist, and sets
`GIT_OPTIONAL_LOCKS=0` so git will not take a lock to be helpful either. Where `git gc` or a
commit-graph would make things faster, gitva says so and leaves you to run it.

**Everything it knows, it learns from git's own plumbing.** No git library, no reimplemented
format. It runs the commands it is teaching, so you can read what it does and then type it
yourself.

## Big repositories

There is no big-project flag. The repository is measured once at startup and the interface
follows from that — and says so, in the notes strip, when something is off:

| Above the limit | What you get instead |
|---|---|
| 12,000 objects | No orphan detection — finding one means reading every object. Everything drawn is reachable by construction, and trees load only for the commits you open. |
| 400 staged paths | The index entries that **differ from HEAD**, plus a count for the rest. |

Both limits come from measurement, and from the *expensive* step: listing every object is
nearly free, reading every tree is what binds, at roughly 8.5 µs per object.

## Speed

Measured on a mid-range laptop against real repositories.

| | 25 objects | 3,100 objects | 46,000 objects |
|---|---|---|---|
| Measure the repository (once, at startup) | 2.9 ms | 2.6 ms | 3.0 ms |
| Cheap question: has anything happened? | 2.3 ms | 1.9 ms | 2.3 ms |
| Build a whole snapshot, full load | 6.2 ms | 21.8 ms | 394 ms |
| Build a whole snapshot, bounded | — | 6.9 ms | 38.3 ms |
| Lay out everything opened | 0.1 ms | 4.5 ms | 16.8 ms |

Deciding where 20,000 commits go stays **under 100 ms**, and a test fails if it stops. Sitting
still costs no CPU at all — the render loop stops when nothing is animating.

## Building it

```
npm install
npm test                        # node:test, over real fixture repos built with real plumbing
npm start -- /path/to/repo
```

TypeScript on both sides, so the pure parts — layout, diffing, the tape, the explanations —
are written once and tested in one runner. Canvas 2D, hand-written, for the graph.
`CLAUDE.md` is the map of the code; `INITIAL_DESIGN.md` is the why.
