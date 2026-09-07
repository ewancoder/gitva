/**
 * Where everything goes.
 *
 * Positions are a pure function of the step being drawn — never of what was
 * on screen before, never of the order things were processed. That property is
 * what makes change highlighting legible: a shape that flashes *and* moves
 * teaches nothing. Nothing in here knows how anything is painted.
 *
 * gitva draws exactly two structures, a commit DAG and a directory tree, and
 * both have known good layouts. That is why there is no general graph engine
 * here: generality bought nothing and cost slow, jumpy and generic-looking.
 */

import { entryId } from './explain.js';
import { S } from './localization/index.js';
import type { Oid, Step, TreeEntry, View } from '../src/types.js';

export type ShapeKind = 'commit' | 'tree' | 'blob' | 'submodule' | 'tag' | 'ref' | 'head' | 'index';

export interface Shape {
    id: string;
    kind: ShapeKind;
    oid?: Oid;
    x: number;
    y: number;
    w: number;
    h: number;
    /** What is written on the shape: a short sha, or a name. */
    label: string;
    /** Row text drawn beside a commit, or the path on an index chip. */
    sub?: string;
    unreachable?: boolean;
    conflict?: boolean;
    /** A tree drawn without its entries: you collapsed it shut. */
    collapsed?: boolean;
    /** Put down here because nothing on screen points at it, not beside anything. */
    stray?: boolean;
    /** You dragged this one somewhere by hand; the painter says so. */
    pinned?: boolean;
    /** Only the index holds this: written, not committed, and safe from gc while
     *  the entry beside it lasts. A state, like `unreachable`, not a kind. */
    staged?: boolean;
    /** Where this shape came from, so it can grow out of it rather than fly in. */
    origin?: string;
}

export interface Link {
    id: string;
    from: string;
    to: string;
    kind: 'parent' | 'tree' | 'entry' | 'pointer' | 'stage';
    label?: string;
}

export interface Column {
    key: 'pointersAndTags' | 'commits' | 'treesAndBlobs' | 'index';
    label: string;
    x: number;
    w: number;
}

export interface Scene {
    shapes: Shape[];
    links: Link[];
    columns: Column[];
    /**
     * The top left of everything, and the size from there. Zero unless a shape was
     * pinned above or left of the columns: the scene is what the camera may be panned
     * over, so it has to reach wherever a shape was dragged to.
     */
    x: number;
    y: number;
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
    // clear it: the sha is written in the shape, not in a column beside it.
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
    columnGap: 28,
};

/** HEAD → branch → tag object: the longest a pointer chain can get. */
const GUTTER_COLS = 3;

const short = (oid: Oid) => oid.slice(0, 7);
/** The name is in the tree, never in the blob — so the link carries it. */
const entryLabel = (e: { name: string; mode: string }) =>
    `${e.name}${e.mode === '100755' ? ' +x' : e.mode === '120000' ? ' ->' : ''}`;
const refLabel = (name: string) =>
    name
        .replace(/^refs\/heads\//, '')
        .replace(/^refs\/tags\//, S.canvas.tagPrefix)
        .replace(/^refs\//, '');

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
        // what made the object graph creep rightwards on every branch point.
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
    /** Objects per level, in the order git lists them. */
    levels: Oid[][];
    links: { from: Oid; to: Oid; label: string }[];
}

/**
 * Depth is the *longest* path from the root tree, so a blob shared between a
 * top-level file and a nested one sits at the deeper level and no link ever
 * points backwards.
 */
export function objectGraph(
    root: Oid,
    trees: Record<Oid, { name: string; oid: Oid; mode: string; type: string }[]>,
    collapsed: Set<Oid> = new Set(),
): ObjectGraph {
    const depth = new Map<Oid, number>([[root, 0]]);
    const order: Oid[] = [root];
    // One blob can sit in a tree under several names — same from, same to, one
    // link, so the names go on it together rather than on top of each other.
    const links = new Map<string, { from: Oid; to: Oid; names: Set<string> }>();
    const queue: Oid[] = collapsed.has(root) ? [] : [root];
    let guard = 20_000;

    while (queue.length > 0 && guard-- > 0) {
        const t = queue.shift()!;
        const d = depth.get(t)!;
        for (const e of trees[t] ?? []) {
            const key = `${t}>${e.oid}`;
            let link = links.get(key);
            if (!link) links.set(key, (link = { from: t, to: e.oid, names: new Set<string>() }));
            link.names.add(entryLabel(e));
            if (!depth.has(e.oid)) order.push(e.oid);
            if ((depth.get(e.oid) ?? -1) < d + 1) {
                depth.set(e.oid, d + 1);
                // A collapsed tree is drawn, but nothing under it is: hidden means absent,
                // so what it holds leaves the scene rather than going invisible.
                if (e.type === 'tree' && trees[e.oid] && !collapsed.has(e.oid)) queue.push(e.oid);
            }
        }
    }

    const levels: Oid[][] = [];
    for (const oid of order) {
        const d = depth.get(oid)!;
        (levels[d] ??= []).push(oid);
    }
    for (let i = 0; i < levels.length; i++) levels[i] ??= [];
    return {
        depth,
        levels,
        links: [...links.values()].map(({ from, to, names }) => ({
            from,
            to,
            label: [...names].join(', '),
        })),
    };
}

// ---------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------

export function layout(
    step: Step,
    view: View,
    pins: Record<string, { x: number; y: number }> = {},
    columnWidths: Record<string, number> = {},
): Scene {
    const commits = step.window.commits;
    const { lane, laneCount } = assignLanes(commits, (o) => step.commits[o]?.parents ?? []);
    const inWindow = new Set(commits);
    const expanded = new Set(view.expanded);
    const collapsed = new Set(view.collapsed ?? []);
    /** A collapsed tree looks like an empty one, so it says how much it holds. */
    const heldBack = (oid: Oid) => S.canvas.heldBack(step.trees[oid]?.length ?? 0);
    const unreachable = new Set(step.unreachable ?? []);
    const stagedOnly = new Set(step.stagedOnly ?? []);
    /** A submodule's commit is in another repository, so `step.objects` will never
     *  hold it. The entry that names it — mode 160000 — is the only thing that
     *  knows what it is. */
    const gitlinks = new Set(
        Object.values(step.trees).flatMap((es) =>
            es.filter((e) => e.type === 'commit').map((e) => e.oid),
        ),
    );
    const typeOf = (oid: Oid, trees: Record<Oid, unknown>) =>
        gitlinks.has(oid) ? 'commit' : (step.objects[oid]?.type ?? (trees[oid] ? 'tree' : 'blob'));

    // A column can be widened by hand — dragging the gap after it — when the
    // you want room to arrange pinned shapes. Never narrower than its content:
    // a column that cannot hold what it holds would spill into the next one.
    const widen = (key: string, natural: number) => Math.max(natural, columnWidths[key] ?? 0);

    // --- what each row holds, so we know how tall it is ---
    const graphs = new Map<Oid, ObjectGraph>();
    const chains = new Map<Oid, string[][]>(); // commit -> pointer chains, outermost first

    for (const oid of commits) {
        const c = step.commits[oid];
        if (c && expanded.has(oid) && step.trees[c.tree]) {
            graphs.set(oid, objectGraph(c.tree, step.trees, collapsed));
        }
    }

    // A ref sits at the height of the commit it names. An annotated tag is a
    // name and a message pointing at an object, so it joins the pointer family.
    const headRef = step.head.ref;
    const chainAt = (oid: Oid, chain: string[]) => {
        const list = chains.get(oid) ?? [];
        list.push(chain);
        chains.set(oid, list);
    };
    for (const r of step.refs) {
        const target = r.target ?? r.oid;
        if (!inWindow.has(target)) continue; // counted in notes, never drawn as a stray
        const chain: string[] = [];
        if (headRef === r.name) chain.push('HEAD');
        chain.push(`ref:${r.name}`);
        if (r.objectType === 'tag' && step.tags[r.oid]) chain.push(`tag:${r.oid}`);
        chainAt(target, chain);
    }
    if (step.head.detached && step.head.oid && inWindow.has(step.head.oid)) {
        chainAt(step.head.oid, ['HEAD']);
    }

    // The gutter is a grid of chip columns and chains are right-aligned in it, so
    // its width is the longest chain there is — never the longest there could be.
    // `HEAD → branch` is two, and a repository with no annotated tags should not
    // pay for the third column all the way down the page.
    const chipCols = Math.min(
        GUTTER_COLS,
        Math.max(1, ...[...chains.values()].flat().map((c) => c.length)),
    );
    const gutterW = widen('pointersAndTags', M.gutterW - (GUTTER_COLS - chipCols) * M.chipPitch);
    const lanesX = M.gutterX + gutterW + M.columnGap;
    const lanesW = widen('commits', laneCount * M.laneW);
    const objectsX = lanesX + lanesW + M.columnGap;

    // `git add` writes a blob before anything points at it, and that blob is the
    // first thing the tutorial has to show. Down with the unreachable it is off the
    // bottom of a page of history; up here it is beside the newest commit — where
    // the index chip holding it already sits, and where the commit that will name
    // it is about to appear. Blobs only: a staged tree fans out, and fanning out
    // is what the stray region below is shaped for, and a blob any drawn tree names —
    // staged or unreachable — belongs to that tree's fan-out rather than up here on
    // its own, because that is where the link saying so can be drawn. `git
    // write-tree` is exactly this: the tree it writes is unreachable, and the
    // blobs still in the index are what it names.
    const shownUnreachable = view.showUnreachable === false ? new Set<Oid>() : unreachable;
    const under = new Set(
        [...stagedOnly, ...shownUnreachable].flatMap((o) =>
            (step.trees[o] ?? []).map((e) => e.oid),
        ),
    );
    const stagedTop = [...stagedOnly].filter(
        (o) => (step.objects[o]?.type ?? 'blob') === 'blob' && !under.has(o),
    );

    // The same band, reached from the other end: expanding an index entry draws the
    // blob its sha names, beside the chip that names it. It is the index read
    // forwards — a path holds a sha, and this is the object that sha is — without
    // opening the commit that happens to name it too. Nothing that is already
    // drawn somewhere is drawn again: an expanded commit keeps its blob down in
    // the fan-out where the tree entry naming it can be drawn, and a staged or
    // unreachable one keeps its place below. The gesture is on the entry and never
    // on the blob, because one blob can sit in every tree in the window and there
    // is no gesture worth making that draws them all.
    const inGraphs = new Set([...graphs.values()].flatMap((g) => g.levels.flat()));
    const revealed = (view.showIndex ? step.index : [])
        .filter((e) => expanded.has(entryId(e.path, e.stage)))
        .map((e) => e.oid)
        .filter((o) => !inGraphs.has(o) && !stagedOnly.has(o) && !shownUnreachable.has(o));
    const top = [...new Set([...stagedTop, ...revealed])];

    const rows: { oid: Oid; y: number; h: number }[] = [];
    let y = 16 + (top.length > 0 ? top.length * M.objRowH + M.rowPad : 0);
    let maxLevels = 0;
    for (const oid of commits) {
        const g = graphs.get(oid);
        const objRows = g ? Math.max(...g.levels.map((c) => c.length), 1) : 0;
        maxLevels = Math.max(maxLevels, g ? g.levels.length : 0);
        const chainRows = chains.get(oid)?.length ?? 0;
        const h = Math.max(
            M.rowH,
            objRows * M.objRowH + M.rowPad,
            chainRows * (M.chipH + 6) + M.rowPad,
        );
        rows.push({ oid, y, h });
        y += h;
    }

    // Widened below if the unreachable reach further right than any open commit does.
    let objectsW = Math.max(maxLevels, 1) * M.objColW;

    const shapes: Shape[] = [];
    const links: Link[] = [];
    const at = new Map<string, Shape>();
    const put = (shape: Shape) => {
        const pin = pins[shape.id];
        if (pin) {
            shape.x = pin.x;
            shape.y = pin.y;
            shape.pinned = true;
        }
        shapes.push(shape);
        at.set(shape.id, shape);
        return shape;
    };

    // --- blobs the index is holding, above everything, in the object column ---
    top.forEach((oid, i) => {
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
            staged: stagedOnly.has(oid),
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

    // --- the spine: commit to parent ---
    // A parent outside the window is not drawn: there is nothing on screen to
    // draw it to, and no button to load it with — the window is the run's, fixed
    // when the step was made. The notes toolbar says how many commits are shown.
    for (const oid of commits) {
        for (const p of step.commits[oid]?.parents ?? []) {
            if (inWindow.has(p))
                links.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
        }
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
                links.push({ id: `ptr:${id}:${next}`, from: id, to: next, kind: 'pointer' });
            });
        });
    }

    // An unborn HEAD has nothing to sit beside, so it sits alone at the top of
    // the gutter — a fresh `git init` is a pointer to a branch file that does not
    // exist yet, and that pointer is the whole canvas until the first commit.
    if (step.head.unborn && step.head.ref && !at.has('HEAD')) {
        put({
            id: 'HEAD',
            kind: 'head',
            x: M.gutterX,
            y: 16,
            w: M.chipW,
            h: M.chipH + 8, // two lines: the name it holds is written under it
            label: 'HEAD',
            sub: refLabel(step.head.ref),
        });
    }

    // --- objects, growing rightwards from their commit's row ---
    for (const row of rows) {
        const g = graphs.get(row.oid);
        if (!g) continue;
        const c = step.commits[row.oid];
        g.levels.forEach((col, d) => {
            col.forEach((oid, i) => {
                if (at.has(oid)) return; // placed once, near the things that point at it
                const type = typeOf(oid, step.trees);
                put({
                    id: oid,
                    kind: type === 'tree' ? 'tree' : type === 'commit' ? 'submodule' : 'blob',
                    oid,
                    x: objectsX + d * M.objColW,
                    y: row.y + M.rowPad + i * M.objRowH,
                    w: M.objW,
                    h: M.objH,
                    label: short(oid),
                    sub: type === 'tree' && collapsed.has(oid) ? heldBack(oid) : type,
                    collapsed: type === 'tree' && collapsed.has(oid),
                    unreachable: unreachable.has(oid),
                    origin: d === 0 ? row.oid : undefined,
                });
            });
        });
        links.push({ id: `t:${row.oid}`, from: row.oid, to: c.tree, kind: 'tree' });
        for (const e of g.links) {
            if (!at.has(e.to)) continue;
            links.push({
                id: `e:${e.from}:${e.to}:${e.label}`,
                from: e.from,
                to: e.to,
                kind: 'entry',
                label: e.label,
            });
        }
    }

    // --- objects nothing on screen points at ---
    //
    // Unreachable together, drawn together, and drawn in the columns everything else
    // uses: a discarded commit carries on down the commit column as a ghost, its
    // tree fans out to the right of it exactly as an open commit's does, and what
    // no unreachable commit or tree names any more hangs below, from the trees-and-blobs
    // column's first level. Losing its last referrer does not make a commit forget
    // its own tree — that is how you see a whole discarded commit sitting there
    // intact, waiting for gc. Links out to objects that are still reachable are
    // dropped: they would cross the canvas to say what the ghost already says.
    //
    // A staged object comes down here too, solid rather than a ghost: `git add`
    // wrote a real blob, and the index chip beside it is the only thing holding
    // it. Objects do not vanish because something started pointing at them.
    // Hidden means absent, so switching the unreachable off takes them out of the scene
    // the way a collapse does. A staged object is held by the index, not unreachable,
    // and stays.
    const strays = [...shownUnreachable, ...stagedOnly].filter((oid) => !at.has(oid));
    if (strays.length > 0) {
        const strayed = new Set(strays);
        // The unreachable set's own subgraph, cut once here: entries pointing back
        // into reachable territory are gone, and everything below follows what is
        // left, through the same objectGraph the live commits go through.
        const strayTrees: Record<Oid, TreeEntry[]> = {};
        for (const oid of strays) {
            if (step.trees[oid])
                strayTrees[oid] = step.trees[oid].filter((e) => strayed.has(e.oid));
        }

        // What that cut throws away, drawn back on request. The link crosses the
        // whole canvas, which is why it is off by default — but it is the answer
        // to "what does gc actually free": a discarded commit shares almost every
        // blob with the live one, and only the objects down here on their own are
        // its own. The shape is already on screen where something reachable names
        // it, so this adds a link and moves nothing. A collapsed tree says nothing
        // about its entries, here as anywhere.
        if (view.showLinksFromUnreachable) {
            for (const oid of strays) {
                // A discarded commit still names its parent, and after a reset that
                // parent is usually still on a branch: the link is the whole point of
                // "the old tip is still there, hanging off the one you moved to".
                for (const p of step.commits[oid]?.parents ?? []) {
                    if (!strayed.has(p))
                        links.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
                }
                // And it still names its own tree, which after a reset is usually the
                // tree the live commit shares: the discarded commit is intact, and the
                // link is the only thing on screen saying gc would free none of it.
                const tree = step.commits[oid]?.tree;
                if (tree !== undefined && !strayed.has(tree))
                    links.push({ id: `t:${oid}`, from: oid, to: tree, kind: 'tree' });
                if (collapsed.has(oid)) continue;
                const names = new Map<Oid, string[]>();
                for (const e of step.trees[oid] ?? []) {
                    if (strayed.has(e.oid)) continue;
                    names.set(e.oid, [...(names.get(e.oid) ?? []), e.name]);
                }
                for (const [to, ns] of names) {
                    links.push({
                        id: `x:${oid}:${to}`,
                        from: oid,
                        to,
                        kind: 'entry',
                        label: ns.join(', '),
                    });
                }
            }
        }

        let cursor = y + 24;
        // A pinned stray stays where it was drawn, so it reserves no room down here.
        let bottom = y;
        let strayCols = 0;

        /** One root's objects, in levels to the right of `top`. Returns its height. */
        const objectRow = (top: number, g: ObjectGraph, from?: string) => {
            g.levels.forEach((col, d) => {
                col.forEach((oid, i) => {
                    if (at.has(oid)) return;
                    const type = typeOf(oid, strayTrees);
                    const n = put({
                        id: oid,
                        kind: type === 'tree' ? 'tree' : type === 'commit' ? 'submodule' : 'blob',
                        oid,
                        x: objectsX + d * M.objColW,
                        y: top + i * M.objRowH,
                        w: M.objW,
                        h: M.objH,
                        label: short(oid),
                        sub: type === 'tree' && collapsed.has(oid) ? heldBack(oid) : type,
                        collapsed: type === 'tree' && collapsed.has(oid),
                        unreachable: unreachable.has(oid),
                        staged: stagedOnly.has(oid),
                        stray: true,
                        origin: d === 0 ? from : undefined,
                    });
                    bottom = Math.max(bottom, n.y + n.h);
                });
            });
            for (const e of g.links) {
                links.push({
                    id: `e:${e.from}:${e.to}:${e.label}`,
                    from: e.from,
                    to: e.to,
                    kind: 'entry',
                    label: e.label,
                });
            }
            strayCols = Math.max(strayCols, g.levels.length);
            return Math.max(
                M.rowH,
                Math.max(...g.levels.map((c) => c.length), 1) * M.objRowH + M.rowPad,
            );
        };

        // Unreachable commits carry on down the commit column, in the first lane.
        // ponytail: newest first by date, not topologically — a skewed clock could
        // draw a parent above its child. rev-list does not reach down here, and a
        // second lane sweep to fix a link direction is not worth the width.
        const strayCommits = strays
            .filter((oid) => step.commits[oid])
            .sort(
                (a, b) =>
                    step.commits[b].authorDate - step.commits[a].authorDate || a.localeCompare(b),
            );
        for (const oid of strayCommits) {
            const c = step.commits[oid];
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
                links.push({ id: `t:${oid}`, from: oid, to: c.tree, kind: 'tree' });
                h = objectRow(cursor + M.rowPad, objectGraph(c.tree, strayTrees, collapsed), oid);
            }
            // One lane, so a parent link is the same straight drop it is above.
            for (const p of c.parents) {
                if (strayed.has(p))
                    links.push({ id: `p:${oid}:${p}`, from: oid, to: p, kind: 'parent' });
            }
            rows.push({ oid, y: cursor, h });
            cursor += h;
        }

        // Trees and blobs with no unreachable parent left: they are strays, one root per
        // row, never in the commit column — only commits live over there. Roots
        // first, whatever order they arrived in: a blob laid down before the tree
        // that names it takes the first column and leaves the tree stacked under
        // it, instead of the tree fanning out rightwards into it.
        // Whatever a collapse above left undrawn turns up here: an unreachable object is
        // never silently dropped, so collapsing a ghost tree moves its entries into the
        // stray column rather than taking them off the screen.
        const named = new Set(
            Object.values(strayTrees)
                .flat()
                .map((e) => e.oid),
        );
        const roots = [...strays].sort((a, b) => Number(named.has(a)) - Number(named.has(b)));
        for (const oid of roots) {
            if (at.has(oid) || step.tags[oid]) continue;
            cursor += objectRow(cursor, objectGraph(oid, strayTrees, collapsed));
        }

        // A tag is a pointer, so it goes in the pointer gutter beside the thing it
        // names, exactly as a live one does above. Nothing left to name, and it
        // joins the strays.
        const stacked = new Map<Oid, number>();
        for (const oid of strays) {
            if (at.has(oid)) continue; // by now, only tags are left
            const t = step.tags[oid];
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
            if (target)
                links.push({
                    id: `ptr:${oid}:${t.target}`,
                    from: oid,
                    to: t.target,
                    kind: 'pointer',
                });
            else cursor += M.objRowH;
            bottom = Math.max(bottom, n.y + n.h);
        }

        objectsW = Math.max(objectsW, strayCols * M.objColW);
        y = Math.max(y, bottom + 16);
    }

    // --- the index, apart, at the far right ---
    objectsW = widen('treesAndBlobs', objectsW);
    const indexX = objectsX + objectsW + M.columnGap;
    // The index is the last column, so it can simply grow to hold what is dragged
    // into it: a path pulled rightwards stays inside its own column rather than
    // hanging off the end of the canvas.
    let indexW = M.indexW;
    if (view.showIndex) {
        const placed = step.index
            .map((e) => ({ e, blob: at.get(e.oid) }))
            .sort((a, b) => (a.blob?.y ?? Infinity) - (b.blob?.y ?? Infinity));
        let cursor = 16;
        for (const { e, blob } of placed) {
            const wanted = blob ? blob.y : cursor;
            const iy = Math.max(wanted, cursor);
            cursor = iy + M.indexH + M.indexGap;
            const id = entryId(e.path, e.stage);
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
            if (blob) links.push({ id: `s:${id}`, from: id, to: e.oid, kind: 'stage' });
        }
        y = Math.max(y, cursor);
    }

    // A pinned shape is dragged wherever you like, and the canvas can only be panned
    // as far as the scene reaches: a scene measured from the columns alone would
    // refuse to pan to the empty space you just put something in.
    const reach = (f: (s: Shape) => number) => shapes.reduce((m, s) => Math.max(m, f(s) + 40), 0);
    const origin = (f: (s: Shape) => number) => shapes.reduce((m, s) => Math.min(m, f(s) - 40), 0);
    const x0 = origin((s) => s.x);
    const y0 = origin((s) => s.y);
    const bottom = Math.max(
        y + 40,
        200,
        reach((s) => s.y + s.h),
    );
    return {
        shapes,
        links: links.filter((e) => at.has(e.from) && at.has(e.to)),
        columns: [
            {
                key: 'pointersAndTags',
                label: S.canvas.columns.pointersAndTags,
                x: M.gutterX,
                w: gutterW,
            },
            { key: 'commits', label: S.canvas.columns.commits, x: lanesX, w: lanesW },
            {
                key: 'treesAndBlobs',
                label: S.canvas.columns.treesAndBlobs,
                x: objectsX,
                w: objectsW,
            },
            ...(view.showIndex
                ? [{ key: 'index' as const, label: S.canvas.columns.index, x: indexX, w: indexW }]
                : []),
        ],
        x: x0,
        y: y0,
        width:
            Math.max(
                (view.showIndex ? indexX + indexW : objectsX + objectsW) + 40,
                reach((s) => s.x + s.w),
            ) - x0,
        height: bottom - y0,
        rows,
    };
}
