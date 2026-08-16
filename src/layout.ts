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

import type { Oid, Snapshot, View } from './types.js';

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

const short = (oid: Oid) => oid.slice(0, 7);
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
export function objectGraph(root: Oid, trees: Record<Oid, { name: string; oid: Oid; mode: string; type: string }[]>): ObjectGraph {
  const depth = new Map<Oid, number>([[root, 0]]);
  const order: Oid[] = [root];
  const edges = new Map<string, { from: Oid; to: Oid; label: string }>();
  const queue: Oid[] = [root];
  let guard = 20_000;

  while (queue.length > 0 && guard-- > 0) {
    const t = queue.shift()!;
    const d = depth.get(t)!;
    for (const e of trees[t] ?? []) {
      edges.set(`${t}>${e.oid}:${e.name}`, {
        from: t,
        to: e.oid,
        label: `${e.name}${e.mode === '100755' ? ' +x' : e.mode === '120000' ? ' ->' : ''}`,
      });
      if (!depth.has(e.oid)) order.push(e.oid);
      if ((depth.get(e.oid) ?? -1) < d + 1) {
        depth.set(e.oid, d + 1);
        if (e.type === 'tree' && trees[e.oid]) queue.push(e.oid);
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
): Scene {
  const commits = snap.window.commits;
  const { lane, laneCount } = assignLanes(commits, (o) => snap.commits[o]?.parents ?? []);
  const inWindow = new Set(commits);
  const expanded = new Set(view.expanded);
  const unreachable = new Set(snap.unreachable ?? []);

  const lanesX = M.gutterX + M.gutterW + M.bandGap;
  const lanesW = laneCount * M.laneW;
  const objectsX = lanesX + lanesW + M.bandGap;

  // --- what each row holds, so we know how tall it is ---
  const graphs = new Map<Oid, ObjectGraph>();
  const chains = new Map<Oid, string[][]>(); // commit -> pointer chains, outermost first

  for (const oid of commits) {
    const c = snap.commits[oid];
    if (c && expanded.has(oid) && snap.trees[c.tree]) {
      graphs.set(oid, objectGraph(c.tree, snap.trees));
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

  const rows: { oid: Oid; y: number; h: number }[] = [];
  let y = 16;
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

  const objectsW = Math.max(maxColumns, 1) * M.objColW;
  const indexX = objectsX + objectsW + M.bandGap;

  const nodes: SceneNode[] = [];
  const edges: SceneEdge[] = [];
  const at = new Map<string, SceneNode>();
  const put = (n: SceneNode) => {
    const pin = pins[n.id];
    if (pin) {
      n.x = pin.x;
      n.y = pin.y;
    }
    nodes.push(n);
    at.set(n.id, n);
    return n;
  };

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

  // --- the spine: commit to parent ---
  let danglingParents = 0;
  for (const oid of commits) {
    for (const p of snap.commits[oid]?.parents ?? []) {
      if (inWindow.has(p)) {
        edges.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
      } else {
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
      label: 'history continues',
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
        const col = Math.max(0, 3 - (chain.length - j));
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
          sub: type === 'tree' ? 'tree' : 'blob',
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

  // --- unreachable objects nothing on screen points at ---
  const strays = [...unreachable].filter((oid) => !at.has(oid));
  if (strays.length > 0) {
    const perRow = Math.max(1, Math.floor(objectsW / M.objColW));
    y += 24;
    strays.forEach((oid, i) => {
      const type = snap.objects[oid]?.type ?? 'blob';
      put({
        id: oid,
        kind: type === 'tree' ? 'tree' : type === 'commit' ? 'commit' : type === 'tag' ? 'tag' : 'blob',
        oid,
        x: objectsX + (i % perRow) * M.objColW,
        y: y + Math.floor(i / perRow) * M.objRowH,
        w: M.objW,
        h: M.objH,
        label: short(oid),
        sub: type,
        unreachable: true,
      });
    });
    y += Math.ceil(strays.length / perRow) * M.objRowH + 16;
  }

  // --- the index, apart, at the far right ---
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
      put({
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
      if (blob) edges.push({ id: `s:${id}`, from: id, to: e.oid, kind: 'stage' });
    }
    y = Math.max(y, cursor);
  }

  const height = Math.max(y + 40, 200);
  return {
    nodes,
    edges: edges.filter((e) => at.has(e.from) && at.has(e.to)),
    bands: [
      { key: 'pointers', label: 'pointers', x: M.gutterX, w: M.gutterW },
      { key: 'commits', label: 'commits', x: lanesX, w: lanesW },
      { key: 'objects', label: 'objects', x: objectsX, w: objectsW },
      ...(view.showIndex
        ? [{ key: 'index' as const, label: 'index', x: indexX, w: M.indexW }]
        : []),
    ],
    width: (view.showIndex ? indexX + M.indexW : objectsX + objectsW) + 40,
    height,
    rows,
  };
}
