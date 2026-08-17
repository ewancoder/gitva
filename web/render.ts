/**
 * The painter. It decides nothing about position — layout already did that —
 * and layout knows nothing about how any of this looks.
 *
 * Text is the expensive primitive and the thing that turns a graph into soup,
 * so detail comes and goes with zoom: far out no text at all, closer the short
 * sha, closer still the kind, and only at the closest tier do tree entry names
 * appear on the arrows — by which point you are reading a single directory.
 *
 * Hidden means absent: culled nodes are not drawn *and* not walked.
 */

import type { Scene, SceneEdge, SceneNode } from '../src/layout.js';
import type { Change } from '../src/diff.js';
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
  /** Objects the reader marked, to keep an eye on them as the graph moves. */
  marked: Set<string>;
  /** 0→1 while new things grow out of where they came from. */
  enter: number;
  /** Nodes that have gone, drawn at their old place while they fade. */
  ghosts: SceneNode[];
  /** False under prefers-reduced-motion: everything snaps to its end state. */
  motion: boolean;
}

const TIER = { none: 0.45, sha: 0.75, kind: 1.05, names: 1.35 };

// Hover dimming eases rather than snapping. The dimmed graph is an answer to
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

// A node that changes what it belongs to changes where it goes: a blob leaves
// the staging band for the commit that just named it, a whole tree drops into
// the orphanage after a reset. It travels there rather than reappearing there,
// so the move is the thing you read. Layout still decides where every node
// goes — this only decides how it gets there.
const drawnAt = new Map<string, { x: number; y: number }>();

/** Forget where everything was, so the next frame draws it where it is now. */
export function snapPositions() {
  drawnAt.clear();
}

function eased(n: SceneNode): SceneNode {
  const cur = drawnAt.get(n.id);
  const x = cur ? cur.x + (n.x - cur.x) * easeK : n.x;
  const y = cur ? cur.y + (n.y - cur.y) * easeK : n.y;
  if (Math.abs(n.x - x) < 0.5 && Math.abs(n.y - y) < 0.5) {
    drawnAt.set(n.id, { x: n.x, y: n.y });
    return n;
  }
  drawnAt.set(n.id, { x, y });
  settling = true;
  return { ...n, x, y };
}

/** True while something is still easing, so the caller keeps painting. */
export function draw(ctx: CanvasRenderingContext2D, scene: Scene, p: Paint): boolean {
  const { camera: cam } = p;
  easeK = p.motion ? 0.2 : 1;
  settling = false;
  if (dimming.size > 4000) dimming.clear();
  ctx.save();
  ctx.setTransform(p.dpr, 0, 0, p.dpr, 0, 0);
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
  const nodes = new Map<string, SceneNode>();
  for (const n of scene.nodes) nodes.set(n.id, eased(n));

  drawBands(ctx, scene, view, p);

  // Hover lights up a node and its arrows and dims the rest: seeing what
  // connects to what without committing to a click. Clicking commits to it and
  // follows the whole path — every object that reaches this one, and everything
  // it reaches — which is the question "what is this blob part of?".
  const lit = new Set<string>();
  const litEdges = new Set<string>();
  if (p.hover) {
    lit.add(p.hover);
    for (const e of scene.edges) {
      if (e.from !== p.hover && e.to !== p.hover) continue;
      lit.add(e.from);
      lit.add(e.to);
      litEdges.add(e.id);
    }
  }
  if (p.selected) path(scene, p.selected, lit, litEdges);

  for (const e of scene.edges) {
    const a = nodes.get(e.from);
    const b = nodes.get(e.to);
    if (!a || !b) continue;
    if (!overlaps(a, b, view)) continue;
    drawEdge(ctx, e, a, b, p, lit, litEdges);
  }

  for (const n of nodes.values()) {
    if (n.x > view.x1 || n.x + n.w < view.x0 || n.y > view.y1 || n.y + n.h < view.y0) continue;
    if (p.enter < 1 && p.change.added.has(n.id)) {
      // New things grow out of where they came from — a blob out of its tree.
      const o = (n.origin && nodes.get(n.origin)) || n;
      const ox = o.x + o.w / 2;
      const oy = o.y + o.h / 2;
      const k = 0.25 + 0.75 * p.enter;
      ctx.save();
      ctx.globalAlpha = p.enter;
      ctx.translate(ox, oy);
      ctx.scale(k, k);
      ctx.translate(-ox, -oy);
      drawNode(ctx, n, p, lit);
      ctx.restore();
    } else {
      drawNode(ctx, n, p, lit);
    }
  }

  // Removed things fade in place rather than vanishing.
  if (p.enter < 1) {
    ctx.save();
    ctx.globalAlpha = 1 - p.enter;
    for (const g of p.ghosts) drawNode(ctx, g, p, new Set());
    ctx.restore();
  }

  ctx.restore();
  return settling;
}

function overlaps(a: SceneNode, b: SceneNode, v: { x0: number; y0: number; x1: number; y1: number }) {
  return (
    Math.min(a.x, b.x) <= v.x1 &&
    Math.max(a.x + a.w, b.x + b.w) >= v.x0 &&
    Math.min(a.y, b.y) <= v.y1 &&
    Math.max(a.y + a.h, b.y + b.h) >= v.y0
  );
}

function drawBands(
  ctx: CanvasRenderingContext2D,
  scene: Scene,
  v: { y0: number; y1: number },
  p: Paint,
) {
  ctx.save();
  for (const band of scene.bands) {
    // The band fills the whole viewport, not just the content it holds, so a
    // short history still reads as a column running edge to edge — and so the
    // caption below has color under it everywhere it might be pinned.
    ctx.fillStyle = band.key === 'index' ? theme.panel : 'rgba(255,255,255,0.014)';
    ctx.fillRect(band.x - 10, v.y0, band.w + 20, v.y1 - v.y0);
    ctx.font = `500 11px ${theme.sans}`;
    ctx.fillStyle = theme.faint;
    ctx.fillText(band.label, band.x - 4, v.y0 + 14);
  }
  ctx.restore();
  void p;
}

// ---------------------------------------------------------------------------
// Arrows
// ---------------------------------------------------------------------------

/**
 * Everything on the selected node's path: walk up through what points at it and
 * down through what it points at, each direction on its own so siblings sharing
 * a parent tree stay dark. `parent` edges are skipped — a commit's history is a
 * different question from what a commit contains.
 */
export function path(scene: Scene, start: string, lit: Set<string>, litEdges: Set<string>) {
  const out = new Map<string, SceneEdge[]>();
  const into = new Map<string, SceneEdge[]>();
  for (const e of scene.edges) {
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
  for (const [side, at, seeds] of [[out, 'to', [start]], [into, 'from', up]] as const) {
    const queue = [...seeds];
    const seen = new Set(queue);
    while (queue.length) {
      for (const e of side.get(queue.pop()!) ?? []) {
        const next = e[at];
        litEdges.add(e.id);
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
  for (const e of scene.edges) {
    if (e.kind !== 'parent' || !reached.has(e.from)) continue;
    litEdges.add(e.id);
    lit.add(e.to);
  }
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  e: SceneEdge,
  a: SceneNode,
  b: SceneNode,
  p: Paint,
  lit: Set<string>,
  litEdges: Set<string>,
) {
  const dim = dimmed(`${e.kind}:${e.from}>${e.to}`, lit.size > 0 && !litEdges.has(e.id) ? 1 : 0);
  ctx.save();
  ctx.globalAlpha *= 1 - dim * 0.88;
  ctx.setLineDash([]);

  if (e.kind === 'parent') {
    // The spine of the story: the strongest line on screen, drawn in ink so it
    // does not fight the nodes. Lane changes use a short elbow, not a sweeping
    // curve — that is what makes a dense graph readable rather than woolly.
    const ax = a.x + a.w / 2;
    const ay = a.y + a.h;
    const bx = b.x + b.w / 2;
    const by = b.y;
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    if (by >= ay) {
      if (Math.abs(ax - bx) < 0.5) {
        ctx.lineTo(bx, by);
      } else {
        // The head points straight down, so the line must arrive that way too:
        // a diagonal running into it reads as an arrow stuck on sideways.
        ctx.lineTo(ax, by - 18);
        ctx.lineTo(bx, by - 8);
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
      arrowhead(ctx, bx, by, Math.PI / 2, theme.ink);
    } else {
      // Dragged level with or above its parent. Still leave the child from the
      // bottom and route around both, entering the parent's side: the top of a
      // commit is where its own children arrive, and two meanings on one edge
      // is exactly the confusion this avoids.
      const aisle = Math.max(a.x + a.w, b.x + b.w) + 16;
      const foot = Math.max(a.y + a.h, b.y + b.h) + 12;
      const my = b.y + b.h / 2;
      ctx.lineTo(ax, foot);
      ctx.lineTo(aisle, foot);
      ctx.lineTo(aisle, my);
      ctx.lineTo(b.x + b.w, my);
      ctx.stroke();
      arrowhead(ctx, b.x + b.w, my, Math.PI, theme.ink);
    }
  } else if (e.kind === 'pointer') {
    // "Points at" is learned in five seconds and then should not be shouted.
    ctx.strokeStyle = theme.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    curve(ctx, a.x + a.w, a.y + a.h / 2, b.x, b.y + b.h / 2);
    ctx.stroke();
    arrowhead(ctx, b.x, b.y + b.h / 2, 0, theme.muted);
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
    arrowhead(ctx, b.x, b.y + b.h / 2, 0, theme.faint);
    // Names live in trees, not in blobs — so the arrow carries the name.
    if (e.label && p.camera.scale >= TIER.names) {
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

function arrowhead(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, colour: string) {
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
// Nodes: shape, then label, then hue
// ---------------------------------------------------------------------------

function drawNode(ctx: CanvasRenderingContext2D, n: SceneNode, p: Paint, lit: Set<string>) {
  const dim = dimmed(n.id, lit.size > 0 && !lit.has(n.id) ? 1 : 0);
  const hue = n.staged ? theme.staged : hueFor(n.kind);
  const ghost = n.unreachable === true;
  const changed =
    p.flash > 0 && (p.change.added.has(n.id) || p.change.updated.has(n.id) || p.change.removed.has(n.id));

  ctx.save();
  ctx.globalAlpha *= 1 - dim * 0.82;
  ctx.lineWidth = 1.4;
  ctx.setLineDash(ghost ? [3, 3] : []);

  shape(ctx, n);
  if (ghost) {
    ctx.strokeStyle = theme.ghost;
    ctx.stroke();
  } else if (n.kind === 'commit' || n.kind === 'tree' || n.kind === 'blob' || n.kind === 'submodule') {
    ctx.fillStyle = hue;
    ctx.fill();
  } else {
    ctx.fillStyle = theme.raised;
    ctx.fill();
    ctx.strokeStyle = chipHue(n.kind, n.id);
    ctx.lineWidth = n.kind === 'head' ? 1.8 : 1.2;
    if (n.conflict) ctx.setLineDash([4, 2]);
    ctx.stroke();
  }

  const marked = p.marked.has(n.id);
  if (marked) {
    ctx.setLineDash([]);
    ctx.strokeStyle = theme.mark;
    ctx.lineWidth = 2;
    shape(ctx, n, 3);
    ctx.stroke();
  }
  if (n.id === p.selected) {
    ctx.setLineDash([]);
    ctx.strokeStyle = theme.ink;
    ctx.lineWidth = 2;
    // Outside the mark when there is one, so selecting a marked object does
    // not paint over the thing you asked to keep watching.
    shape(ctx, n, marked ? 7 : 3);
    ctx.stroke();
  }
  if (changed) {
    ctx.setLineDash([]);
    ctx.globalAlpha = p.flash * (1 - dim * 0.7);
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2.5;
    shape(ctx, n, 5);
    ctx.stroke();
  }
  ctx.restore();

  label(ctx, n, p, dim, ghost);
}

function shape(ctx: CanvasRenderingContext2D, n: SceneNode, grow = 0) {
  const x = n.x - grow;
  const y = n.y - grow;
  const w = n.w + grow * 2;
  const h = n.h + grow * 2;
  ctx.beginPath();
  switch (n.kind) {
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

function label(ctx: CanvasRenderingContext2D, n: SceneNode, p: Paint, dim: number, ghost: boolean) {
  const s = p.camera.scale;
  if (s < TIER.none) return;
  ctx.save();
  ctx.globalAlpha *= 1 - dim * 0.8;

  if (n.kind === 'ref' || n.kind === 'head' || n.kind === 'more' || n.kind === 'index' || n.kind === 'tag') {
    // A tag chip's label is a sha now, and shas are machine text.
    ctx.font = n.kind === 'tag' ? `11px ${theme.mono}` : `${n.kind === 'head' ? '600 ' : ''}11px ${theme.sans}`;
    ctx.fillStyle = ghost ? theme.ghost : n.kind === 'more' || n.kind === 'index' ? theme.ink : chipHue(n.kind, n.id);
    ctx.fillText(clip(ctx, n.label, n.w - 12), n.x + 6, n.y + (n.sub && s >= TIER.kind ? 12 : n.h / 2 + 4));
    if (n.sub && s >= TIER.kind) {
      ctx.font = `10px ${theme.mono}`;
      ctx.fillStyle = theme.muted;
      ctx.fillText(clip(ctx, n.sub, n.w - 12), n.x + 6, n.y + n.h - 4);
    }
  } else if (s >= TIER.sha) {
    ctx.font = `11px ${theme.mono}`;
    ctx.fillStyle = ghost ? theme.ghost : 'rgba(10,12,16,0.9)';
    ctx.fillText(n.label, n.x + 10, n.y + n.h / 2 + 4);
    if (s >= TIER.kind && n.sub) {
      ctx.font = `10px ${theme.sans}`;
      ctx.fillStyle = ghost ? theme.faint : 'rgba(10,12,16,0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(n.sub, n.x + n.w - 8, n.y + n.h / 2 + 4);
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

export function hitTest(scene: Scene, wx: number, wy: number): SceneNode | null {
  for (let i = scene.nodes.length - 1; i >= 0; i--) {
    const n = scene.nodes[i];
    if (wx >= n.x - 3 && wx <= n.x + n.w + 3 && wy >= n.y - 3 && wy <= n.y + n.h + 3) return n;
  }
  return null;
}
