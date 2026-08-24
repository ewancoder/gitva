/**
 * The painter. It decides nothing about position — layout already did that —
 * and layout knows nothing about how any of this looks.
 *
 * Text is the expensive primitive and the thing that turns a canvas into soup,
 * so detail comes and goes with zoom: far out no text at all, closer the short
 * sha, closer still the kind, and only at the closest tier do tree entry names
 * appear on the links — by which point you are reading a single directory.
 *
 * Hidden means absent: culled shapes are not drawn *and* not walked.
 */

import { M, type Scene, type Link, type Shape } from './layout.js';
import type { Change } from './diff.js';
import type { Camera } from './camera.js';
import { chipHue, hueFor, theme } from './theme.js';

export interface Paint {
    camera: Camera;
    width: number;
    height: number;
    dpr: number;
    change: Change;
    /** 1 just after a change, decaying to 0. The only use of the accent. */
    flash: number;
    hover: string | null;
    selected: string | null;
    /** Objects you marked, to keep an eye on them as the object graph moves. */
    marked: Set<string>;
    /** Whether a pinned shape wears a pushpin. Off unless you asked. */
    showPins: boolean;
    /** Whether a tree's links carry the names. On unless you turned them off. */
    showNames: boolean;
    /** 0→1 while new things grow out of where they came from. */
    enter: number;
    /** Shapes that have gone, drawn at their old place while they fade. */
    leaving: Shape[];
    /** 0→1 while the leaving fade. Slower than `enter` when git caused it. */
    exit: number;
    /** False under prefers-reduced-motion: everything snaps to its end state. */
    motion: boolean;
    /** The column whose edge is under the pointer or being dragged. */
    resizing?: string | null;
}

const TIER = { none: 0.15, sha: 0.25, kind: 0.4, names: 0.55 };

// Hover dimming eases rather than snapping. The dimmed canvas is an answer to
// "what connects to what"; arriving at it instantly reads as a glitch instead.
const dimming = new Map<string, number>();
let easeK = 0.2;
let settling = false;
/** 0 lit, 1 fully dimmed — one step of the way towards `target`. */
function dimmed(id: string, target: number): number {
    const cur = dimming.get(id) ?? target;
    const next = cur + (target - cur) * easeK;
    if (Math.abs(target - next) < 0.01) {
        dimming.set(id, target);
        return target;
    }
    dimming.set(id, next);
    settling = true;
    return next;
}

// A shape that changes what it belongs to changes where it goes: a blob leaves
// the staging column for the commit that just named it, a whole tree drops into
// the strays below after a reset. It travels there rather than reappearing there,
// so the move is the thing you read. Layout still decides where every shape
// goes — this only decides how it gets there.
const drawnAt = new Map<string, { x: number; y: number }>();

/** Forget where everything was, so the next frame draws it where it is now. */
export function snapPositions() {
    drawnAt.clear();
}

function eased(shape: Shape): Shape {
    const cur = drawnAt.get(shape.id);
    const x = cur ? cur.x + (shape.x - cur.x) * easeK : shape.x;
    const y = cur ? cur.y + (shape.y - cur.y) * easeK : shape.y;
    if (Math.abs(shape.x - x) < 0.5 && Math.abs(shape.y - y) < 0.5) {
        drawnAt.set(shape.id, { x: shape.x, y: shape.y });
        return shape;
    }
    drawnAt.set(shape.id, { x, y });
    settling = true;
    return { ...shape, x, y };
}

/** True while something is still easing, so the caller keeps painting. */
export function draw(ctx: CanvasRenderingContext2D, scene: Scene, p: Paint): boolean {
    const { camera: cam } = p;
    easeK = p.motion ? 0.2 : 1;
    settling = false;
    if (dimming.size > 4000) dimming.clear();
    ctx.save();
    ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
    // Cleared first: a ground may be translucent, and a fill alone would leave
    // the last frame under it.
    ctx.clearRect(0, 0, p.width, p.height);
    ctx.fillStyle = theme.ground;
    ctx.fillRect(0, 0, p.width, p.height);
    ctx.translate(cam.x, cam.y);
    ctx.scale(cam.scale, cam.scale);

    const view = {
        x0: -cam.x / cam.scale,
        y0: -cam.y / cam.scale,
        x1: (p.width - cam.x) / cam.scale,
        y1: (p.height - cam.y) / cam.scale,
    };

    if (drawnAt.size > 4000) drawnAt.clear();
    const shapes = new Map<string, Shape>();
    for (const shape of scene.shapes) shapes.set(shape.id, eased(shape));

    drawColumns(ctx, scene, view, p);

    // Hover lights up a shape and its links and dims the rest: seeing what
    // connects to what without committing to a click. Clicking commits to it and
    // follows the whole path — every object that reaches this one, and everything
    // it reaches — which is the question "what is this blob part of?".
    const lit = new Set<string>();
    const litLinks = new Set<string>();
    if (p.hover) {
        lit.add(p.hover);
        for (const e of scene.links) {
            if (e.from !== p.hover && e.to !== p.hover) continue;
            lit.add(e.from);
            lit.add(e.to);
            litLinks.add(e.id);
        }
    }
    if (p.selected) path(scene, p.selected, lit, litLinks);

    for (const e of scene.links) {
        const a = shapes.get(e.from);
        const b = shapes.get(e.to);
        if (!a || !b) continue;
        if (!overlaps(a, b, view)) continue;
        drawLink(ctx, e, a, b, p, lit, litLinks);
    }

    for (const shape of shapes.values()) {
        const off =
            shape.x > view.x1 ||
            shape.x + shape.w < view.x0 ||
            shape.y > view.y1 ||
            shape.y + shape.h < view.y0;
        if (off) continue;
        if (p.enter < 1 && p.change.added.has(shape.id)) {
            // New things grow out of where they came from — a blob out of its tree.
            const o = (shape.origin && shapes.get(shape.origin)) || shape;
            const ox = o.x + o.w / 2;
            const oy = o.y + o.h / 2;
            const k = 0.25 + 0.75 * p.enter;
            ctx.save();
            ctx.globalAlpha = p.enter;
            ctx.translate(ox, oy);
            ctx.scale(k, k);
            ctx.translate(-ox, -oy);
            drawShape(ctx, shape, p, lit);
            ctx.restore();
        } else {
            drawShape(ctx, shape, p, lit);
        }
    }

    // Removed things fade in place rather than vanishing.
    if (p.exit < 1) {
        ctx.save();
        ctx.globalAlpha = 1 - p.exit;
        for (const g of p.leaving) drawShape(ctx, g, p, new Set());
        ctx.restore();
    }

    ctx.restore();
    return settling;
}

function overlaps(a: Shape, b: Shape, v: { x0: number; y0: number; x1: number; y1: number }) {
    return (
        Math.min(a.x, b.x) <= v.x1 &&
        Math.max(a.x + a.w, b.x + b.w) >= v.x0 &&
        Math.min(a.y, b.y) <= v.y1 &&
        Math.max(a.y + a.h, b.y + b.h) >= v.y0
    );
}

function drawColumns(
    ctx: CanvasRenderingContext2D,
    scene: Scene,
    v: { y0: number; y1: number },
    p: Paint,
) {
    ctx.save();
    for (const column of scene.columns) {
        // The column fills the whole viewport, not just the content it holds, so a
        // short history still reads as a column running edge to edge — and so the
        // caption below has color under it everywhere it might be pinned.
        ctx.fillStyle = column.key === 'index' ? theme.surface : theme.columnTint;
        ctx.fillRect(column.x - 10, v.y0, column.w + 20, v.y1 - v.y0);
        // Furniture, not content: the caption stays the same size on screen at any
        // zoom, so it is divided back out of the camera's scale.
        const z = p.camera.scale;
        ctx.font = `500 ${11 / z}px ${theme.sans}`;
        ctx.fillStyle = theme.faint;
        ctx.fillText(column.label, column.x - 4, v.y0 + 14 / z);
        // The edge you drag to give a column more room. Faint, because it is furniture.
        const edge = columnEdge(column);
        if (edge !== null) {
            ctx.fillStyle = p.resizing === column.key ? theme.muted : theme.line;
            ctx.fillRect(edge - 0.5, v.y0, 1, v.y1 - v.y0);
        }
    }
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

/**
 * Everything on the selected shape's path: walk up through what points at it and
 * down through what it points at, each direction on its own so siblings sharing
 * a parent tree stay dark. `parent` links are skipped — a commit's history is a
 * different question from what a commit contains.
 */
export function path(scene: Scene, start: string, lit: Set<string>, litLinks: Set<string>) {
    const out = new Map<string, Link[]>();
    const into = new Map<string, Link[]>();
    for (const e of scene.links) {
        if (e.kind === 'parent') continue;
        (out.get(e.from) ?? out.set(e.from, []).get(e.from)!).push(e);
        (into.get(e.to) ?? into.set(e.to, []).get(e.to)!).push(e);
    }

    // What this walk reached, which is not the same as what is lit — hover may
    // have lit neighbours already, and those are not on the selection's path.
    const reached = new Set([start]);
    lit.add(start);
    // Staging is identity, not containment: an index entry *is* its blob, so the
    // upward walk carries on from the blob and finds the trees holding it too.
    const up = [start];
    for (const [side, at, seeds] of [
        [out, 'to', [start]],
        [into, 'from', up],
    ] as const) {
        const queue = [...seeds];
        const seen = new Set(queue);
        while (queue.length) {
            for (const e of side.get(queue.pop()!) ?? []) {
                const next = e[at];
                litLinks.add(e.id);
                lit.add(next);
                reached.add(next);
                if (e.kind === 'stage') up.push(next);
                if (seen.has(next)) continue;
                seen.add(next);
                queue.push(next);
            }
        }
    }

    // Where a commit ends up lit, its immediate parents come with it: "what did
    // this build on?" is the one history question a selection should answer. One
    // level only — walking further would light the whole spine and say nothing.
    for (const e of scene.links) {
        if (e.kind !== 'parent' || !reached.has(e.from)) continue;
        litLinks.add(e.id);
        lit.add(e.to);
    }
}

function drawLink(
    ctx: CanvasRenderingContext2D,
    e: Link,
    a: Shape,
    b: Shape,
    p: Paint,
    lit: Set<string>,
    litLinks: Set<string>,
) {
    const dim = dimmed(`${e.kind}:${e.from}>${e.to}`, lit.size > 0 && !litLinks.has(e.id) ? 1 : 0);
    ctx.save();
    ctx.globalAlpha *= 1 - dim * 0.88;
    ctx.setLineDash([]);

    if (e.kind === 'parent') {
        // The spine of the story: the strongest line on screen, drawn in ink so it
        // does not fight the shapes. Lane changes use a short elbow, not a sweeping
        // curve — that is what makes a dense canvas readable rather than woolly.
        const ax = a.x + a.w / 2;
        const ay = a.y + a.h;
        const bx = b.x + b.w / 2;
        const by = b.y;
        // A line touching a ghost is part of the ghost's story, not the live
        // spine's: it drops to the ghost grey so the strays stay quiet.
        const stroke = a.unreachable === true || b.unreachable === true ? theme.ghost : theme.ink;
        ctx.strokeStyle = stroke;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        if (by >= ay) {
            if (Math.abs(ax - bx) < 0.5) {
                ctx.lineTo(bx, by);
            } else {
                // The head points straight down, so the line must arrive that way too:
                // a diagonal running into it reads as a link stuck on sideways.
                ctx.lineTo(ax, by - 18);
                ctx.lineTo(bx, by - 8);
                ctx.lineTo(bx, by);
            }
            ctx.stroke();
            linkHead(ctx, bx, by, Math.PI / 2, stroke);
        } else {
            // Dragged level with or above its parent. Still leave the child from the
            // bottom and route around both, entering the parent's side: the top of a
            // commit is where its own children arrive, and two meanings on one link
            // is exactly the confusion this avoids.
            const aisle = Math.max(a.x + a.w, b.x + b.w) + 16;
            const foot = Math.max(a.y + a.h, b.y + b.h) + 12;
            const my = b.y + b.h / 2;
            ctx.lineTo(ax, foot);
            ctx.lineTo(aisle, foot);
            ctx.lineTo(aisle, my);
            ctx.lineTo(b.x + b.w, my);
            ctx.stroke();
            linkHead(ctx, b.x + b.w, my, Math.PI, stroke);
        }
    } else if (e.kind === 'pointer') {
        // "Points at" is learned in five seconds and then should not be shouted.
        ctx.strokeStyle = theme.muted;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        curve(ctx, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2);
        ctx.stroke();
        linkHead(ctx, b.x, b.y + b.h / 2, 0, theme.muted);
    } else if (e.kind === 'stage') {
        ctx.strokeStyle = theme.muted;
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 4]);
        curve(ctx, a.x, a.y + a.h / 2, b.x + b.w, b.y + b.h / 2);
        ctx.stroke();
    } else {
        ctx.strokeStyle = theme.faint;
        ctx.lineWidth = 1.1;
        curve(ctx, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2);
        ctx.stroke();
        linkHead(ctx, b.x, b.y + b.h / 2, 0, theme.faint);
        // Names live in trees, not in blobs — so the link carries the name.
        if (e.label && p.showNames && p.camera.scale >= TIER.names) {
            ctx.font = `10px ${theme.mono}`;
            ctx.fillStyle = theme.muted;
            ctx.textAlign = 'center';
            const mx = (a.x + a.w + b.x) / 2;
            const my = (a.y + a.h / 2 + b.y + b.h / 2) / 2 - 4;
            ctx.fillText(e.label, mx, my);
            ctx.textAlign = 'left';
        }
    }
    ctx.restore();
}

function curve(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number) {
    const dx = Math.max(16, (x1 - x0) / 2);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.bezierCurveTo(x0 + dx, y0, x1 - dx, y1, x1, y1);
}

function linkHead(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    angle: number,
    colour: string,
) {
    const s = 4;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = colour;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-s * 1.6, -s * 0.7);
    ctx.lineTo(-s * 1.6, s * 0.7);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
}

// ---------------------------------------------------------------------------
// Shapes: silhouette, then label, then hue
// ---------------------------------------------------------------------------

function drawShape(ctx: CanvasRenderingContext2D, shape: Shape, p: Paint, lit: Set<string>) {
    const dim = dimmed(shape.id, lit.size > 0 && !lit.has(shape.id) ? 1 : 0);
    const hue = shape.staged ? theme.staged : hueFor(shape.kind);
    const ghost = shape.unreachable === true;
    const changed =
        p.flash > 0 &&
        (p.change.added.has(shape.id) ||
            p.change.updated.has(shape.id) ||
            p.change.removed.has(shape.id));

    ctx.save();
    ctx.globalAlpha *= 1 - dim * 0.82;
    ctx.lineWidth = 1.4;
    ctx.setLineDash(ghost ? [3, 3] : []);

    silhouette(ctx, shape);
    if (ghost) {
        ctx.strokeStyle = theme.ghost;
        ctx.stroke();
    } else if (
        shape.kind === 'commit' ||
        shape.kind === 'tree' ||
        shape.kind === 'blob' ||
        shape.kind === 'submodule'
    ) {
        ctx.fillStyle = hue;
        ctx.fill();
        // The one object fill that carries no hue, so on a light ground it is
        // nearly the ground: it needs an edge to be a shape at all.
        if (shape.kind === 'submodule') {
            ctx.strokeStyle = theme.muted;
            ctx.lineWidth = 1.2;
            ctx.stroke();
        }
    } else {
        ctx.fillStyle = theme.raised;
        ctx.fill();
        ctx.strokeStyle = chipHue(shape.kind, shape.id);
        ctx.lineWidth = shape.kind === 'head' ? 1.8 : 1.2;
        if (shape.conflict) ctx.setLineDash([4, 2]);
        ctx.stroke();
    }

    // A collapsed tree is drawn like an empty one, so it carries its own handle: a
    // stub link off its right edge, in the tree hue, pointing at the entries
    // that are not there. "There is more in here" has to be visible at any zoom.
    if (shape.collapsed) {
        ctx.setLineDash([]);
        ctx.strokeStyle = theme.tree;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.moveTo(shape.x + shape.w + 4, shape.y + shape.h / 2);
        ctx.lineTo(shape.x + shape.w + 13, shape.y + shape.h / 2);
        ctx.stroke();
        linkHead(ctx, shape.x + shape.w + 17, shape.y + shape.h / 2, 0, theme.tree);
    }

    // A shape you dragged somewhere gets a pushpin through its top right
    // corner: a hand-placed thing, so it wears the one colour your own
    // marks use — outside the silhouette, so it joins no hue count.
    if (shape.pinned && p.showPins) {
        const hx = shape.x + shape.w + 3;
        const hy = shape.y - 2;
        ctx.setLineDash([]);
        ctx.strokeStyle = theme.mark;
        ctx.fillStyle = theme.mark;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(hx, hy);
        ctx.lineTo(shape.x + shape.w - 4, shape.y + 5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
        ctx.fill();
    }

    const marked = p.marked.has(shape.id);
    if (marked) {
        ctx.setLineDash([]);
        ctx.strokeStyle = theme.mark;
        ctx.lineWidth = 2;
        silhouette(ctx, shape, 3);
        ctx.stroke();
    }
    if (shape.id === p.selected) {
        ctx.setLineDash([]);
        ctx.strokeStyle = theme.ink;
        ctx.lineWidth = 2;
        // Outside the mark when there is one, so selecting a marked object does
        // not paint over the thing you asked to keep watching.
        silhouette(ctx, shape, marked ? 7 : 3);
        ctx.stroke();
    }
    if (changed) {
        ctx.setLineDash([]);
        ctx.globalAlpha = p.flash * (1 - dim * 0.7);
        ctx.strokeStyle = theme.accent;
        ctx.lineWidth = 2.5;
        silhouette(ctx, shape, 5);
        ctx.stroke();
    }
    ctx.restore();

    label(ctx, shape, p, dim, ghost);
}

function silhouette(ctx: CanvasRenderingContext2D, shape: Shape, grow = 0) {
    const x = shape.x - grow;
    const y = shape.y - grow;
    const w = shape.w + grow * 2;
    const h = shape.h + grow * 2;
    ctx.beginPath();
    switch (shape.kind) {
        case 'commit':
        case 'blob':
            // A pill, wide enough for the sha written inside it. Reachable or not,
            // a commit is the same shape — unreachable is the dashed outline.
            ctx.roundRect(x, y, w, h, h / 2);
            break;
        case 'tree': {
            // A chamfered slab: a container, visibly not a pill.
            const c = 7;
            ctx.moveTo(x + c, y);
            ctx.lineTo(x + w, y);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x + c, y + h);
            ctx.lineTo(x, y + h - c);
            ctx.lineTo(x, y + c);
            ctx.closePath();
            break;
        }
        case 'tag': {
            // A luggage label, pointing left at what it names.
            const c = 8;
            ctx.moveTo(x, y + h / 2);
            ctx.lineTo(x + c, y);
            ctx.lineTo(x + w, y);
            ctx.lineTo(x + w, y + h);
            ctx.lineTo(x + c, y + h);
            ctx.closePath();
            break;
        }
        default:
            ctx.roundRect(x, y, w, h, theme.radius);
    }
}

function label(ctx: CanvasRenderingContext2D, shape: Shape, p: Paint, dim: number, ghost: boolean) {
    const s = p.camera.scale;
    if (s < TIER.none) return;
    ctx.save();
    ctx.globalAlpha *= 1 - dim * 0.8;

    if (
        shape.kind === 'ref' ||
        shape.kind === 'head' ||
        shape.kind === 'index' ||
        shape.kind === 'tag'
    ) {
        // A tag chip's label is a sha now, and shas are machine text.
        ctx.font =
            shape.kind === 'tag'
                ? `11px ${theme.mono}`
                : `${shape.kind === 'head' ? '600 ' : ''}11px ${theme.sans}`;
        ctx.fillStyle = ghost
            ? theme.ghost
            : shape.kind === 'index'
              ? theme.ink
              : chipHue(shape.kind, shape.id);
        const baseline = shape.y + (shape.sub && s >= TIER.kind ? 12 : shape.h / 2 + 4);
        ctx.fillText(clip(ctx, shape.label, shape.w - 12), shape.x + 6, baseline);
        if (shape.sub && s >= TIER.kind) {
            ctx.font = `10px ${theme.mono}`;
            ctx.fillStyle = theme.muted;
            ctx.fillText(clip(ctx, shape.sub, shape.w - 12), shape.x + 6, shape.y + shape.h - 4);
        }
    } else if (s >= TIER.sha) {
        ctx.font = `11px ${theme.mono}`;
        ctx.fillStyle = ghost ? theme.ghost : 'rgba(10,12,16,0.9)';
        ctx.fillText(shape.label, shape.x + 10, shape.y + shape.h / 2 + 4);
        if (s >= TIER.kind && shape.sub) {
            // `tree +N` on a collapsed tree is not a description like the others — it is
            // the count of what is being held back, so it is said in bold. Bold and
            // not a colour: red on the tree green is the one pair that reads badly.
            ctx.font = `${shape.collapsed ? '700 ' : ''}10px ${theme.sans}`;
            ctx.fillStyle = ghost ? theme.faint : 'rgba(10,12,16,0.6)';
            ctx.textAlign = 'right';
            ctx.fillText(shape.sub, shape.x + shape.w - 8, shape.y + shape.h / 2 + 4);
            ctx.textAlign = 'left';
        }
    }
    ctx.restore();
}

function clip(ctx: CanvasRenderingContext2D, s: string, max: number): string {
    if (ctx.measureText(s).width <= max) return s;
    let out = s;
    while (out.length > 1 && ctx.measureText(out + '…').width > max) out = out.slice(0, -1);
    return out + '…';
}

// ---------------------------------------------------------------------------

/** Where a column's drag edge sits: the middle of the gap after it. The index is
 *  last and holds one column of fixed-width chips, so it has no edge. */
const columnEdge = (column: Scene['columns'][number]) =>
    column.key === 'index' ? null : column.x + column.w + M.columnGap / 2;

/** The column whose width a drag at `wx` would change, if any. */
export function columnEdgeAt(scene: Scene, wx: number): string | null {
    for (const column of scene.columns) {
        const e = columnEdge(column);
        if (e !== null && Math.abs(wx - e) <= 9) return column.key;
    }
    return null;
}

export function hitTest(scene: Scene, wx: number, wy: number): Shape | null {
    for (let i = scene.shapes.length - 1; i >= 0; i--) {
        const shape = scene.shapes[i];
        const hit =
            wx >= shape.x - 3 &&
            wx <= shape.x + shape.w + 3 &&
            wy >= shape.y - 3 &&
            wy <= shape.y + shape.h + 3;
        if (hit) return shape;
    }
    return null;
}
