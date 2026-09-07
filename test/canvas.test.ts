/**
 * The canvas on its own — the published entry point, and the half a viewer
 * actually touches. Every gesture on it is a decision: which of a pair of clicks
 * a double-click acts on, whether a drag pinned something or panned the ground,
 * what a step arriving is allowed to do to the camera. `CLAUDE.md`'s rule is
 * that a decision belongs in a test, and these are the ones that could only be
 * checked by dragging and squinting.
 *
 * Driven with `fakeStep()` and the stub browser in `fixture.ts`: no repository,
 * no server, no page around it — which is the whole claim `gitva/canvas` makes.
 *
 * The camera is worked out from `fit`, exactly as the canvas works it out, so a
 * test can say where on screen a canvas point is. A recording that is *replayed*
 * frames nothing, so it leaves the camera where the constructor put it — which
 * is why most of these start that way and canvas points are screen points, less
 * the margin.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { browser, FakeCanvas, FakeElement, fakeStep, type FakeEvent } from './fixture.js';
import { fit, refit, zoomOut } from '../web/camera.js';
import { drawnPosition } from '../web/render.js';
import { mount, setTheme, theme, type Canvas, type Changed, type Shape } from '../web/canvas.js';
import type { Commit, Step, TreeEntry } from '../src/types.js';

const b = browser();

const oid = (n: string) => (n + '-').padEnd(40, '0');
const C1 = oid('c1');
const C0 = oid('c0');
const T1 = oid('t1');
const B1 = oid('b1');
const ENTRY = 'index:0:a.txt';
const REF = 'ref:refs/heads/main';

const commit = (o: string, tree: string, parents: string[]): Commit => ({
    oid: o,
    tree,
    parents,
    author: 'A <a@b>',
    authorDate: 0,
    committer: 'A <a@b>',
    committerDate: 0,
    subject: `commit ${o.slice(0, 7)}`,
    message: `commit ${o.slice(0, 7)}`,
});
const entry = (name: string, o: string): TreeEntry => ({
    mode: '100644',
    name,
    oid: o,
    type: 'blob',
});

/** Two commits, a tree with one blob in it, one staged path, one branch. */
function repoStep(extra: Partial<Step> = {}): Step {
    return fakeStep({
        head: { ref: 'refs/heads/main', oid: C1, detached: false, unborn: false },
        refs: [{ name: 'refs/heads/main', oid: C1, objectType: 'commit', packed: false }],
        commits: { [C1]: commit(C1, T1, [C0]), [C0]: commit(C0, oid('t0'), []) },
        trees: { [T1]: [entry('a.txt', B1)], [oid('t0')]: [] },
        objects: {
            [T1]: { oid: T1, type: 'tree', size: 3 },
            [oid('t0')]: { oid: oid('t0'), type: 'tree', size: 0 },
            [B1]: { oid: B1, type: 'blob', size: 6 },
        },
        index: [{ path: 'a.txt', oid: B1, mode: '100644', stage: 0 }],
        window: { commits: [C1, C0], totalCommits: 2, more: false, refsOutside: 0 },
        ...extra,
    });
}

/** A second step: another commit, so something has actually happened. */
function nextStep(): Step {
    const c2 = oid('c2');
    const s = repoStep({ seq: 2, time: 1 });
    s.commits[c2] = commit(c2, T1, [C1]);
    s.refs = [{ name: 'refs/heads/main', oid: c2, objectType: 'commit', packed: false }];
    s.head = { ref: 'refs/heads/main', oid: c2, detached: false, unborn: false };
    s.window.commits = [c2, C1, C0];
    return s;
}

// The constructor's camera, which a replayed recording leaves alone.
const HOME = { x: 24, y: 24, scale: 1 };
/** Where a canvas point is on screen, under a camera. */
const screen = (x: number, y: number, cam = HOME) => ({
    clientX: x * cam.scale + cam.x,
    clientY: y * cam.scale + cam.y,
});

// Every click gets its own moment, so that no two of them are taken for a pair.
let clock = 0;
const moment = () => (clock += 1000);

function click(el: FakeElement, x: number, y: number, extra: Partial<FakeEvent> = {}) {
    const e = { ...screen(x, y), timeStamp: moment(), ...extra };
    el.fire('pointerdown', e);
    el.fire('pointerup', e);
}

/** Two clicks near enough in time and place to be one gesture. */
function doubleClick(el: FakeElement, x: number, y: number) {
    const at = screen(x, y);
    const t = moment();
    for (const when of [t, t + 100]) {
        el.fire('pointerdown', { ...at, timeStamp: when });
        el.fire('pointerup', { ...at, timeStamp: when });
    }
}

/** Press at one canvas point, move to another, let go. */
function drag(el: FakeElement, from: [number, number], to: [number, number]) {
    el.fire('pointerdown', { ...screen(...from), timeStamp: moment() });
    el.fire('pointermove', { ...screen(...to), timeStamp: moment() });
    el.fire('pointerup', { ...screen(...to), timeStamp: moment() });
}

/**
 * Every canvas this file makes, so that every one is taken away again.
 * `web/render.ts` keeps where each shape was last painted in one module-level
 * map — a page has one canvas, so nothing there has to say which — and two live
 * canvases in one process ease the same shape towards two places for ever.
 */
const live: Canvas[] = [];
function make(target: FakeElement, options: Parameters<typeof mount>[1] = {}): Canvas {
    const canvas = mount(target as unknown as HTMLElement, options);
    live.push(canvas);
    return canvas;
}

afterEach(() => {
    for (const canvas of live.splice(0)) canvas.destroy();
    b.paint();
    b.reduceMotion = false;
    setTheme('dark');
});

/** Every fade run out. What is under the pointer is tested against where a
 *  shape was *painted*, so a test that clicks on one has to let it arrive. */
function settle() {
    let frames = 0;
    while (b.pending > 0) {
        b.advance(200);
        b.paint();
        assert.ok(++frames < 300, 'the fades have to converge');
    }
}

/**
 * A canvas standing on a replayed recording: the steps are in, the scene is laid
 * out, and the camera has not been moved — so canvas points are screen points.
 */
function canvasOn(steps: Step[], options: Parameters<typeof mount>[1] = {}) {
    const el = new FakeCanvas();
    const changes: Changed[] = [];
    const chosen: (Shape | null)[] = [];
    const canvas = make(el, {
        onChange: (what) => changes.push(what),
        onSelect: (shape) => chosen.push(shape),
        ...options,
    });
    canvas.showAll(steps);
    canvas.redraw(false);
    b.paint();
    return { el, canvas, changes, chosen };
}

/** The same, with every commit opened, which is what puts trees and blobs on
 *  screen: everything starts collapsed on the first step. */
function opened(steps: Step[], options: Parameters<typeof mount>[1] = {}) {
    const on = canvasOn(steps, options);
    on.canvas.expandAll();
    on.changes.length = 0;
    b.paint();
    return on;
}

// Where the shapes land, with two commits and nothing opened.
const SHUT = {
    commit: [244, 38] as [number, number],
    olderCommit: [244, 82] as [number, number],
    ref: [128, 36] as [number, number],
    indexEntry: [628, 28] as [number, number],
    empty: [244, 400] as [number, number],
    // Half a column gap past the commits column, which is 88 wide from x 206.
    commitsEdge: [308, 400] as [number, number],
};
// And with every commit opened, which widens the trees and blobs column.
const OPEN = {
    commit: [244, 38] as [number, number],
    tree: [396, 39] as [number, number],
    blob: [586, 39] as [number, number],
    indexEntry: [1008, 38] as [number, number],
};

// ---------------------------------------------------------------------------

describe('mounting', () => {
    it('puts a canvas of its own inside an element that is not one', () => {
        const box = new FakeElement();
        const canvas = make(box);
        assert.equal(box.children.length, 1);
        assert.equal(box.children[0].style.width, '100%');
        canvas.destroy();
        assert.equal(box.children.length, 0, 'what it made, it takes away');
    });

    it('leaves a canvas it was handed in the page it came from', () => {
        const box = new FakeElement();
        const el = new FakeCanvas();
        box.append(el);
        const canvas = make(el);
        canvas.destroy();
        assert.equal(box.children.length, 1, 'a page keeps what it owns');
        assert.equal(el.listening, false, 'and nothing is still listening to it');
    });

    it('keeps the settings it was given and defaults the rest', () => {
        const canvas = make(new FakeCanvas(), {
            settings: { showPins: true, showNames: undefined },
        });
        assert.equal(canvas.settings.showPins, true);
        assert.equal(canvas.settings.showNames, true, 'not given is not the same as off');
    });

    it('paints in the ground it was asked for', () => {
        make(new FakeCanvas(), { theme: 'light' });
        assert.equal(theme.ground, '#fbfbfd');
    });

    it('starts on the view it was handed', () => {
        const canvas = make(new FakeCanvas(), {
            view: { showIndex: false },
        });
        assert.equal(canvas.recording.view.showIndex, false);
    });

    it('draws nothing before the first step, and answers to nothing either', () => {
        const { el, canvas, changes, chosen } = canvasOn([]);
        canvas.redraw();
        canvas.fitCamera();
        b.paint();
        assert.equal(canvas.drawn, null);
        assert.equal(canvas.shape('anything'), null);
        // A repository being read is a second or two, and the pointer is already
        // over the canvas.
        el.fire('pointermove', screen(200, 200));
        drag(el, [200, 200], [400, 400]);
        el.fire('contextmenu', screen(200, 200));
        doubleClick(el, 200, 200);
        assert.deepEqual([changes, chosen, canvas.pins.count], [[], [null], 0]);
    });
});

describe('a step arriving', () => {
    it('frames the whole object graph on the first step', () => {
        const el = new FakeCanvas();
        const canvas = make(el);
        canvas.show(repoStep());
        b.paint();
        const cam = fit(canvas.drawn!, el.clientWidth);
        assert.notEqual(cam.scale, 1, 'the object graph is wider than the canvas');
        click(el, 0, 0, screen(...SHUT.commit, cam));
        assert.equal(canvas.selected, C1, 'the commit is where the fitted camera put it');
    });

    it('frames it again when a step makes the object graph wider', () => {
        const el = new FakeCanvas();
        const canvas = make(el);
        canvas.show(repoStep());
        const framed = fit(canvas.drawn!, el.clientWidth);
        canvas.show(nextStep());
        settle();
        // The width is fitted again; the vertical place you were reading is kept.
        const cam = refit(canvas.drawn!, canvas.viewport, framed);
        click(el, 0, 0, screen(...SHUT.commit, cam));
        assert.equal(canvas.selected, oid('c2'), 'the newest commit sits at the top');
    });

    it('leaves the camera where you put it when refitting is off', () => {
        const el = new FakeCanvas();
        const canvas = make(el, {
            settings: { refitOnChange: false },
        });
        canvas.show(repoStep());
        const first = fit(canvas.drawn!, el.clientWidth);
        canvas.show(nextStep());
        settle();
        click(el, 0, 0, screen(...SHUT.commit, first));
        assert.equal(canvas.selected, oid('c2'), 'still at the scale the first step set');
    });

    it('replays a whole recording without painting any of it', () => {
        const el = new FakeCanvas();
        const canvas = make(el);
        assert.deepEqual(canvas.showAll([repoStep(), nextStep()]), { prev: null });
        assert.equal(canvas.drawn, null, 'recorded, not performed');
        assert.equal(canvas.recording.steps.length, 2);
    });

    it('says nothing when the stream hands back a step it already holds', () => {
        const { canvas } = canvasOn([repoStep()]);
        assert.equal(canvas.show(repoStep()).kind, 'none');
        assert.equal(canvas.showAll([repoStep()]), null);
    });

    // The stream reconnects by itself, and git may have moved while it was down.
    // The recording arriving again is then a step like any other — what was on
    // screen is where it came from, so the page can say what changed and leave
    // the camera alone rather than treat the viewer as having just arrived.
    it('comes from the step on screen when the stream reconnects with news', () => {
        const { canvas } = canvasOn([repoStep()]);
        assert.deepEqual(canvas.showAll([repoStep(), nextStep()]), { prev: repoStep() });
    });

    // `--fresh` comes down that same frame, and it is not news about the recording
    // on screen — it is a different recording. The page frames the object graph on
    // a step it has nothing to come from, so a browser started over has to have
    // nothing to come from, or the camera stays where it was around a scene the
    // presenter has just replaced.
    it('comes from nothing when --fresh replaces the recording it was holding', () => {
        const { canvas } = canvasOn([repoStep(), nextStep()]);
        // Numbered from one again, at another moment: the recording was started over.
        const over = { ...repoStep(), seq: 1, time: 99 };
        assert.deepEqual(canvas.showAll([over]), { prev: null });
        assert.equal(canvas.recording.steps.length, 1, 'the old recording is gone');
    });

    it('spends the accent only when the repository actually moved', () => {
        const { canvas } = canvasOn([repoStep()]);
        // Nothing has happened between these two, so there is nothing to flash.
        assert.equal(canvas.show({ ...repoStep(), seq: 2, time: 1 }).kind, 'shown');
        b.advance(3000);
        b.paint();
        assert.equal(b.pending, 0, 'a step that changed nothing leaves no flash burning');
    });
});

describe('walking the recording', () => {
    it('steps back and forward, and reaching the newest is live again', () => {
        const { canvas } = canvasOn([repoStep(), nextStep()]);
        assert.ok(canvas.step(-1));
        assert.equal(canvas.recording.following, false);
        assert.ok(canvas.step(1));
        assert.equal(canvas.recording.following, true);
    });

    it('scrubbing stops the recording following, and live comes back', () => {
        const { canvas } = canvasOn([repoStep(), nextStep()]);
        assert.ok(canvas.scrubTo(0));
        assert.equal(canvas.recording.following, false);
        assert.ok(canvas.live());
        assert.equal(canvas.recording.cursor, 1);
    });

    it('going to a step that is not there goes nowhere', () => {
        const { canvas } = canvasOn([repoStep()]);
        assert.equal(canvas.goto(9), null);
        assert.ok(canvas.goto(0));
    });
});

describe('the toggles', () => {
    it('hiding the index takes its shapes off the canvas', () => {
        const { canvas, changes } = canvasOn([repoStep()]);
        assert.ok(canvas.shape(ENTRY), 'the staged path is drawn to begin with');
        canvas.setView({ showIndex: false });
        assert.equal(canvas.shape(ENTRY), null, 'hidden means absent');
        assert.deepEqual(changes, ['view']);
    });

    it('expanding and collapsing everything is a view change', () => {
        const { canvas, changes } = canvasOn([repoStep()]);
        canvas.expandAll();
        assert.ok(canvas.shape(T1), 'the tree the commit links to');
        canvas.collapseAll();
        assert.equal(canvas.shape(T1), null);
        assert.deepEqual(changes, ['view', 'view']);
    });
});

describe('selecting', () => {
    it('clicking a shape hands it over', () => {
        const { el, canvas, chosen } = canvasOn([repoStep()]);
        click(el, ...SHUT.commit);
        assert.equal(canvas.selected, C1);
        assert.equal(chosen.at(-1)?.oid, C1);
    });

    it('clicking empty space drops the selection', () => {
        const { el, canvas, chosen } = canvasOn([repoStep()]);
        click(el, ...SHUT.commit);
        click(el, ...SHUT.empty);
        assert.equal(canvas.selected, null);
        assert.equal(chosen.at(-1), null);
    });

    it('selecting brings what you clicked to the middle when asked to', () => {
        const { el, canvas } = canvasOn([repoStep()], { settings: { centreOnClick: true } });
        click(el, ...SHUT.commit);
        // The camera moved, so the same screen point is over something else now.
        click(el, ...SHUT.commit);
        assert.notEqual(canvas.selected, C1);
    });

    it('a page can put back what was selected before a reload', () => {
        const { canvas } = canvasOn([repoStep()]);
        canvas.selected = C1;
        assert.equal(canvas.selected, C1, 'set without asking the inspector to be told');
    });

    it('selecting something that is not drawn hands over nothing', () => {
        const { canvas, chosen } = canvasOn([repoStep()]);
        canvas.select('no such shape');
        assert.equal(chosen.at(-1), null);
        assert.equal(canvas.selected, 'no such shape', 'the id is still what you asked for');
    });
});

describe('expanding and collapsing by hand', () => {
    it('double-clicking a commit shows what it links to', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        doubleClick(el, ...SHUT.commit);
        assert.ok(canvas.shape(T1));
        assert.deepEqual(changes, ['view']);
    });

    it('double-clicking a tree shuts it', () => {
        const { el, canvas } = opened([repoStep()]);
        assert.ok(canvas.shape(B1), 'the blob the tree names');
        doubleClick(el, ...OPEN.tree);
        assert.equal(canvas.shape(B1), null);
        assert.deepEqual(canvas.recording.view.collapsed, [T1]);
    });

    it('double-clicking an index entry draws the blob its sha names', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        assert.equal(canvas.shape(B1), null);
        doubleClick(el, ...SHUT.indexEntry);
        assert.ok(canvas.recording.view.expanded.includes(ENTRY));
    });

    it('double-clicking a pointer chip does nothing at all', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        doubleClick(el, ...SHUT.ref);
        assert.equal(canvas.selected, REF, 'the first click still selected it');
        assert.deepEqual(changes, [], 'and the second changed no view');
    });

    it('double-clicking empty space pulls the whole object graph back', () => {
        const { el, canvas, changes } = opened([repoStep()]);
        settle();
        // Zoomed out to the full width, but staying where you were reading — so it
        // is worked out from the point double-clicked, not from the top.
        const cam = zoomOut(canvas.drawn!, canvas.viewport, SHUT.empty[1]);
        doubleClick(el, ...SHUT.empty);
        settle();
        assert.deepEqual(changes, [], 'the ground is not a view');
        click(el, 0, 0, screen(...OPEN.tree, cam));
        assert.equal(canvas.selected, T1);
    });
});

describe('marking', () => {
    it('right-clicking follows a shape, and again stops following it', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        el.fire('contextmenu', screen(...SHUT.commit));
        assert.deepEqual([...canvas.marked], [C1]);
        el.fire('contextmenu', screen(...SHUT.commit));
        assert.deepEqual([...canvas.marked], []);
        assert.deepEqual(changes, ['marks', 'marks']);
    });

    it('right-clicking empty space marks nothing', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        el.fire('contextmenu', screen(...SHUT.empty));
        assert.equal(canvas.marked.size, 0);
        assert.deepEqual(changes, []);
    });
});

describe('pinning', () => {
    it('dragging a shape leaves it where it was dropped', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        drag(el, SHUT.commit, [500, 300]);
        assert.equal(canvas.pins.count, 1);
        assert.deepEqual(changes, ['pins']);
        assert.ok(canvas.shape(C1)!.pinned);
    });

    it('shift-clicking takes the pin out again', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        drag(el, SHUT.commit, [500, 300]);
        click(el, 500, 300, { shiftKey: true });
        assert.equal(canvas.pins.count, 0);
        assert.deepEqual(changes, ['pins', 'pins']);
        assert.equal(canvas.selected, null, 'and it is one act: nothing was selected');
    });

    // A shape slides to a new place rather than jumping there, and for the length
    // of that slide it is drawn short of where layout is sending it. Grabbing one
    // has to hold it where it was grabbed: taking the offset from the layout
    // position threw it the rest of the way the moment the pointer moved.
    it('holds a shape in flight where it was grabbed', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        settle();
        drag(el, SHUT.commit, [500, 300]);
        settle();
        click(el, 500, 300, { shiftKey: true }); // unpinned: it sets off home
        b.paint(); // one frame, part of the way there

        const at = drawnPosition(C1)!;
        assert.notDeepEqual([at.x, at.y], [canvas.shape(C1)!.x, canvas.shape(C1)!.y]);
        drag(el, [at.x + 10, at.y + 10], [at.x + 40, at.y + 30]);
        assert.deepEqual(
            [canvas.shape(C1)!.x, canvas.shape(C1)!.y],
            [at.x + 30, at.y + 20],
            'it moved with the pointer, not from wherever it was headed',
        );
    });

    it('shift-clicking something that was never pinned changes nothing', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        click(el, ...SHUT.commit, { shiftKey: true });
        click(el, ...SHUT.empty, { shiftKey: true });
        assert.deepEqual(changes, []);
        assert.equal(canvas.selected, null);
    });

    it('resetting takes every pin out and every widened column back', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        drag(el, SHUT.commit, [500, 300]);
        drag(el, SHUT.commitsEdge, [400, 400]);
        changes.length = 0;
        canvas.resetView();
        assert.equal(canvas.pins.count, 0);
        assert.deepEqual(canvas.columnWidths, {});
        assert.deepEqual(changes, ['pins', 'columns']);
    });
});

describe('the columns', () => {
    it('dragging a column edge widens the column', () => {
        const { el, canvas, changes } = canvasOn([repoStep()]);
        drag(el, SHUT.commitsEdge, [400, 400]);
        // The edge sits half a gap past the column, which starts at 206.
        assert.equal(canvas.columnWidths.commits, 400 - 14 - 206);
        assert.deepEqual(changes, ['columns'], 'told once, at the end of the drag');
    });

    it('a shape under the pointer wins the edge it is standing on', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        // The older commit's right side reaches the commits column's own edge.
        drag(el, [280, 82], [400, 400]);
        assert.deepEqual(canvas.columnWidths, {}, 'nothing was resized');
        assert.equal(canvas.pins.count, 1, 'the commit was dragged instead');
    });
});

describe('the camera', () => {
    it('dragging empty space pans the object graph under it', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        drag(el, SHUT.empty, [SHUT.empty[0] + 100, SHUT.empty[1]]);
        click(el, ...SHUT.commit);
        assert.notEqual(canvas.selected, C1, 'the commit moved out from under that point');
        click(el, SHUT.commit[0] + 100, SHUT.commit[1]);
        assert.equal(canvas.selected, C1);
    });

    it('the wheel glides the object graph rather than jumping it', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        el.fire('wheel', { deltaX: 60, deltaY: 0 });
        // One frame is part of the way there; it takes a few to arrive.
        b.paint();
        // A second notch adds to where the first one was heading, not to where the
        // canvas has got to — otherwise a fast scroll falls short of itself.
        el.fire('wheel', { deltaX: 40, deltaY: 0 });
        const after = canvas.drawn;
        assert.ok(after);
        let frames = 0;
        while (b.pending > 0) {
            b.advance(16);
            b.paint();
            assert.ok(++frames < 200, 'a glide has to end');
        }
        click(el, SHUT.commit[0] - 100, SHUT.commit[1]);
        assert.equal(canvas.selected, C1, 'and it ends where it was asked to');
    });

    it('holding ctrl makes the wheel zoom about the pointer', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        el.fire('wheel', { ...screen(...SHUT.commit), ctrlKey: true, deltaY: -400 });
        b.paint();
        click(el, ...SHUT.commit);
        assert.equal(canvas.selected, C1, 'the point under the pointer stayed under it');
        el.fire('wheel', { ...screen(...SHUT.commit), metaKey: true, deltaY: 400 });
        b.paint();
    });

    it('the wheel before the first step has nothing to move', () => {
        const el = new FakeCanvas();
        make(el);
        el.fire('wheel', { deltaY: 100 });
        assert.equal(b.pending, 1, 'only the frame the mount asked for');
        b.paint();
    });

    it('fitting is the way back from anywhere', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        el.fire('wheel', { ...screen(...SHUT.commit), ctrlKey: true, deltaY: -400 });
        canvas.fitCamera();
        b.paint();
        const cam = fit(canvas.drawn!, el.clientWidth);
        click(el, 0, 0, screen(...SHUT.commit, cam));
        assert.equal(canvas.selected, C1);
    });
});

describe('the pointer', () => {
    it('the cursor says what is under it', () => {
        const { el } = canvasOn([repoStep()]);
        el.fire('pointermove', screen(...SHUT.commit));
        assert.equal(el.style.cursor, 'pointer');
        el.fire('pointermove', screen(...SHUT.commitsEdge));
        assert.equal(el.style.cursor, 'col-resize');
        el.fire('pointermove', screen(...SHUT.empty));
        assert.equal(el.style.cursor, 'grab');
        el.fire('pointermove', screen(...SHUT.empty)); // the same place says nothing new
        assert.equal(el.style.cursor, 'grab');
    });

    it('grabbing and letting go says so', () => {
        const { el } = canvasOn([repoStep()]);
        el.fire('pointermove', screen(...SHUT.commit));
        el.fire('pointerdown', { ...screen(...SHUT.commit), timeStamp: moment() });
        assert.equal(el.style.cursor, 'grabbing');
        el.fire('pointerup', { ...screen(...SHUT.commit), timeStamp: moment() });
        assert.equal(el.style.cursor, 'pointer');
    });

    it('a button that is not the left one is not a gesture', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        el.fire('pointerdown', { ...screen(...SHUT.commit), button: 2, timeStamp: moment() });
        el.fire('pointerup', { ...screen(...SHUT.commit), button: 2, timeStamp: moment() });
        assert.equal(canvas.selected, null);
    });
});

describe('painting', () => {
    it('asks for nothing once everything has settled', () => {
        const { canvas } = canvasOn([repoStep()]);
        let frames = 0;
        while (b.pending > 0) {
            b.advance(200);
            b.paint();
            assert.ok(++frames < 200, 'the fades have to converge');
        }
        assert.equal(b.pending, 0, 'idle costs nothing');
        assert.ok(canvas.drawn);
    });

    it('a step that draws the same shapes leaves the fade alone', () => {
        const { canvas } = canvasOn([repoStep()]);
        b.advance(3000);
        b.paint();
        canvas.redraw();
        b.paint();
        assert.equal(b.pending, 0, 'nothing moved, so nothing has to be eased');
    });

    it('the element changing size repaints it', () => {
        const { el, canvas } = canvasOn([repoStep()]);
        b.advance(3000);
        b.paint();
        el.clientWidth = 400;
        b.resize();
        assert.equal(b.pending, 1);
        b.paint();
        assert.equal(el.width, 800, 'and in device pixels');
        assert.ok(canvas.drawn);
    });

    it('painting stops when the canvas is destroyed under it', () => {
        const { canvas } = canvasOn([repoStep()]);
        canvas.destroy();
        canvas.schedule();
        b.paint();
        assert.equal(canvas.drawn, null);
    });
});

describe('reduced motion', () => {
    it('arrives in one frame rather than easing into place', () => {
        b.reduceMotion = true;
        const el = new FakeCanvas();
        const canvas = make(el);
        canvas.show(repoStep());
        canvas.show(nextStep());
        b.paint();
        assert.equal(b.pending, 0, 'nothing is in flight, so nothing is wanted');
        assert.ok(canvas.drawn);
        // And a wheel pan is there at once rather than gliding.
        el.fire('wheel', { deltaX: 100 });
        b.paint();
        assert.equal(b.pending, 0);
    });
});
