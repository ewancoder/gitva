/**
 * The sample page, kept honest. `samples/webapp/` ships recorded steps and a
 * sentence about each, and nothing else in the build touches either: a step
 * that stopped meaning what it meant, or a slide added without the step it
 * describes, would be found by whoever installed the package.
 *
 * It is drawn here rather than merely parsed, because drawing it is the claim
 * the sample makes — and it is drawn through the sample's own `fill`, which is
 * where the fields a shortened step leaves out come back.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';

import { layout } from '../web/layout.js';
import { DEFAULT_VIEW, type Step } from '../src/types.js';

const SAMPLES = resolve(fileURLToPath(new URL('../../samples', import.meta.url)));
const SAMPLE = join(SAMPLES, 'webapp');
const read = (file: string) => readFileSync(join(SAMPLE, file), 'utf8');
const read2 = (file: string) => readFileSync(join(SAMPLES, file), 'utf8');

// The sample is plain JS the page loads as-is, so its expander is imported the
// way the page does rather than compiled with the rest.
const { fill } = (await import(pathToFileURL(join(SAMPLE, 'steps.js')).href)) as {
    fill: (recorded: unknown[]) => Step[];
};

describe('the sample page', () => {
    const steps = fill(JSON.parse(read('steps.json')) as unknown[]);

    it('draws every step it ships', () => {
        let seq = 0;
        for (const step of steps) {
            assert.ok(step.seq > seq, 'steps are recorded in order');
            seq = step.seq;
            const scene = layout(step, DEFAULT_VIEW, {}, {});
            assert.ok(scene.columns.length > 0);
        }
        // What the lesson ends on: two commits, a second branch, and a tag that
        // is an object as well as a pointer.
        const last = steps.at(-1)!;
        assert.equal(Object.keys(last.commits).length, 2);
        assert.ok(Object.values(last.tags).some((t) => t.name === 'v1'));
        assert.ok(last.refs.some((r) => r.name === 'refs/heads/experiment'));
    });

    it('says something about each of them', () => {
        const slides = [...read('lesson.js').matchAll(/^\s+command: /gm)].length;
        assert.equal(slides, steps.length, 'one slide per step, in order');
    });
});

// The CDN page is a `mount` call and a block of JSON, so what there is to check
// is the JSON: that it is whole steps the canvas can draw, and still is.
const inline = JSON.parse(
    read2('webpage/index.html').match(
        /<script type="application\/json" id="steps">([\s\S]*?)<\/script>/,
    )![1],
) as Step[];

describe('the CDN sample page', () => {
    it('draws every step it ships', () => {
        assert.equal(inline.length, 3);
        for (const step of inline) assert.ok(layout(step, DEFAULT_VIEW, {}, {}).shapes.length > 0);
        // What the page ends on: two commits over the same path, and every
        // object either of them ever named still there.
        const last = inline.at(-1)!;
        assert.equal(Object.keys(last.commits).length, 2);
        assert.equal(Object.keys(last.objects).length, 6);
        assert.equal(last.index.length, 1);
    });
});
