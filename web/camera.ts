/**
 * Where the graph sits under the window. Arithmetic only — no canvas, no
 * events — because every one of these rules is a thing that can be wrong by a
 * pixel or by a whole page, and squinting at a browser is no way to find out.
 */

import type { Scene } from '../src/layout.js';

export interface Camera {
  x: number;
  y: number;
  scale: number;
}

/** The window the graph is seen through, in css pixels. */
export interface Port {
  width: number;
  height: number;
}

/** How far past the content the camera may go, so an edge is visibly an edge. */
const MARGIN = 20;

/**
 * The graph is a page, not a plane: you can reach every edge of it and no
 * further. Panning past the last commit into empty grey is how you lose the
 * whole thing and have to scroll back for it.
 */
export function bounded(
  c: { x: number; y: number },
  scale: number,
  scene: { width: number; height: number },
  port: Port,
): { x: number; y: number } {
  const axis = (v: number, span: number, content: number) => {
    const far = span - content * scale - MARGIN;
    // Content shorter than the window makes `far` the larger of the two, so the
    // pair is ordered rather than assumed — otherwise the clamp inverts and
    // pins a small graph to the bottom right.
    return Math.min(Math.max(v, Math.min(MARGIN, far)), Math.max(MARGIN, far));
  };
  return { x: axis(c.x, port.width, scene.width), y: axis(c.y, port.height, scene.height) };
}

/**
 * Wheel panning glides to where it was asked for rather than jumping there:
 * the graph is a page, and a page that lurches is a page you lose your place in.
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

/** Screen point to graph point. */
export function toWorld(
  cam: Camera,
  ev: { clientX: number; clientY: number },
  rect: { left: number; top: number },
): { x: number; y: number } {
  return { x: (ev.clientX - rect.left - cam.x) / cam.scale, y: (ev.clientY - rect.top - cam.y) / cam.scale };
}

/** Put a node in the middle of the window without changing the zoom. */
export function centre(cam: Camera, n: { x: number; y: number; w: number; h: number }, port: Port): Camera {
  return {
    ...cam,
    x: port.width / 2 - (n.x + n.w / 2) * cam.scale,
    y: port.height / 2 - (n.y + n.h / 2) * cam.scale,
  };
}

/** Zoom about the point under the pointer, so that point stays under it. */
export function zoom(
  cam: Camera,
  at: { x: number; y: number },
  deltaY: number,
  scene: { width: number; height: number },
  port: Port,
): Camera {
  const scale = Math.min(4, Math.max(0.1, cam.scale * Math.exp(-deltaY / 400)));
  return {
    scale,
    ...bounded(
      { x: cam.x + (at.x * cam.scale - at.x * scale), y: cam.y + (at.y * cam.scale - at.y * scale) },
      scale,
      scene,
      port,
    ),
  };
}

/**
 * Fit the width and let history run off the bottom. A repository is tall and
 * narrow, so a scale that fits its height too is a scale at which nothing can
 * be read — the graph is meant to be scrolled, not squinted at.
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
export function zoomOut(scene: Scene, port: Port, worldY: number): Camera {
  const { scale } = fit(scene, port.width);
  return { scale, ...bounded({ x: 20, y: port.height / 2 - worldY * scale }, scale, scene, port) };
}

/**
 * Refit the width after the repository grew, without moving vertically: the
 * graph gets wider as history arrives, and having to reach for "fit" on every
 * commit is how you stop watching. Whatever was in the middle of the window
 * stays there.
 */
export function refit(scene: Scene, port: Port, cam: Camera): Camera {
  return zoomOut(scene, port, (port.height / 2 - cam.y) / cam.scale);
}
