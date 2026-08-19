/**
 * Where everything goes.
 *
 * Positions are a pure function of the state being drawn — never of what was
 * on screen before, never of the order things were processed. That property is
 * what makes change highlighting legible: a node that flashes *and* moves
 * teaches nothing. Nothing in here knows how anything is painted.
 *
 * gitva draws exactly two structures, a commit DAG and a directory tree, and
 * both have known good layouts. That is why there is no general graph engine
 * here: generality bought nothing and cost slow, jumpy and generic-looking.
 */

import type { Oid, Snapshot, TreeEntry, View } from './types.js';

export type NodeKind =
  | 'commit'
  | 'tree'
  | 'blob'
  | 'submodule'
  | 'tag'
  | 'ref'
  | 'head'
  | 'index'
  | 'more';

export interface SceneNode {
  id: string;
  kind: NodeKind;
  oid?: Oid;
  x: number;
  y: number;
  w: number;
  h: number;
  /** What is written on the node: a short sha, or a name. */
  label: string;
  /** Row text drawn beside a commit, or the path on an index chip. */
  sub?: string;
  unreachable?: boolean;
  conflict?: boolean;
  /** A tree drawn without its entries: the reader folded it shut. */
  folded?: boolean;
  /** Put down here because nothing on screen points at it, not beside anything. */
  stray?: boolean;
  /** The reader dragged this one somewhere by hand; the painter says so. */
  pinned?: boolean;
  /** Only the index holds this: written, not committed, and safe from gc while
   *  the entry beside it lasts. A state, like `unreachable`, not a kind. */
  staged?: boolean;
  /** Where this node came from, so it can grow out of it rather than fly in. */
  origin?: string;
}

export interface SceneEdge {
  id: string;
  from: string;
  to: string;
  kind: 'parent' | 'tree' | 'entry' | 'pointer' | 'stage';
  label?: string;
}

export interface Band {
  key: 'pointers' | 'commits' | 'objects' | 'index';
  label: string;
  x: number;
  w: number;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  bands: Band[];
  width: number;
  height: number;
  /** Rows, for the renderer's culling and for the hover backdrop. */
  rows: { oid: Oid; y: number; h: number }[];
}

export const M = {
  unit: 8,
  gutterX: 12,
  /** A full three-column gutter; narrower when no chain is that long. */
  gutterW: 246,
  chipW: 72,
  chipH: 20,
  chipPitch: 80,
  // A commit is a pill wide enough for its own sha, so the lane pitch has to
  // clear it: the sha is written in the node, not in a column beside it.
  laneW: 88,
  commitW: 76,
  commitH: 24,
  rowH: 44,
  rowPad: 10,
  objColW: 190,
  objRowH: 34,
  objW: 148,
  objH: 26,
  indexW: 176,
  indexH: 24,
  indexGap: 6,
  bandGap: 28,
};

/** HEAD → branch → tag object: the longest a pointer chain can get. */
const GUTTER_COLS = 3;

const short = (oid: Oid) => oid.slice(0, 7);
/** The name is in the tree, never in the blob — so the arrow carries it. */
const entryLabel = (e: { name: string; mode: string }) =>
  `${e.name}${e.mode === '100755' ? ' +x' : e.mode === '120000' ? ' ->' : ''}`;
const refLabel = (name: string) =>
  name.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, 'tag: ').replace(/^refs\//, '');

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

/**
 * The lane sweep every good git GUI uses: a lane stays reserved from a commit
 * until its parent turns up, a merge fans out, a branch tip claims a new one.
 * Greedy — every git GUI has the same long-branch drift, and it buys a layout
 * that never reshuffles when a commit arrives.
 */
export function assignLanes(order: Oid[], parentsOf: (oid: Oid) => Oid[]) {
  const inWindow = new Set(order);
  const lanes: (Oid | null)[] = [];
  const lane = new Map<Oid, number>();

  const claim = (oid: Oid) => {
    const free = lanes.indexOf(null);
    if (free >= 0) {
      lanes[free] = oid;
      return free;
    }
    lanes.push(oid);
    return lanes.length - 1;
  };

  let used = 0;
  for (const oid of order) {
    let i = lanes.indexOf(oid);
    if (i < 0) i = claim(oid);
    lane.set(oid, i);
    used = Math.max(used, i + 1);

    const parents = parentsOf(oid).filter((p) => inWindow.has(p));
    // This commit's lane is free the moment it is drawn; it carries on only if
    // it has a first parent no other lane is already holding. Reserving a
    // parent twice would leave the duplicate lane occupied forever — that is
    // what made the graph creep rightwards on every branch point.
    lanes[i] = null;
    if (parents[0] !== undefined && !lanes.includes(parents[0])) lanes[i] = parents[0];
    // A merge fans out: every other parent gets a lane of its own.
    for (const p of parents.slice(1)) if (!lanes.includes(p)) claim(p);
  }
  // Only lanes something was actually drawn in count towards the width.
  return { lane, laneCount: Math.max(1, used) };
}

// ---------------------------------------------------------------------------
// One commit's objects
// ---------------------------------------------------------------------------

interface ObjectGraph {
  /** Column index per object, by *longest* path from the root tree. */
  depth: Map<Oid, number>;
  /** Objects per column, in the order git lists them. */
  columns: Oid[][];
  edges: { from: Oid; to: Oid; label: string }[];
}

/**
 * Depth is the *longest* path from the root tree, so a blob shared between a
 * top-level file and a nested one sits at the deeper column and no arrow ever
 * points backwards.
 */
export function objectGraph(
  root: Oid,
  trees: Record<Oid, { name: string; oid: Oid; mode: string; type: string }[]>,
  folded: Set<Oid> = new Set(),
): ObjectGraph {
  const depth = new Map<Oid, number>([[root, 0]]);
  const order: Oid[] = [root];
  const edges = new Map<string, { from: Oid; to: Oid; label: string }>();
  const queue: Oid[] = folded.has(root) ? [] : [root];
  let guard = 20_000;

  while (queue.length > 0 && guard-- > 0) {
    const t = queue.shift()!;
    const d = depth.get(t)!;
    for (const e of trees[t] ?? []) {
      edges.set(`${t}>${e.oid}:${e.name}`, { from: t, to: e.oid, label: entryLabel(e) });
      if (!depth.has(e.oid)) order.push(e.oid);
      if ((depth.get(e.oid) ?? -1) < d + 1) {
        depth.set(e.oid, d + 1);
        // A folded tree is drawn, but nothing under it is: hidden means absent,
        // so what it holds leaves the scene rather than going invisible.
        if (e.type === 'tree' && trees[e.oid] && !folded.has(e.oid)) queue.push(e.oid);
      }
    }
  }

  const columns: Oid[][] = [];
  for (const oid of order) {
    const d = depth.get(oid)!;
    (columns[d] ??= []).push(oid);
  }
  for (let i = 0; i < columns.length; i++) columns[i] ??= [];
  return { depth, columns, edges: [...edges.values()] };
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export function layout(
  snap: Snapshot,
  view: View,
  pins: Record<string, { x: number; y: number }> = {},
  bandWidths: Record<string, number> = {},
): Scene {
  const commits = snap.window.commits;
  const { lane, laneCount } = assignLanes(commits, (o) => snap.commits[o]?.parents ?? []);
  const inWindow = new Set(commits);
  const expanded = new Set(view.expanded);
  const folded = new Set(view.folded ?? []);
  /** A folded tree looks like an empty one, so it says how much it holds. */
  const heldBack = (oid: Oid) => `tree +${snap.trees[oid]?.length ?? 0}`;
  const unreachable = new Set(snap.unreachable ?? []);
  const stagedOnly = new Set(snap.stagedOnly ?? []);

  // A band can be widened by hand — dragging the gap after it — when the
  // reader wants room to arrange pinned nodes. Never narrower than its content:
  // a band that cannot hold what it holds would spill into the next one.
  const widen = (key: string, natural: number) => Math.max(natural, bandWidths[key] ?? 0);

  // --- what each row holds, so we know how tall it is ---
  const graphs = new Map<Oid, ObjectGraph>();
  const chains = new Map<Oid, string[][]>(); // commit -> pointer chains, outermost first

  for (const oid of commits) {
    const c = snap.commits[oid];
    if (c && expanded.has(oid) && snap.trees[c.tree]) {
      graphs.set(oid, objectGraph(c.tree, snap.trees, folded));
    }
  }

  // A ref sits at the height of the commit it names. An annotated tag is a
  // name and a message pointing at an object, so it joins the pointer family.
  const headRef = snap.head.ref;
  const chainAt = (oid: Oid, chain: string[]) => {
    const list = chains.get(oid) ?? [];
    list.push(chain);
    chains.set(oid, list);
  };
  for (const r of snap.refs) {
    const target = r.target ?? r.oid;
    if (!inWindow.has(target)) continue; // counted in notes, never drawn dangling
    const chain: string[] = [];
    if (headRef === r.name) chain.push('HEAD');
    chain.push(`ref:${r.name}`);
    if (r.objectType === 'tag' && snap.tags[r.oid]) chain.push(`tag:${r.oid}`);
    chainAt(target, chain);
  }
  if (snap.head.detached && snap.head.oid && inWindow.has(snap.head.oid)) {
    chainAt(snap.head.oid, ['HEAD']);
  }

  // The gutter is a grid of chip columns and chains are right-aligned in it, so
  // its width is the longest chain there is — never the longest there could be.
  // `HEAD → branch` is two, and a repository with no annotated tags should not
  // pay for the third column all the way down the page.
  const chipCols = Math.min(
    GUTTER_COLS,
    Math.max(1, ...[...chains.values()].flat().map((c) => c.length)),
  );
  const gutterW = widen('pointers', M.gutterW - (GUTTER_COLS - chipCols) * M.chipPitch);
  const lanesX = M.gutterX + gutterW + M.bandGap;
  const lanesW = widen('commits', laneCount * M.laneW);
  const objectsX = lanesX + lanesW + M.bandGap;

  // `git add` writes a blob before anything points at it, and that blob is the
  // first thing the tutorial has to show. Down with the orphans it is off the
  // bottom of a page of history; up here it is beside the newest commit — where
  // the index chip holding it already sits, and where the commit that will name
  // it is about to appear. Blobs only: a staged tree fans out, and fanning out
  // is what the orphanage below is shaped for, and a blob any drawn tree names —
  // staged or orphaned — belongs to that tree's fan-out rather than up here on
  // its own, because that is where the arrow saying so can be drawn. `git
  // write-tree` is exactly this: the tree it writes is an orphan, and the blobs
  // still in the index are what it names.
  const orphans = view.showUnreachable === false ? [] : unreachable;
  const under = new Set(
    [...stagedOnly, ...orphans].flatMap((o) => (snap.trees[o] ?? []).map((e) => e.oid)),
  );
  const stagedTop = [...stagedOnly].filter(
    (o) => (snap.objects[o]?.type ?? 'blob') === 'blob' && !under.has(o),
  );

  const rows: { oid: Oid; y: number; h: number }[] = [];
  let y = 16 + (stagedTop.length > 0 ? stagedTop.length * M.objRowH + M.rowPad : 0);
  let maxColumns = 0;
  for (const oid of commits) {
    const g = graphs.get(oid);
    const objRows = g ? Math.max(...g.columns.map((c) => c.length), 1) : 0;
    maxColumns = Math.max(maxColumns, g ? g.columns.length : 0);
    const chainRows = chains.get(oid)?.length ?? 0;
    const h = Math.max(
      M.rowH,
      objRows * M.objRowH + M.rowPad,
      chainRows * (M.chipH + 6) + M.rowPad,
    );
    rows.push({ oid, y, h });
    y += h;
  }

  // Widened below if the orphans reach further right than any open commit does.
  let objectsW = Math.max(maxColumns, 1) * M.objColW;

  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const at = new Map<string, SceneNode>();
  const put = (n: SceneNode) => {
    const pin = pins[n.id];
    if (pin) {
      n.x = pin.x;
      n.y = pin.y;
      n.pinned = true;
    }
    nodes.push(n);
    at.set(n.id, n);
    return n;
  };

  // --- staged blobs, above everything, in the object band ---
  stagedTop.forEach((oid, i) => {
    put({
      id: oid,
      kind: 'blob',
      oid,
      x: objectsX,
      y: 16 + i * M.objRowH,
      w: M.objW,
      h: M.objH,
      label: short(oid),
      sub: 'blob',
      staged: true,
      stray: true,
    });
  });

  // --- commits, as dots in lanes ---
  for (const row of rows) {
    const l = lane.get(row.oid) ?? 0;
    put({
      id: row.oid,
      kind: 'commit',
      oid: row.oid,
      x: lanesX + l * M.laneW,
      y: row.y + M.rowPad,
      w: M.commitW,
      h: M.commitH,
      label: short(row.oid),
      unreachable: unreachable.has(row.oid),
    });
  }

  // Under a search, a parent outside the window is one that did not match, not
  // history waiting to be loaded — so it gets neither the arrow nor the button.
  const q = snap.view.question;
  const searching = q.kind === 'search' && q.text.length > 0;

  // --- the spine: commit to parent ---
  let danglingParents = 0;
  for (const oid of commits) {
    for (const p of snap.commits[oid]?.parents ?? []) {
      if (inWindow.has(p)) {
        edges.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
      } else if (!searching) {
        danglingParents++;
        edges.push({ id: `p:${oid}:more`, from: oid, to: 'more', kind: 'parent' });
      }
    }
  }

  // A parent outside the window is an arrow into "history continues", never a
  // silently dropped edge. A dangling arrow is honest, and it is also the cue.
  if (danglingParents > 0 || snap.window.more) {
    put({
      id: 'more',
      kind: 'more',
      x: lanesX,
      y: y + 8,
      w: 210,
      h: 30,
      label: 'load more history',
      sub: snap.window.totalCommits
        ? `${commits.length} of ${snap.window.totalCommits} commits`
        : `${commits.length} commits shown`,
    });
    y += 46;
  }

  // --- the pointer gutter ---
  for (const row of rows) {
    const list = chains.get(row.oid) ?? [];
    list.forEach((chain, i) => {
      const cy = row.y + M.rowPad + i * (M.chipH + 6);
      chain.forEach((id, j) => {
        // Right-aligned: the last hop sits nearest the commit it names.
        const col = Math.max(0, chipCols - (chain.length - j));
        const isHead = id === 'HEAD';
        const isTag = id.startsWith('tag:');
        // The tag object gets its sha and nothing else: the ref chip beside it
        // already carries the name, and a chip is one line tall.
        const name = isHead ? 'HEAD' : isTag ? short(id.slice(4)) : refLabel(id.slice(4));
        if (!at.has(id)) {
          put({
            id,
            kind: isHead ? 'head' : isTag ? 'tag' : 'ref',
            oid: isTag ? id.slice(4) : undefined,
            x: M.gutterX + col * M.chipPitch,
            y: cy,
            w: M.chipW,
            h: M.chipH,
            label: name,
            unreachable: isTag && unreachable.has(id.slice(4)),
          });
        }
        const next = chain[j + 1] ?? row.oid;
        edges.push({ id: `ptr:${id}:${next}`, from: id, to: next, kind: 'pointer' });
      });
    });
  }

  // An unborn HEAD has nothing to sit beside, so it sits alone at the top of
  // the gutter — a fresh `git init` is a pointer to a branch file that does not
  // exist yet, and that pointer is the whole picture until the first commit.
  if (snap.head.unborn && snap.head.ref && !at.has('HEAD')) {
    put({
      id: 'HEAD',
      kind: 'head',
      x: M.gutterX,
      y: 16,
      w: M.chipW,
      h: M.chipH + 8, // two lines: the name it holds is written under it
      label: 'HEAD',
      sub: refLabel(snap.head.ref),
    });
  }

  // --- objects, growing rightwards from their commit's row ---
  for (const row of rows) {
    const g = graphs.get(row.oid);
    if (!g) continue;
    const c = snap.commits[row.oid]!;
    g.columns.forEach((col, d) => {
      col.forEach((oid, i) => {
        if (at.has(oid)) return; // placed once, near the things that point at it
        const type = snap.objects[oid]?.type ?? (snap.trees[oid] ? 'tree' : 'blob');
        put({
          id: oid,
          kind: type === 'tree' ? 'tree' : type === 'commit' ? 'submodule' : 'blob',
          oid,
          x: objectsX + d * M.objColW,
          y: row.y + M.rowPad + i * M.objRowH,
          w: M.objW,
          h: M.objH,
          label: short(oid),
          sub: type !== 'tree' ? 'blob' : folded.has(oid) ? heldBack(oid) : 'tree',
          folded: type === 'tree' && folded.has(oid),
          unreachable: unreachable.has(oid),
          origin: d === 0 ? row.oid : undefined,
        });
      });
    });
    edges.push({ id: `t:${row.oid}`, from: row.oid, to: c.tree, kind: 'tree' });
    for (const e of g.edges) {
      if (!at.has(e.to)) continue;
      edges.push({ id: `e:${e.from}:${e.to}:${e.label}`, from: e.from, to: e.to, kind: 'entry', label: e.label });
    }
  }

  // --- objects nothing on screen points at ---
  //
  // Orphaned together, drawn together, and drawn in the bands everything else
  // uses: a discarded commit carries on down the commit band as a ghost, its
  // tree fans out to the right of it exactly as an open commit's does, and what
  // no orphaned commit or tree names any more hangs below, from the object
  // band's first column. Losing its last referrer does not make a commit forget
  // its own tree — that is how you see a whole discarded state sitting there
  // intact, waiting for gc. Links out to objects that are still reachable are
  // dropped: they would cross the picture to say what the ghost already says.
  //
  // A staged object comes down here too, solid rather than a ghost: `git add`
  // wrote a real blob, and the index chip beside it is the only thing holding
  // it. Objects do not vanish because something started pointing at them.
  // Hidden means absent, so switching orphans off takes them out of the scene
  // the way a fold does. A staged object is held by the index, not orphaned,
  // and stays.
  const strays = [...orphans, ...stagedOnly].filter((oid) => !at.has(oid));
  if (strays.length > 0) {
    const strayed = new Set(strays);
    // The orphaned set's own subgraph, cut once here: entries pointing back
    // into reachable territory are gone, and everything below follows what is
    // left, through the same objectGraph the live commits go through.
    const strayTrees: Record<Oid, TreeEntry[]> = {};
    for (const oid of strays) {
      if (snap.trees[oid]) strayTrees[oid] = snap.trees[oid].filter((e) => strayed.has(e.oid));
    }

    // What that cut throws away, drawn back on request. The arrow crosses the
    // whole picture, which is why it is off by default — but it is the answer
    // to "what does gc actually free": a discarded state shares almost every
    // blob with the live one, and only the objects down here on their own are
    // its own. The node is already on screen where something reachable names
    // it, so this adds an arrow and moves nothing. A folded tree says nothing
    // about its entries, here as anywhere.
    if (view.showCrossLinks) {
      for (const oid of strays) {
        // A discarded commit still names its parent, and after a reset that
        // parent is usually still on a branch: the arrow is the whole point of
        // "the old tip is still there, hanging off the one you moved to".
        for (const p of snap.commits[oid]?.parents ?? []) {
          if (!strayed.has(p)) edges.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
        }
        if (folded.has(oid)) continue;
        for (const e of snap.trees[oid] ?? []) {
          if (strayed.has(e.oid)) continue;
          edges.push({ id: `x:${oid}:${e.oid}:${e.name}`, from: oid, to: e.oid, kind: 'entry', label: e.name });
        }
      }
    }

    let cursor = y + 24;
    // A pinned stray stays where it was drawn, so it reserves no room down here.
    let bottom = y;
    let strayCols = 0;

    /** One root's objects, in columns to the right of `top`. Returns its height. */
    const objectRow = (top: number, g: ObjectGraph, from?: string) => {
      g.columns.forEach((col, d) => {
        col.forEach((oid, i) => {
          if (at.has(oid)) return;
          const type = snap.objects[oid]?.type ?? (strayTrees[oid] ? 'tree' : 'blob');
          const n = put({
            id: oid,
            kind: type === 'tree' ? 'tree' : type === 'commit' ? 'submodule' : 'blob',
            oid,
            x: objectsX + d * M.objColW,
            y: top + i * M.objRowH,
            w: M.objW,
            h: M.objH,
            label: short(oid),
            sub: type === 'tree' && folded.has(oid) ? heldBack(oid) : type,
            folded: type === 'tree' && folded.has(oid),
            unreachable: unreachable.has(oid),
            staged: stagedOnly.has(oid),
            stray: true,
            origin: d === 0 ? from : undefined,
          });
          bottom = Math.max(bottom, n.y + n.h);
        });
      });
      for (const e of g.edges) {
        edges.push({ id: `e:${e.from}:${e.to}:${e.label}`, from: e.from, to: e.to, kind: 'entry', label: e.label });
      }
      strayCols = Math.max(strayCols, g.columns.length);
      return Math.max(M.rowH, Math.max(...g.columns.map((c) => c.length), 1) * M.objRowH + M.rowPad);
    };

    // Orphaned commits carry on down the commit band, in the first lane.
    // ponytail: newest first by date, not topologically — a skewed clock could
    // draw a parent above its child. rev-list does not reach down here, and a
    // second lane sweep to fix an arrow direction is not worth the width.
    const strayCommits = strays
      .filter((oid) => snap.commits[oid])
      .sort((a, b) => snap.commits[b].authorDate - snap.commits[a].authorDate || a.localeCompare(b));
    for (const oid of strayCommits) {
      const c = snap.commits[oid];
      const n = put({
        id: oid,
        kind: 'commit',
        oid,
        x: lanesX,
        y: cursor + M.rowPad,
        w: M.commitW,
        h: M.commitH,
        label: short(oid),
        unreachable: unreachable.has(oid),
        stray: true,
      });
      bottom = Math.max(bottom, n.y + n.h);
      let h = M.rowH;
      if (strayed.has(c.tree)) {
        edges.push({ id: `t:${oid}`, from: oid, to: c.tree, kind: 'tree' });
        h = objectRow(cursor + M.rowPad, objectGraph(c.tree, strayTrees, folded), oid);
      }
      // One lane, so a parent arrow is the same straight drop it is above.
      for (const p of c.parents) {
        if (strayed.has(p)) edges.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
      }
      rows.push({ oid, y: cursor, h });
      cursor += h;
    }

    // Trees and blobs with no orphaned parent left: they dangle, one root per
    // row, never in the commit band — only commits live over there. Roots
    // first, whatever order they arrived in: a blob laid down before the tree
    // that names it takes the first column and leaves the tree stacked under
    // it, instead of the tree fanning out rightwards into it.
    // Whatever a fold above left undrawn turns up here: an unreachable object is
    // never silently dropped, so folding a ghost tree moves its entries into the
    // dangling band rather than taking them off the screen.
    const named = new Set(Object.values(strayTrees).flat().map((e) => e.oid));
    const roots = [...strays].sort((a, b) => Number(named.has(a)) - Number(named.has(b)));
    for (const oid of roots) {
      if (at.has(oid) || snap.tags[oid]) continue;
      cursor += objectRow(cursor, objectGraph(oid, strayTrees, folded));
    }

    // A tag is a pointer, so it goes in the pointer gutter beside the thing it
    // names, exactly as a live one does above. Nothing left to name, and it
    // joins the danglers.
    const stacked = new Map<Oid, number>();
    for (const oid of strays) {
      if (at.has(oid)) continue; // by now, only tags are left
      const t = snap.tags[oid];
      const target = strayed.has(t.target) ? at.get(t.target) : undefined;
      const i = stacked.get(t.target) ?? 0;
      stacked.set(t.target, i + 1);
      const n = put({
        id: oid,
        kind: 'tag',
        oid,
        x: target ? M.gutterX + (chipCols - 1) * M.chipPitch : objectsX,
        y: target ? target.y + i * (M.chipH + 6) : cursor,
        w: target ? M.chipW : M.objW,
        h: target ? M.chipH : M.objH,
        label: short(oid),
        sub: target ? undefined : 'tag',
        unreachable: true,
        stray: true,
      });
      if (target) edges.push({ id: `ptr:${oid}:${t.target}`, from: oid, to: t.target, kind: 'pointer' });
      else cursor += M.objRowH;
      bottom = Math.max(bottom, n.y + n.h);
    }

    objectsW = Math.max(objectsW, strayCols * M.objColW);
    y = Math.max(y, bottom + 16);
  }

  // --- the index, apart, at the far right ---
  objectsW = widen('objects', objectsW);
  const indexX = objectsX + objectsW + M.bandGap;
  // The index is the last band, so it can simply grow to hold what is dragged
  // into it: a path pulled rightwards stays inside its own column rather than
  // hanging off the end of the picture.
  let indexW = M.indexW;
  if (view.showIndex) {
    const placed = snap.index
      .map((e) => ({ e, blob: at.get(e.oid) }))
      .sort((a, b) => (a.blob?.y ?? Infinity) - (b.blob?.y ?? Infinity));
    let cursor = 16;
    for (const { e, blob } of placed) {
      const wanted = blob ? blob.y : cursor;
      const iy = Math.max(wanted, cursor);
      cursor = iy + M.indexH + M.indexGap;
      const id = `index:${e.stage}:${e.path}`;
      const n = put({
        id,
        kind: 'index',
        oid: e.oid,
        x: indexX,
        y: iy,
        w: M.indexW,
        h: M.indexH,
        label: e.path,
        sub: short(e.oid) + (e.stage ? `  stage ${e.stage}` : ''),
        conflict: e.stage !== 0,
      });
      indexW = Math.max(indexW, n.x + n.w - indexX);
      if (blob) edges.push({ id: `s:${id}`, from: id, to: e.oid, kind: 'stage' });
    }
    y = Math.max(y, cursor);
  }

  const height = Math.max(y + 40, 200);
  return {
    nodes,
    edges: edges.filter((e) => at.has(e.from) && at.has(e.to)),
    bands: [
      { key: 'pointers', label: 'pointers and tags', x: M.gutterX, w: gutterW },
      { key: 'commits', label: 'commits', x: lanesX, w: lanesW },
      { key: 'objects', label: 'trees and blobs', x: objectsX, w: objectsW },
      ...(view.showIndex
        ? [{ key: 'index' as const, label: 'index', x: indexX, w: indexW }]
        : []),
    ],
    width: (view.showIndex ? indexX + indexW : objectsX + objectsW) + 40,
    height,
    rows,
  };
}
