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

const SAMPLE = resolve(fileURLToPath(new URL('../../samples/webapp', import.meta.url)));
const read = (file: string) => readFileSync(join(SAMPLE, file), 'utf8');

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
