# Gitva

## 1. What this is

A visual tutorial for git, taught from the internals upward: plumbing first, porcelain later.
It shows the contents of a repository's `.git` folder as a live graph in a browser.

The thesis being demonstrated:

> **git is just a key-value store plus a few pointers**

Every feature has to make that sentence more obvious on screen.

## 2. The demo loop

1. The author opens a browser with gitva pointed at a repo.
2. A terminal sits side by side with it.
3. The author runs a git command — hash an object, update the index, write a tree, commit,
   reset, tag.
4. **The browser updates on its own, within a second, and visibly shows what changed.**

Step 4 is the product. Everything else serves it.

The canonical scenario that must always work, and should be a test:

```
git add a.txt b.txt   → two blobs, two index entries appear
git reset b.txt       → the index entry goes; the blob survives, now marked unreachable
```

Both halves visible at once. If that reads clearly to someone who has never seen the tool, the
tool works.

## 3. What it must show

- **Every kind of object**: blobs, trees, commits, annotated tags — loose and packed alike,
  with no visible difference between the two, because to git there isn't one.
- **Every kind of pointer**: HEAD attached and detached, branches, tags, and refs that have
  been folded away into the packed form. A branch must feel like what it is — a file with a
  sha in it — not like a first-class object.
- **The staging index.** "Partially staged, then reset" exists nowhere but the index and is
  central to the lesson. Conflict entries must look different from clean ones.
- **Orphans**: an object nothing points at, a commit abandoned by a reset. Visibly marked
  unreachable, never silently dropped. Their rescuability is part of the lesson.
- **The relationships**, all of them, as arrows: HEAD to the branch it names (or straight to a
  commit when detached), a ref to its object, a tag to its target, a commit to its tree, a
  commit to its parents, a tree to its entries — labelled with the name and mode, because
  *names live in trees, not in blobs*
- **What each thing is, in plain language.** Point at any node and learn what that file in
  `.git` actually does, and which command creates it.
- **What changed** since the previous state, highlighted. This is what makes a plumbing
  command *land*. It is not polish.
- **What it is not showing, and why** — always, out loud, in the interface.

## 4. What it must be

- **Live.** No manual reload, ever. A change on disk reaches the screen in about a second.
- **Honest at any size.** It opens a five-object fixture and a nine-million-object monorepo the
  same way, and is useful in both. Where the big one can't support a feature, it says so
  rather than pretending or hanging.
- **Read-only. Absolutely.** gitva never writes to the repository it watches — not the index,
  not a cache, not a config value. This is the promise the whole tool rests on.
- **Local.** One repo, one person, one machine.

## 5. Where the knowledge comes from

**Everything gitva knows, it learns by running git's own plumbing commands.** No git library,
no reimplementation of a format, no parsing files in `.git` by hand.
would eat a week and teach nobody anything.

This is not a shortcut, it is the coherent choice: *the app runs the same commands it is
teaching*. Someone can read what gitva does and then type it themselves. Anywhere the
temptation appears to hand-decode something for speed, weigh the lost legibility as a real
cost, because the legibility is the product.

Two consequences worth internalising before writing anything:

- **Asking git a question is cheap; asking it once per object is not.** The gap between those
  two is where the previous build died. Prefer one conversation that answers many questions
  over many conversations that answer one.
- **Some questions walk the entire repository to answer.** Counting all commits is the classic
  one. Every such question has a cheap cousin that reads a header instead. Know which is which
  before you ask.

And one thing to compute rather than ask for: **reachability**. Walk out from the roots — HEAD,
every ref, every index entry — and anything the walk never reached is an orphan. That traversal
is the lesson made executable, and it is faster than the built-in checker.

## 7. The one architectural idea: bound the view, not the repository

This is the idea the previous build learned last and should have started with.

The browser never holds *the repository*. It holds a **view**: a bounded, explicitly-requested
slice of it. The job is not "describe this repository", it is "answer this question about it,
and keep the answer fresh".

A view is four things:

- **a question** — everything, or a chosen set of branches, or a search (by message, author,
  content, or path);
- **how much of the answer** — a window into it, widened by scrolling;
- **what's been opened up** — the commits and trees the user has drilled into;
- **whether the index is part of the answer at all.**

Every way a user can change what's on screen is a change to that one thing. Making it a single
explicit object is what turns branch filtering, search, paging and drill-down into **one
mechanism instead of four features**, and it is the seam every future capability hangs off.

Because a view is bounded *by construction*, everything downstream of it — how state reaches
the browser, how change is detected and highlighted, how history is replayed — never has to
care how big the repository is. Get this right and the rest of the design stops having a scale
problem. Get it wrong and every other part needs its own escape hatch, which is exactly what
happened last time.

Corollary, learned painfully: **do not build a delta protocol.** Bounding the view is what
makes sending whole states permanently affordable, and whole states are what make the diffing,
the replay and the change highlighting simple. If profiling ever argues for deltas, the burden
of proof is on the delta.

### Capabilities, not modes

There is no big-project mode and no flag. **Measure the repository once, cheaply, at startup,
and derive what it can support.** The interface then adapts — and, the part that matters, it
**says why** something isn't on offer rather than quietly not offering it. A control that can't
work is replaced by the reason it can't, in the place the control would have been.

Two things a very large repository can't have, and what it gets instead:

| Can't have | Gets instead |
|---|---|
| Orphan detection — it needs a walk over every object | An honest note that orphan detection is off, and why. Everything drawn is reachable by construction. |
| The index as one node per staged path | The entries that **differ from HEAD**, drawn, plus a count for the rest. This is *better*, not a degradation: the interesting part of the index always was the delta, not the inventory. |

**Set those limits from measurement, not intuition.** The previous build guessed one of them
wrong by more than an order of magnitude — because listing every object is nearly free, but
*drawing* them all means asking for every directory listing, and that cost is what actually
binds. Measure the expensive step, not the obvious one.

### What a window owes the user

- **A parent outside the window** is drawn as an arrow into a "history continues" affordance,
  never as an edge to a node that isn't there, never silently dropped. A dangling arrow is
  honest, and it is also the cue to scroll.
- **A ref pointing outside the window** is left out and *counted*. A hundred old tags pointing
  at nothing crowd out the history; "110 of 122 refs point outside this window" does not.
- **Reaching the bottom widens the window**, and stops asking once widening stops producing
  commits.
- **Some things a big repo could do faster if the user built a cache git offers.** Detect it,
  hint at it, never build it — that would be a write. Teaching the user about a git internal
  they didn't know existed is gitva working as designed.

## 8. Staying live

The naive approach — re-read the repository on a timer and see if the answer changed — is what
makes the tool unusable on anything real. It is a full read of the object database twice a
second.

The idea that replaces it: **ask a cheap question first.** Find a change signal whose cost
depends on the number of refs, not the size of the repository, and only do real work when it
moves. The overwhelmingly common case is "nothing happened", and that case must cost almost
nothing.

Two requirements on that signal, both learned from things it initially missed:

- It must notice a **bare new object that nothing points at yet** — that's the very first
  plumbing command the tutorial teaches, and a refs-only signal is blind to it.
- It must notice an **index rewrite**, which is how staging shows up.

Watching the filesystem is the obvious alternative and is rejected — not because the repo is
small, but because polling something this cheap has no missed-event failure mode, while a
watcher needs debouncing, lock-file filtering and platform-specific behaviour. Revisit only if
profiling says the cheap question isn't cheap, and then only as a hint to ask early, never as
the source of truth.

Also: **object contents are fetched when something is read, not shipped with every state
update.** A body is for reading *one* thing. The previous build sent every small object's
contents in every frame, forever, for data almost nobody ever looked at.

## 9. The picture

### One surface, four bands

Not four views. The arrow from a commit to its tree must be drawn straight across the boundary,
because that arrow *is* the lesson.

```
┌── pointers ──┬──────── commits ────────┬───── objects ─────┬── index ──┐
│              │  ● ─┐                   │                   │           │
│  main ──────▶│  ●  ●    (lanes)        │                   │           │
│  HEAD ─────▶ │  │ ╱                    │                   │           │
│              │  ●────────────────────▶ ◆ tree ─▶ ◆ ─▶ ○    │  ▭ a.txt  │
│              │  ●                      │        └──▶ ○ ◀───┼──▭ b.txt  │
└──────────────┴─────────────────────────┴───────────────────┴───────────┘
```

**Commits are lanes.** One commit per row, newest on top, in the order git itself gives, with
the lane sweep every good git GUI uses: a lane stays reserved from a commit until its parent
turns up, a merge fans out, a branch tip claims a new one. A branch is then a straight vertical
line and a merge is a visible fork. A new commit lands on a new row and pushes nothing
sideways. Greedy is fine — every git GUI has the same long-branch drift.

**Pointers are a gutter** to the left: a ref sits at the height of the commit it names, with a
short connector; several refs on one commit stack inside its row; HEAD sits outside the ref it
names, pointing at it. This reads as "labels on history", which is what refs are, while the
arrow keeps saying "this is a pointer to a sha".

**Objects grow rightwards from their commit's row**, on demand, one column per level of depth.
Use the *longest* path from the root tree to decide depth, so a blob shared between a top-level
file and a nested one sits at the deeper column and no arrow ever points backwards. Order
entries the way git orders them. Place a shared object once, near the things that point at it.

**A commit's row is as tall as whatever has been opened inside it.** Expanding accordions the
grid open at that point; everything below shifts down by a predictable amount, which animates as
a clean push rather than a reshuffle. This is what keeps rows independent and stops the object
band from ever being a global packing problem.

**The index sits apart**, in its own column at the far right, each entry beside the blob it
stages, hideable outright. The staging area is the sandbox *beside* the object graph, not part
of it, and the picture should say so.

### Stability is the load-bearing property

**Where a node sits is a function of the state being drawn — never of what was on screen
before, never of the order things were processed.**

This is the single most important property in the visual design. It kills the jumping, makes
animation mean something, and reduces manual pinning from a necessary workaround to an optional
convenience. Above all it is what makes change highlighting legible at all: **a node that
flashes *and moves* teaches nothing.**

Deciding where things go should be separable, testable on its own, and free of any knowledge of
how they're painted.

### Own the layout

The previous build used a general-purpose graph layout engine and it was the direct cause of
every complaint: **slow**, because it re-optimises the whole graph on every change; **jumpy**,
because its ordering is a global optimisation, so one new commit reshuffles everything; and
**generic-looking**, because it knows nothing about git.

gitva draws exactly two structures — a commit DAG and a directory tree — and *both have known
good layouts that no general algorithm can discover*. Generality was buying nothing and costing
the entire complaint list. What you give up is the ability to draw an arbitrary graph, which
gitva never needs to do.

### Colour: three hues, and no more

This was measured, not felt. The previous palette failed four of five accessibility checks:
purple tags and blue blobs were indistinguishable to a red-green colourblind viewer, and grey
index chips were borderline against blue blobs for *everyone*.

A node-link graph is an **all-pairs problem**: any kind can end up adjacent to any other, so
every pair must separate — not just neighbours in a legend. Under that constraint, on a dark
surface, **exactly three hues clear the contrast and colour-vision floors. Four does not, in any
combination.** So colour cannot carry seven kinds, and trying is what made it ugly.

- **Three hues, for the three things you look at constantly**: commit, tree, blob. Warm for
  commits — they're the spine — with tree and blob keeping the green and blue that are already
  muscle memory. Validate the actual values against the actual surface; don't inherit them.
- **Everything else stops competing for hue, and the taxonomy gets truer as a result.** An
  annotated tag is a name and a message pointing at another object — it is nearly a pointer
  already, so let it join the pointer family. HEAD, refs and index entries are outline shapes in
  plain ink, separated by silhouette, carrying the name they already have. **The text is the
  identity; colour was redundant.**
- **Unreachable is a state, not an identity**, so it is never a hue. It should read as a ghost,
  because that's what it is.
- **One reserved accent means "this just changed", and is spent on nothing else** — not hover,
  not selection, not focus. Change highlighting is the promise the tool makes; that colour is
  its vocabulary, and every other use devalues it.

Identity is therefore never colour alone, anywhere: **shape, then label, then hue.**

Dark is the default and the only theme for v1. A light mode means re-validating the whole
palette against a light surface, and nobody is asking for it.

### The rest of the visual intent

- **Type.** Monospace for machine text only — shas, paths, modes, object contents. A UI sans
  for everything a human wrote. Monospace prose is the loudest "unstyled" signal an interface
  can send, and it was most of why the old one looked like a debug tool.
- **Shas.** Short form on the node, always; the full forty characters live in the panel. Never
  write a sha across a node.
- **Rhythm.** One spacing unit, everything a multiple of it; one corner radius. Ad-hoc padding
  reads as sloppy even when nobody can name why.
- **Depth.** Three surface levels — ground, panel, raised — rather than borders doing work a
  background step should do.
- **Chrome.** The header is a toolbar with grouped, separated controls: what repo this is, what
  you're looking at, what state it's in. A flat run of unrelated controls is what makes an
  interface look like a debug panel. The legend belongs behind an affordance, not permanently
  across the bottom — you read it twice.
- **The details panel is where the teaching lives**, so it earns hierarchy and width: what this
  is, its facts, the plain-language explanation, then its contents.
- **Arrows.** Commit-to-parent is the strongest line on screen; it's the spine of the story, so
  draw it in ink rather than a hue so it doesn't fight the nodes. Lane changes use a short
  elbow, not a long sweeping curve — that's the railway look, and it's what makes a dense commit
  graph readable rather than woolly. Object arrows are thinner and recessive; pointer arrows
  dashed; arrowheads small, because "points at" is learned in five seconds and then shouldn't be
  shouted.
- **Motion.** One duration, one curve, nothing slow. New things grow out of where they came
  from — a new blob out of its tree — and removed things fade in place rather than vanishing.
  Honour the reduced-motion preference by dropping to instant. A tool where things ease into
  place reads as considered; one where they snap reads as a prototype.

### Detail comes and goes with zoom

Text is the expensive primitive and the thing that turns a graph into soup. Far out, no text at
all — shape and colour still carry the kind. Closer, the short sha. Closer still, sha and kind.
Only at the closest tier do the tree entry names and modes appear on the arrows — by which point
you're reading a single directory, which is exactly when those labels are worth having.

### Hidden means absent

Folding and the hide toggles must take things *out of the drawing*, not merely make them
invisible. Something that isn't painted but still exists costs work every frame, and on a real
repository that's the difference between a graph and a hung tab. Take its arrows with it so
nothing dangles, and remember where it was so it comes back from there rather than flying in
from the corner.

## 10. Interaction

| Gesture | What it does |
|---|---|
| Zoom and pan | Moves the camera. Never re-arranges anything. |
| Click a node | Selects it; the panel explains what it is and shows its contents. Optionally centres the view — a preference, because it's divisive. |
| Hover | Lights up the node and its arrows, dims the rest. On a dense graph, seeing *what connects to what* without committing to a click is the biggest usability win available. |
| Right-click a commit | Folds away everything it contains, collapsing towards the commit DAG alone; on a big repo the same gesture *opens* one that hasn't been loaded. One button folds or unfolds everything. Anything past a handful of commits starts folded. |
| Drag a node | Pins it where you put it. |
| Scroll past the bottom | Asks for more history. |
| Keyboard | Fit to screen; step through history; pause. |

Preferences the user sets — what's hidden, whether clicks centre — should survive a reload. They
are about how this person likes to work, not about this session.

**Pinning.** With a stable layout this stops being load-bearing, but arranging a graph by hand
for a lesson or a screenshot is a real use. A pin belongs to the moment it was made in and is
keyed to the object itself, so arranging things at one step doesn't disturb earlier ones, and a
pin made while live carries forward.

**Time travel.** Every state the browser is shown is kept, so a demo can be *replayed instead of
redone*. Pausing stops following the tail while recording continues behind you; stepping and
scrubbing move through the tape; reaching the newest state goes live again. The crucial detail:
each state is drawn diffed against **whatever is currently on screen**, so stepping backwards
highlights the change in reverse — which is how you show a reset twice without doing it twice.
Nothing is persisted; a reload starts fresh. Cap the tape, and be honest in the readout about
what's been dropped. And because each state was a state *of a view*, going back to one has to
put its view back — otherwise the replay is of something that was never on screen.

**Always say what's going on.** The header carries a running tally of what's on screen, whether
the connection is live, what changed in the last update, and the note explaining what this view
is *not* showing. Connection loss is a visible state, not a silent stall.

## 11. How fast it has to be

Measured on a mid-range laptop, at the sizes a **bounded view** actually produces — low
thousands of things on screen, not a whole repository. Sizing for nine million objects is how you
end up writing a graphics engine for a teaching tool.

| Situation | Target |
|---|---|
| Deciding where 20,000 commits go | well under a tenth of a second |
| Redrawing after an update, ~2,000 things on screen | inside one frame |
| Panning and zooming, ~2,000 on screen | a steady 60fps |
| Panning and zooming, ~10,000 on screen | still 60fps if it can be had |
| First paint on a thousand-commit repo | a quarter second |
| Checking whether anything changed, on a large repo | a few milliseconds |
| Rebuilding what's on screen after a change | well under a tenth of a second |
| **Sitting still — no animation, no input** | **no CPU at all** |

That last row is a requirement, not a nicety. A tool that pins a core while idle is a worse tool
regardless of its frame rate.

**Write the numbers down as you go.** The previous build's largest win — a snapshot going from
fifteen seconds to a few dozen milliseconds on a real repository — is only *knowable* because
someone measured before and after. Untuned measurements justify nothing: tune the obvious things
first, then measure, then decide.

## 12. Suggested order of work

Each step should end with something running and usable. The ordering matters — each makes the
next one's problems visible.

1. **See a small repo at all**: objects, refs, HEAD, index, orphans found by traversal. Prove it
   against a fixture with a deliberate orphan in it.
2. **Make it live**: changes reach the browser on their own. Detect change naively here; it gets
   replaced in step 5.
3. **Draw it properly**: bands and lanes, positions decided as a pure function, tested before
   anything paints them. This is the step that decides whether the tool looks like a git tool or
   a graph-theory demo.
4. **Make change legible**: diffing, the flash, fade in and out, the explanation panel, the
   history tape.
5. **Make idle free**: the cheap change signal replaces the naive poll. This is where a large
   repo stops burning CPU doing nothing.
6. **Introduce the view** as an explicit thing the client asks for and mutates. Before step 7,
   always — the windowed read depends on it existing.
7. **Make it work on anything**: the windowed read, one path serving all/branches/search,
   arrows into off-window history, measured limits, and the interface saying what it isn't
   showing. This is where an arbitrary commit horizon dies.
8. **The visual pass**, in this order because each reveals the next: palette → typography →
   rhythm and surfaces → chrome → arrow weights → detail tiers → the pointer gutter.
9. **The long tail**: scroll-to-load-more, and the index-as-delta above the limit.

### The check at the end of the visual pass

Screenshot it on a real repo with a couple of hundred commits and ask: **would you put this
image at the top of the README?** That's the bar. If not, the visual pass isn't done, and the
specific reason it isn't is the next task.

## 13. What went wrong last time

Carried forward so it isn't rediscovered the expensive way. **The previous build's source is
not available to read** — this list is the entire record of it, so treat it as the spec it is
rather than a summary you can go and check.

- **A general graph-layout library was the root of "slow, ugly and jumpy".** Three symptoms, one
  cause.
- **Re-reading the whole object database on a timer** does not survive a real repository. Detect
  change cheaply; do work only when something happened.
- **A separate conversation with git per object** is the other half of that cost.
- **Shipping every object's contents in every update** was a large permanent cost for data
  almost never looked at.
- **A "big project" flag forked the product** into two tools with different features and a
  hard-coded horizon. Capabilities derived from measurement, with the reasons shown, replace it.
- **Seven saturated hues at similar lightness** is the classic bad-dashboard failure mode, and it
  failed real accessibility checks. Three hues; shape and label carry the rest.
- **A guessed limit was wrong by more than an order of magnitude**, because it was set from the
  cost of the cheap step rather than the expensive one.
- **Invisible scaffolding added to bribe a layout engine** grew with the square of the graph.
  Owning the layout deleted it outright.
- **Two code paths that diverged in meaning, not just in cost.** The fast path and the simple
  path must answer the same question; if they start answering different ones, something has gone
  wrong.

## 14. The stack

- **Node.js and TypeScript**, on both sides. One language means the pure parts — layout,
  diffing, folding, the tape, the explanations — are written once and tested in one runner,
  which is the whole reason they were made pure.
- **Canvas 2D, hand-written**, for the graph. The perf targets in section 11 are past what DOM
  or SVG will hold, and a general renderer would repeat the general-layout-engine mistake one
  layer down. Hit-testing, text tiers and culling are ours to write; that is the price and it
  is known.
- **Ship as a global npm package.** `npm i -g gitva`, then `gitva` in a repo starts the server
  and opens the browser. That is the entire installation story; anything more is a barrier
  between a person and the lesson.

### Dependencies

Prefer the platform, but **pick the best tool for the job rather than the fewest**. A
dependency that is genuinely the right answer is not a failure of discipline — reinventing it
badly is. The bar is that you can say, in one sentence, what it buys and what it would cost to
do without. Anything that fails that sentence is a few lines of our own code instead.

### Drawing is separable from deciding

**Layout produces a scene; the renderer paints it.** Nothing that decides *where things go*
may know how they are painted, and nothing that paints may decide position. The renderer is an
interface with one implementation today, and the theme is data handed to it — so a different
drawing mechanism or a light palette is a new implementation, never a rewrite. This is the one
abstraction the design asks for up front, and it exists because section 9 says positions must
be a pure, separately-testable function of state.

The exception, stated plainly so it doesn't have to be argued later: **if the seam costs
measurable frames, delete the seam and draw directly.** Performance is the requirement; the
abstraction is in service of it, not above it. Measure before choosing, and write the number
down.

## 15. Conventions

- **Small, obvious code**, because the codebase is part of the teaching material. If the
  optimised path stops being readable as an explanation of how git works, the optimisation needs
  to justify itself.
- **Modern, ordinary TypeScript.** Strict mode, ESM, `node:` builtins, no clever type-level
  work in code meant to be read as a description of git. Patterns are welcome where they carry
  weight and forbidden where they only add a layer — a factory for one product is still a
  factory for one product.
- **Unit tests cover every branch of the logic.** Not a coverage number chased for its own
  sake: every branch is there because some git situation demanded it, so an untested branch is
  a git situation nobody checked. Rendering is exempt — it is checked by looking at it.
- **Reach for the platform first**, then for the best available tool, under the one-sentence
  test above. `node:test` is the runner and `node:child_process` is how we talk to git; neither
  needs help.
- **Tests over real fixture repositories built with real plumbing commands**, including a
  deliberately orphaned object. The pure parts — layout, diffing, folding, the history tape,
  the explanations — are pure precisely so they can be tested without a browser, and they
  deserve it.
- **Test that the tool degrades the documented way** above a capability limit by faking the
  measurement, not by building an enormous repository. That's the same switch the measurement
  flips.
- **Signing.** The author's *global* git config signs commits and tags. Never touch it, and never
  commit to a repo the author owns unless asked. Throwaway repos — fixtures, demos — must be
  isolated from that config, or every commit hangs waiting on a passphrase prompt. Scope the
  isolation to the throwaway repo; global is never the answer.
- **Never write to the repository under observation.** Third mention, deliberately.
