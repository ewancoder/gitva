/**
 * Where the graph sits under the window. All of this is arithmetic you cannot
 * check by looking: "the graph is a page you cannot pan off" is either true at
 * every zoom or it is a bug you only meet once you are lost in empty grey.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bounded, centre, fit, glideStep, toWorld, zoom, zoomOut } from '../web/camera.js';
import type { Scene } from '../src/layout.js';

const port = { width: 500, height: 400 };
const tall = { width: 1000, height: 3000 };
const scene = (width: number, height: number) =>
  ({ nodes: [], edges: [], bands: [], width, height, rows: [] }) satisfies Scene;

describe('panning bounds', () => {
  it('stops at the near edge and at the far edge of a graph bigger than the window', () => {
    assert.deepEqual(bounded({ x: 900, y: 900 }, 1, tall, port), { x: 20, y: 20 });
    // Far side: the window's width minus the content's, less the same margin.
    assert.deepEqual(bounded({ x: -9999, y: -9999 }, 1, tall, port), { x: -520, y: -2620 });
  });

  it('keeps a graph smaller than the window inside it, either way it is pushed', () => {
    const small = { width: 100, height: 50 };
    assert.deepEqual(bounded({ x: -400, y: -400 }, 1, small, port), { x: 20, y: 20 });
    assert.deepEqual(bounded({ x: 9999, y: 9999 }, 1, small, port), { x: 380, y: 330 });
  });

  it('measures the content at the zoom it is drawn at', () => {
    // Zoomed out far enough, a graph twice the window's width fits in it, and
    // what was a floor becomes a ceiling.
    assert.deepEqual(bounded({ x: -9999, y: 0 }, 0.1, tall, port), { x: 20, y: 20 });
  });
});

describe('gliding', () => {
  it('moves a fraction of the way and says it is not there yet', () => {
    const { camera, done } = glideStep({ x: 0, y: 0, scale: 1 }, { x: 100, y: 0 }, 0.5);
    assert.deepEqual([camera.x, camera.y, done], [50, 0, false]);
  });

  it('snaps to the target once it is within half a pixel', () => {
    const { camera, done } = glideStep({ x: 99.9, y: 0, scale: 1 }, { x: 100, y: 0 }, 0.5);
    assert.deepEqual([camera.x, done], [100, true]);
  });

  it('arrives in one step under prefers-reduced-motion', () => {
    const { camera, done } = glideStep({ x: 0, y: 0, scale: 2 }, { x: 100, y: 40 }, 1);
    assert.deepEqual([camera.x, camera.y, camera.scale, done], [100, 40, 2, true]);
  });
});

describe('the pointer', () => {
  it('reads a screen point as a graph point, through the camera', () => {
    const cam = { x: 30, y: 10, scale: 2 };
    assert.deepEqual(toWorld(cam, { clientX: 130, clientY: 60 }, { left: 10, top: 0 }), { x: 45, y: 25 });
  });

  it('puts the middle of a clicked node in the middle of the window', () => {
    const cam = centre({ x: 0, y: 0, scale: 2 }, { x: 100, y: 50, w: 40, h: 20 }, port);
    assert.deepEqual([cam.x + 120 * 2, cam.y + 60 * 2], [port.width / 2, port.height / 2]);
  });
});

describe('zooming', () => {
  const cam = { x: 20, y: 20, scale: 1 };

  it('keeps the point under the pointer under the pointer', () => {
    const at = { x: 300, y: 800 };
    const next = zoom(cam, at, -200, tall, port);
    assert.ok(next.scale > 1);
    assert.ok(Math.abs(next.x + at.x * next.scale - (cam.x + at.x * cam.scale)) < 1e-9);
  });

  it('will not go past four times or below a tenth', () => {
    assert.equal(zoom(cam, { x: 0, y: 0 }, -100_000, tall, port).scale, 4);
    assert.equal(zoom(cam, { x: 0, y: 0 }, 100_000, tall, port).scale, 0.1);
  });
});

describe('fitting', () => {
  it('fits the width and lets history run off the bottom', () => {
    assert.deepEqual(fit(scene(460, 100_000), 500), { x: 20, y: 20, scale: 1 });
  });

  it('will not blow a narrow graph up past twice, nor shrink a wide one to nothing', () => {
    assert.equal(fit(scene(10, 10), 500).scale, 2);
    assert.equal(fit(scene(100_000, 10), 500).scale, 0.15);
  });

  it('zooming out stays at the height you were reading', () => {
    const cam = zoomOut(scene(1000, 4000), port, 1000);
    assert.equal(cam.scale, 0.46);
    // The point that was under the middle of the window still is.
    assert.equal(cam.y + 1000 * cam.scale, port.height / 2);
    assert.equal(cam.x, 20);
  });
});
