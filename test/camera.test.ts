/**
 * Where the object graph sits under the canvas. All of this is arithmetic you cannot
 * check by looking: "the object graph is a page you cannot pan off" is either true at
 * every zoom or it is a bug you only meet once you are lost in empty grey.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bounded, centre, fit, glideStep, refit, toCanvas, zoom, zoomOut } from '../web/camera.js';
import type { Scene } from '../web/layout.js';

const viewport = { width: 500, height: 400 };
const tall = { x: 0, y: 0, width: 1000, height: 3000 };
const scene = (width: number, height: number) =>
    ({ shapes: [], links: [], columns: [], x: 0, y: 0, width, height, rows: [] }) satisfies Scene;

describe('panning bounds', () => {
    it('stops half a canvas past each edge of an object graph bigger than the canvas', () => {
        assert.deepEqual(bounded({ x: 900, y: 900 }, 1, tall, viewport), { x: 270, y: 220 });
        // Far side: the canvas's width minus the content's, less the same margin, and
        // then half a canvas of empty room to drag a shape into.
        assert.deepEqual(bounded({ x: -9999, y: -9999 }, 1, tall, viewport), { x: -770, y: -2820 });
    });

    it('lets an object graph smaller than the canvas be pushed half a canvas off either way', () => {
        const small = { x: 0, y: 0, width: 100, height: 50 };
        assert.deepEqual(bounded({ x: -400, y: -400 }, 1, small, viewport), { x: -230, y: -180 });
        assert.deepEqual(bounded({ x: 9999, y: 9999 }, 1, small, viewport), { x: 630, y: 530 });
    });

    it('pans up to a scene that starts above the columns, where a shape was dragged', () => {
        const above = { x: 0, y: -600, width: 1000, height: 3600 };
        // The camera may put the topmost shape a margin below the top of the canvas,
        // and half a canvas further down again.
        assert.deepEqual(bounded({ x: 0, y: 9999 }, 1, above, viewport).y, 620 + 200);
    });

    it('measures the content at the zoom it is drawn at', () => {
        // Zoomed out far enough, an object graph twice the canvas's width fits in it, and
        // what was a floor becomes a ceiling.
        assert.deepEqual(bounded({ x: -9999, y: 0 }, 0.1, tall, viewport), { x: -230, y: 0 });
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
    it('reads a screen point as a canvas point, through the camera', () => {
        const cam = { x: 30, y: 10, scale: 2 };
        assert.deepEqual(toCanvas(cam, { clientX: 130, clientY: 60 }, { left: 10, top: 0 }), {
            x: 45,
            y: 25,
        });
    });

    it('puts the middle of a clicked shape in the middle of the canvas', () => {
        const cam = centre({ x: 0, y: 0, scale: 2 }, { x: 100, y: 50, w: 40, h: 20 }, viewport);
        assert.deepEqual(
            [cam.x + 120 * 2, cam.y + 60 * 2],
            [viewport.width / 2, viewport.height / 2],
        );
    });
});

describe('zooming', () => {
    const cam = { x: 20, y: 20, scale: 1 };

    it('keeps the point under the pointer under the pointer', () => {
        const at = { x: 300, y: 800 };
        const next = zoom(cam, at, -200, tall, viewport);
        assert.ok(next.scale > 1);
        assert.ok(Math.abs(next.x + at.x * next.scale - (cam.x + at.x * cam.scale)) < 1e-9);
    });

    it('will not go past four times or below a tenth', () => {
        assert.equal(zoom(cam, { x: 0, y: 0 }, -100_000, tall, viewport).scale, 4);
        assert.equal(zoom(cam, { x: 0, y: 0 }, 100_000, tall, viewport).scale, 0.1);
    });
});

describe('fitting', () => {
    it('fits the width and lets history run off the bottom', () => {
        assert.deepEqual(fit(scene(460, 100_000), 500), { x: 20, y: 20, scale: 1 });
    });

    it('will not blow a narrow object graph up past twice, nor shrink a wide one to nothing', () => {
        assert.equal(fit(scene(10, 10), 500).scale, 2);
        assert.equal(fit(scene(100_000, 10), 500).scale, 0.15);
    });

    it('zooming out stays at the height you were reading', () => {
        const cam = zoomOut(scene(1000, 4000), viewport, 1000);
        assert.equal(cam.scale, 0.46);
        // The point that was under the middle of the canvas still is.
        assert.equal(cam.y + 1000 * cam.scale, viewport.height / 2);
        assert.equal(cam.x, 20);
    });
});

describe('refitting when the repository changes', () => {
    it('takes the fitted width and leaves the height where it was being read', () => {
        const s = scene(1000, 4000);
        const before = { x: -300, y: -500, scale: 1 };
        const middle = (viewport.height / 2 - before.y) / before.scale;
        const cam = refit(s, viewport, before);
        assert.equal(cam.scale, fit(s, viewport.width).scale);
        assert.equal(cam.y + middle * cam.scale, viewport.height / 2);
    });
});
