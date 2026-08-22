/**
 * Where the object graph sits under the canvas. Arithmetic only — no drawing, no
 * events — because every one of these rules is a thing that can be wrong by a
 * pixel or by a whole page, and squinting at a browser is no way to find out.
 */

import type { Scene } from './layout.js';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** The canvas the object graph is seen through, in css pixels. */
export interface Viewport {
  width: number;
  height: number;
}

/** How far past the content the camera may go, so an edge is visibly an edge. */
const MARGIN = 20;

/**
 * The object graph is a page, not a plane: you can reach every edge of it and no
 * further. Panning past the last commit into empty grey is how you lose the
 * whole thing and have to scroll back for it.
 */
export function bounded(
  c: { x: number; y: number },
  scale: number,
  scene: { width: number; height: number },
  viewport: Viewport,
): { x: number; y: number } {
  const axis = (v: number, span: number, content: number) => {
    const far = span - content * scale - MARGIN;
    // Content shorter than the canvas makes `far` the larger of the two, so the
    // pair is ordered rather than assumed — otherwise the clamp inverts and
    // pins a small object graph to the bottom right.
    return Math.min(Math.max(v, Math.min(MARGIN, far)), Math.max(MARGIN, far));
  };
  return { x: axis(c.x, viewport.width, scene.width), y: axis(c.y, viewport.height, scene.height) };
}

/**
 * Wheel panning glides to where it was asked for rather than jumping there:
 * the object graph is a page, and a page that lurches is a page you lose your place in.
 * `k` is 1 under prefers-reduced-motion, which arrives in one step.
 */
export function glideStep(
  cam: Camera,
  to: { x: number; y: number },
  k: number,
): { camera: Camera; done: boolean } {
  const x = cam.x + (to.x - cam.x) * k;
  const y = cam.y + (to.y - cam.y) * k;
  const done = Math.abs(to.x - x) < 0.5 && Math.abs(to.y - y) < 0.5;
  return { camera: { ...cam, x: done ? to.x : x, y: done ? to.y : y }, done };
}

/** Screen point to canvas point. */
export function toCanvas(
  cam: Camera,
  ev: { clientX: number; clientY: number },
  rect: { left: number; top: number },
): { x: number; y: number } {
  return { x: (ev.clientX - rect.left - cam.x) / cam.scale, y: (ev.clientY - rect.top - cam.y) / cam.scale };
}

/** Put a shape in the middle of the canvas without changing the zoom. */
export function centre(
  cam: Camera,
  shape: { x: number; y: number; w: number; h: number },
  viewport: Viewport,
): Camera {
  return {
    ...cam,
    x: viewport.width / 2 - (shape.x + shape.w / 2) * cam.scale,
    y: viewport.height / 2 - (shape.y + shape.h / 2) * cam.scale,
  };
}

/** Zoom about the point under the pointer, so that point stays under it. */
export function zoom(
  cam: Camera,
  at: { x: number; y: number },
  deltaY: number,
  scene: { width: number; height: number },
  viewport: Viewport,
): Camera {
  const scale = Math.min(4, Math.max(0.1, cam.scale * Math.exp(-deltaY / 400)));
  return {
    scale,
    ...bounded(
      { x: cam.x + (at.x * cam.scale - at.x * scale), y: cam.y + (at.y * cam.scale - at.y * scale) },
      scale,
      scene,
      viewport,
    ),
  };
}

/**
 * Fit the width and let history run off the bottom. A repository is tall and
 * narrow, so a scale that fits its height too is a scale at which nothing can
 * be read — the object graph is meant to be scrolled, not squinted at.
 */
export function fit(scene: Scene, width: number): Camera {
  const scale = Math.min(2, Math.max(0.15, (width - 40) / scene.width));
  return { x: 20, y: 20, scale };
}

/**
 * Double-clicking nothing in particular is the way back to the starting zoom —
 * full width, but staying where you are: jumping to the top would lose the
 * place you were reading.
 */
export function zoomOut(scene: Scene, viewport: Viewport, canvasY: number): Camera {
  const { scale } = fit(scene, viewport.width);
  return { scale, ...bounded({ x: 20, y: viewport.height / 2 - canvasY * scale }, scale, scene, viewport) };
}

/**
 * Refit the width after the repository grew, without moving vertically: the
 * object graph gets wider as history arrives, and having to reach for "fit" on every
 * commit is how you stop watching. Whatever was in the middle of the canvas
 * stays there.
 */
export function refit(scene: Scene, viewport: Viewport, cam: Camera): Camera {
  return zoomOut(scene, viewport, (viewport.height / 2 - cam.y) / cam.scale);
}
