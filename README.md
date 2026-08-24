# gitva

*the **v**isual **a**natomy of git*

```
git add a.txt b.txt   → two blobs appear, two index entries point at them
git reset b.txt       → the index entry goes; the blob survives, now unreachable
```

Gitva draws a repository's live object graph in your browser,
to make one sentence obvious:

> **git is just a key-value store plus a few pointers**

Put a terminal beside the browser and type. Hash an object, update the index, write a tree,
commit, reset, tag — the canvas updates on its own within a second and flashes what changed.

![gitva](docs/small-demo.png)

- HEAD attached to `develop`
- A blob you right-clicked wears a red outline
- One unreachable blob drawn as a ghost
- Links from the trees to blobs show file names
- Links from the trees to sub-trees show folder names
- Everything is movable and collapsible: your own learning tool

## Two promises

**It never writes to the repository it watches.** Not the index, not a cache, not a config
value. `src/git.ts` will only spawn git subcommands from a read-only allowlist, and sets
`GIT_OPTIONAL_LOCKS=0` so git will not take a lock to be helpful either. It will not run `git
gc` or write a commit-graph for you, and does not nag you to either.

**Everything it knows, it learns from git's own plumbing.** No git library, no reimplemented
format. It runs the commands it is teaching, so you can read what it does and then type it yourself.

## Run

> The tool has zero runtime dependencies; requires Node ≥20.

```
npm install -g gitva
cd some-repo
gitva
```

From a clone instead:

```
npm install && npm run build
npm install -g
```

Try it out without a repo:

```
./demo.sh
```

It will run gitva on a demo repo inside the project folder, and run some git commands each second.
You'll see the updated live view of the repository.

- `./demo.sh 3` - slows it down to 3 seconds per step
- `./demo.sh 0` - turns off automatic steps: you'll need to press Enter to run each step

Gitva also records your sessions as independent **steps** and allows you (or any viewer) to walk through them at any time.
The recording lives on the server side, and is persisted on disk (outside of the repo),
so you can restart `gitva` without losing the recording.

**A step is what git did. A view is how you look at it.** The server records the steps and is
the only thing that writes one; a browser only ever reads them. Everything you do to what is on
screen — expanding, collapsing, the toggles, pins, marks, the camera, the language, the theme —
happens in your browser and reaches nobody else, and there is nothing a browser can ask the
server to do. *The repository is shared, the view is yours.*

Because a step carries everything any view could draw, the recording is also all a browser needs:
once it has arrived, losing the connection costs you nothing but the next step.

## Usage

To get the up-to-date help page for the tool usage, run `gitva --help`.

If the repository is not specified - it defaults to the current folder. You can also run `gitva` before initializing
the git repository (no `.git` folder) - `gitva` will start and wait until you initialize the repo.

`--serve` binds every interface instead of loopback, so viewers can watch one repository from
their own browsers. Default is `0.0.0.0:4200` when passed without arguments.
Specifying host/port separately also works: `--serve=10.0.0.2` or `--serve :9000`.

`--port` option overrides any port specified by the `--serve`.

`--id NAME` records all steps to the recording with this ID, instead of the folder path (default).
You can also copy the ID of current recording by clicking on it, on the top left of the page.

`--fresh` starts the recording over.

`--learning` starts with every commit in the view expanded, so viewers don't need to open commits manually.

## What you see

![large-repo](docs/large-repo.png)

Four columns, left to right: **pointers and tags | commits | trees and blobs | index**.

- **Pointers and tags** - branches, remotes, tags - everything that points somewhere
- **Commits** - all commits, each one can be expanded or collapsed
- **Trees and blobs** - tree and blob objects, including submodule gitlinks
- **Index** - whatever is currently in the Index, connected to the respective blobs

Unreachable objects are drawn as ghosts.
Recently changed (added/modified) things are highlighted momentarily.
Click anything to read what it is or inspect its content.

## Controls

| | |
|---|---|
| ctrl+wheel | zoom the canvas |
| drag background | move around |
| double-click background | fit to width, centered on the point you clicked |
| click | select: inspect it, highlight the path through it, copy its SHA |
| hover | highlight what it links to |
| right-click | mark with a red outline for tracking |
| double-click a commit | expand or collapse what it links to |
| double-click a tree | expand or collapse that subtree |
| drag anything | pin it where you put it; shift+click unpins |
| shift+click | unpin an object from a specific location back to the default one |
| drag a column edge | change the size of the column |
| click on SHA in the inspector | copy the SHA |
| click on file path in the inspector | copy absolute file path |
| *reset view* | drops every pin (reset to default object positions) and puts the columns width back |
| <kbd>f</kbd> <kbd>←</kbd>/<kbd>[</kbd> <kbd>→</kbd>/<kbd>]</kbd> <kbd>space</kbd> <kbd>i</kbd> | fit · step back · step forward · pause · index |

The view toolbar has additional controls:

- **Expand all** - expands all commits and trees
- **Collapse all** - collapses all commits (excluding trees)
- **Index** - show/hide Index column
- **Unreachable** - show unreachable git objects
- **Links from unreachable** - show links from unreachable objects to reachable ones
- **Names** - show names of files/folders over the links
- **☾ / ☀ Theme** - switches the theme between dark and light (click 5 times for an easter egg theme)
- **help/settings** - show help window, edit user view-scoped settings
- **Languages section** - on the very top right, allows selecting the language

The recording toolbar has the following controls:

- **Reset view** - resets all your moved objects into their original positions
- **Recording controls** - allows going back and forth between the steps of the recording: does not pause anything server-wise, scoped for your own view only

## Big repositories

Gitva loads the last 1000 commits. If your repository has more commits - the oldest ones will not show up.
If the repository has more than 12,000 objects, or more than 400 staged paths - some features might be disabled
due to performance reasons, like tracking unreachable objects, or showing only part of the Index.

## Building it

```
npm install
npm test
npm start -- /path/to/repo
```

## References and stack

References:

- `CLAUDE.md` - instructions for agents maintaining this project
- `docs/INITIAL_DESIGN.md` - initial vision & the prompt that was used to create the first version

Stack:

- TypeScript
- Canvas 2D
- ESLint / Prettier
