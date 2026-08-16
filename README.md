# gitva

A visual tutorial for git, taught from the internals upward: plumbing first, porcelain later.
It shows the contents of a repository's `.git` folder as a live graph in a browser.

The thesis it exists to demonstrate:

> **git is just a key-value store plus a few pointers**

```
npm i -g gitva
cd some-repo
gitva
```

Then put a terminal beside the browser and type. Hash an object, update the index, write a tree,
commit, reset, tag — **the browser updates on its own, within a second, and visibly shows what
changed.** That is the product; everything else serves it.

The canonical demo, both halves visible at once:

```
git add a.txt b.txt   → two blobs, two index entries appear
git reset b.txt       → the index entry goes; the blob survives, now marked unreachable
```

## What it shows

One surface, four bands, with the arrows drawn straight across the boundaries because those
arrows are the lesson:

```
┌── pointers ──┬──────── commits ────────┬───── objects ─────┬── index ──┐
│              │  ● ─┐                   │                   │           │
│  main ──────▶│  ●  ●    (lanes)        │                   │           │
│  HEAD ─────▶ │  │ ╱                    │                   │           │
│              │  ●────────────────────▶ ◆ tree ─▶ ◆ ─▶ ○    │  ▭ a.txt  │
│              │  ●                      │        └──▶ ○ ◀───┼──▭ b.txt  │
└──────────────┴─────────────────────────┴───────────────────┴───────────┘
```

- Every kind of object — blobs, trees, commits, annotated tags — loose and packed alike, because
  to git there is no difference.
- Every kind of pointer — HEAD attached and detached, branches, tags, packed refs. A branch is
  drawn as what it is: a file with a sha in it.
- The staging index, apart, in its own column. Conflict stages look different from clean ones.
- Orphans, found by walking out from the roots. Marked unreachable, never silently dropped,
  because their rescuability is part of the lesson.
- What changed since the last state, in one reserved accent that is spent on nothing else.
- **What it is not showing, and why** — always, out loud, in the strip under the toolbar.

Click anything to read what that file in `.git` actually does and which command creates it.

## Gestures

| | |
|---|---|
| wheel | pan; hold <kbd>ctrl</kbd> to zoom |
| drag background / drag a node | pan / pin it where you put it |
| click | select, and read what it is |
| right-click a commit | fold or open what it contains |
| scroll past the bottom | ask for more history |
| <kbd>f</kbd> <kbd>[</kbd> <kbd>]</kbd> <kbd>space</kbd> <kbd>i</kbd> | fit · step back · step forward · pause · index |

Pausing stops following the tail while recording continues behind you, so a demo can be
**replayed instead of redone** — and stepping backwards highlights the change in reverse, which
is how you show a reset twice without doing it twice.

## Two promises

**It never writes to the repository it watches.** Not the index, not a cache, not a config
value. `src/git.ts` will only spawn git commands from a read-only allowlist, and sets
`GIT_OPTIONAL_LOCKS=0` so git will not take a lock to be helpful either. Where a cache would
make things faster, gitva says so and leaves you to build it.

**Everything it knows, it learns by running git's own plumbing.** No git library, no
reimplementation of a format. The app runs the same commands it is teaching, so you can read
what it does and then type it yourself.

## Capabilities, not modes

There is no big-project flag. The repository is measured once, cheaply, at startup, and what the
interface offers follows from that — and it **says why** when something isn't on offer:

| Above the limit | What you get instead |
|---|---|
| Orphan detection | An honest note that it is off, and why. Everything drawn is reachable by construction. |
| One index node per staged path | The entries that **differ from HEAD**, plus a count for the rest — which was always the interesting part. |

The limits come from measurement, and specifically from the *expensive* step. Listing every
object is nearly free; reading every tree so orphans can be found is what binds, at roughly
8.5 µs per object.

## Speed

Measured on a mid-range laptop against real repositories. Numbers written down as they were
found, because that is the only way a later change is knowable as an improvement.

| | 25 objects | 3,100 objects | 46,000 objects |
|---|---|---|---|
| Measure the repository (once, at startup) | 2.9 ms | 2.6 ms | 3.0 ms |
| Cheap question: has anything happened? | 2.3 ms | 1.9 ms | 2.3 ms |
| Build a whole snapshot, full load | 6.2 ms | 21.8 ms | 394 ms |
| Build a whole snapshot, bounded | — | 6.9 ms | 38.3 ms |
| Lay out everything opened | 0.1 ms | 4.5 ms | 16.8 ms |

Deciding where 20,000 commits go: **~110 ms** (tested, and the test fails if it regresses).
Sitting still with no animation and no input costs no CPU at all: the render loop stops.

## Building it

```
npm install
npm test        # node:test, over real fixture repos built with real plumbing commands
npm start -- /path/to/repo
```

Node.js and TypeScript on both sides, so the pure parts — layout, diffing, the tape, the
explanations — are written once and tested in one runner. Canvas 2D, hand-written, for the
graph. Zero runtime dependencies.

| | |
|---|---|
| `src/git.ts` | the only place that talks to git |
| `src/layout.ts` | where everything goes — a pure function of the state, knows nothing about painting |
| `src/diff.ts` | what changed between two whole states |
| `src/explain.ts` | the teaching, in plain language |
| `src/server.ts` | the cheap poll, and whole states down an SSE stream |
| `web/render.ts` | the painter — decides no positions |
