/**
 * The canvas on its own: a mounted `<canvas>`, the paint loop, the camera, and
 * every gesture the object graph answers to. Nothing else — no toolbars, no
 * inspector, no server, no `localStorage`.
 *
 * This is what the `gitva/canvas` entry point publishes, and it is the reason
 * it can be published at all: a step is what git did, so a canvas that is
 * *handed* steps does not care whether they came off a repository this second
 * or out of a recording written months ago. A page teaching git command by
 * command can hold its own steps and hand them over one at a time.
 *
 * `web/app.ts` is one such page — the toolbars, the inspector and the stream of
 * steps sit on top of this and nowhere else, so every gesture has exactly one
 * implementation.
 *
 * Nothing here asks anything of any server: the whole of what is drawn arrives
 * in the step, and the view never leaves the object holding it.
 */

import { describe, diffScenes, isVisible, EMPTY_CHANGE, type Change } from './diff.js';
import { layout, M, type Scene, type Shape } from './layout.js';
import { S } from './localization/index.js';
import {
    bounded,
    centre,
    fit,
    glideStep,
    refit,
    toCanvas,
    zoom,
    zoomOut,
    type Camera,
} from './camera.js';
import { columnEdgeAt, draw, hitTest, snapPositions } from './render.js';
import { isDouble, Pins, Recording, type Arrival, type Click } from './recording.js';
import { setTheme, theme, type Mode } from './theme.js';
import type { Step, View } from '../src/types.js';

/** How the canvas is drawn and what it does when you click. Every one of them
 *  is yours — none is a question for whoever handed the steps over. */
export interface CanvasSettings {
    /** The names on a tree's links. */
    showNames: boolean;
    /** Show where a pinned shape would have sat. */
    showPins: boolean;
    /** Bring what you clicked to the middle. */
    centreOnClick: boolean;
    /** Fit the width again when a step makes the object graph wider. */
    refitOnChange: boolean;
    /** A commit that arrives opens itself, once. */
    expandNewCommits: boolean;
}

/** What changed, for a page that wants to write it down. The canvas has already
 *  redrawn itself by the time this is called, and it says the same thing whether
 *  a gesture on the canvas or a call from the page did it — so a page that
 *  persists anything has one place to do it. */
export type Changed = 'view' | 'pins' | 'marks' | 'columns';

export interface MountOptions {
    /** The ground. Left alone when not given, so a page that sets its own theme
     *  keeps it. */
    theme?: Mode;
    /** What starts expanded, and what is drawn at all. */
    view?: Partial<View>;
    settings?: Partial<CanvasSettings>;
    /** Something was selected, or the selection was dropped by clicking away.
     *  A shape carrying an `oid` is a key into the object store — copying it is
     *  the page's to do, because the clipboard is the page's. */
    onSelect?: (shape: Shape | null) => void;
    onChange?: (what: Changed) => void;
}

const DEFAULTS: CanvasSettings = {
    showNames: true,
    showPins: false,
    centreOnClick: false,
    refitOnChange: true,
    expandNewCommits: true,
};

/**
 * A canvas drawing a recording. Made by `mount`.
 *
 * `recording`, `pins`, `marked`, `columnWidths` and `settings` are all yours to
 * read and to set: a page that keeps any of them between visits writes them out
 * on `onChange` and puts them back before the first step.
 */
export class Canvas {
    readonly element: HTMLCanvasElement;
    readonly recording = new Recording();
    readonly pins = new Pins();
    /** Shapes you are following, by id. Right-click adds and removes. */
    readonly marked = new Set<string>();
    /** How wide each column has been dragged, by column key. */
    readonly columnWidths: Record<string, number> = {};
    readonly settings: CanvasSettings;

    private readonly ctx: CanvasRenderingContext2D;
    /** Whether `mount` made the element, and so may take it away again. */
    private readonly made: boolean;
    private readonly options: MountOptions;
    private readonly listeners = new AbortController();
    private readonly sizing: ResizeObserver;
    private readonly reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

    private scene: Scene | null = null;
    private leaving: Shape[] = [];
    private change: Change = EMPTY_CHANGE;
    private flashAt = -1e9;
    private enterAt = -1e9;
    // A shape you removed yourself is gone the moment you asked; one git removed
    // has to be seen going, or the lesson leaves the screen before you read it.
    private exitMs = theme.duration;
    private camera: Camera = { x: 24, y: 24, scale: 1 };
    /** Where wheel panning is heading. Every other camera move is direct, and
     *  cancels it. */
    private glide: { x: number; y: number } | null = null;
    private hovered: string | null = null;
    private chosen: string | null = null;
    private running = false;
    /** The last click, waiting to see whether a second one joins it. */
    private lastClick: Click | null = null;
    private drag: {
        id: string | null;
        x: number;
        y: number;
        moved: boolean;
        dx: number;
        dy: number;
    } | null = null;
    /** The column edge under the pointer, or the one being dragged. */
    private hoverEdge: string | null = null;
    private resize: { key: string; column: { x: number; w: number } } | null = null;

    constructor(target: HTMLElement, options: MountOptions = {}) {
        this.options = options;
        // Its own keys and no others. A page keeps its answer to "how do you like
        // to work" in one object, of which only half is the canvas's — and a copy
        // of the other half carried around here is a stale one, waiting to be
        // written back over the live one.
        this.settings = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS) as (keyof CanvasSettings)[]) {
            const given = options.settings?.[key];
            if (given !== undefined) this.settings[key] = given;
        }
        if (options.theme) setTheme(options.theme);
        this.made = !(target instanceof HTMLCanvasElement);
        if (target instanceof HTMLCanvasElement) {
            this.element = target;
        } else {
            this.element = target.ownerDocument.createElement('canvas');
            // The page decides how big the region is; the canvas fills it.
            this.element.style.display = 'block';
            this.element.style.width = '100%';
            this.element.style.height = '100%';
            target.append(this.element);
        }
        this.element.style.cursor = 'grab';
        this.ctx = this.element.getContext('2d')!;
        if (options.view) this.recording.view = { ...this.recording.view, ...options.view };

        const signal = this.listeners.signal;
        const on = <K extends keyof HTMLElementEventMap>(
            type: K,
            f: (e: HTMLElementEventMap[K]) => void,
            opts?: AddEventListenerOptions,
        ) => this.element.addEventListener(type, f, { ...opts, signal });
        on('pointerdown', (e) => this.pointerDown(e));
        on('pointermove', (e) => this.pointerMove(e));
        on('pointerup', (e) => this.pointerUp(e));
        on('contextmenu', (e) => this.mark(e));
        on('wheel', (e) => this.wheel(e), { passive: false });

        this.sizing = new ResizeObserver(() => this.resized());
        this.sizing.observe(this.element);
        this.resized();
    }

    // -----------------------------------------------------------------------
    // What is on screen
    // -----------------------------------------------------------------------

    /** The scene as it was last laid out, or null before the first step. */
    get drawn(): Scene | null {
        return this.scene;
    }

    /** What is selected, by shape id. */
    get selected(): string | null {
        return this.chosen;
    }
    set selected(id: string | null) {
        this.chosen = id;
        this.schedule();
    }

    /** The shape with that id in what is drawn, if it is drawn at all. */
    shape(id: string | null): Shape | null {
        return id ? (this.scene?.shapes.find((n) => n.id === id) ?? null) : null;
    }

    get viewport(): { width: number; height: number } {
        return { width: this.element.clientWidth, height: this.element.clientHeight };
    }

    /**
     * A step, drawn. `replay` is for steps the page is catching up on rather than
     * showing — they are recorded, not performed, so nothing is painted until the
     * last one is in and the caller redraws.
     */
    show(step: Step, replay = false): Arrival {
        const arrival = this.recording.arrive(
            step,
            {
                showIndex: this.recording.view.showIndex,
                expandNewCommits: this.settings.expandNewCommits,
            },
            replay,
        );
        if (replay || arrival.kind !== 'shown') return arrival;
        this.redraw(true, this.repoMoved(arrival.prev));
        // The first step frames the object graph; after that only if asked to,
        // because history arriving is what makes it outgrow the canvas.
        if (this.scene && (arrival.first || this.settings.refitOnChange)) {
            this.camera = arrival.first
                ? fit(this.scene, this.element.clientWidth)
                : refit(this.scene, this.viewport, this.camera);
            this.glide = null;
            this.schedule();
        }
        return arrival;
    }

    /** Stand at step `i` and draw it; null if there is no such step. What was on
     *  screen before comes back, for a page that wants to say what changed. */
    goto(i: number): { prev: Step | null } | null {
        return this.moved(this.recording.jump(i));
    }

    /** The same, for a control that is *how you left* the newest step — a scrub
     *  bar. Standing somewhere by hand stops the recording following, so a step
     *  arriving cannot yank the canvas out from under you; `live()` is the way
     *  back. A page with no such control wants `goto`. */
    scrubTo(i: number): { prev: Step | null } | null {
        return this.moved(this.recording.scrubTo(i));
    }

    /** One step back or forward. Reaching the newest starts following again, so
     *  walking to the end of a recording leaves you live. */
    step(delta: number): { prev: Step | null } | null {
        return this.moved(this.recording.step(delta));
    }

    /** Back to the newest step, and following it again. */
    live(): { prev: Step | null } | null {
        return this.moved(this.recording.goLive());
    }

    /**
     * The three toggles, and anything else a `View` holds, merged in and drawn.
     * It asks nothing of anyone: the step on screen already carries everything
     * any view could draw, which is what makes the view yours.
     */
    setView(patch: Partial<View>): void {
        this.recording.view = { ...this.recording.view, ...patch };
        this.redraw();
        this.options.onChange?.('view');
    }

    /** Show what every commit on screen links to, or shut them all. */
    expandAll(): void {
        this.recording.expandAll();
        this.redraw();
        this.options.onChange?.('view');
    }

    collapseAll(): void {
        this.recording.collapseAll();
        this.redraw();
        this.options.onChange?.('view');
    }

    /** Take one shape's pin out and let the layout have it back — what
     *  shift-clicking it does. */
    unpin(id: string): void {
        if (!this.pins.drop(id)) return;
        this.redraw();
        this.options.onChange?.('pins');
    }

    /**
     * Every pin out and every hand-widened column back to its own width: the way
     * back from a canvas you have rearranged, and the only one there is once
     * something has been dragged off screen.
     */
    resetView(): void {
        this.pins.clear();
        for (const key of Object.keys(this.columnWidths)) delete this.columnWidths[key];
        this.redraw();
        this.options.onChange?.('pins');
        this.options.onChange?.('columns');
    }

    /**
     * Lay the scene out again and paint it. `animate` fades the difference in;
     * `flash` spends the one reserved accent on it, and is what "git just did
     * this" looks like.
     */
    redraw(animate = true, flash = false): void {
        // Every tree the recording has ever read, not only the ones this step came
        // with: a commit opened now has to draw open on a step recorded before it was.
        const step = this.recording.shown;
        if (!step) return;
        const next = layout(step, this.recording.view, this.pins.at(step.seq), this.columnWidths);
        // Dragging is the one move that must not lag the cursor, so it snaps.
        if (!animate) snapPositions();
        const fresh = diffScenes(this.scene, next);
        const same = this.scene !== null && !isVisible(fresh);
        const going = this.scene ? this.scene.shapes.filter((n) => fresh.removed.has(n.id)) : [];
        this.scene = next;
        // A step that draws the same shapes leaves the flash and any fade alone.
        if (same) return this.schedule();
        this.change = fresh;
        this.leaving = going;
        if (animate) {
            this.enterAt = performance.now();
            this.exitMs = flash ? 2500 : theme.duration;
            if (flash) this.flashAt = performance.now();
        } else {
            this.enterAt = -1e9;
        }
        this.schedule();
    }

    /** The recording moved: draw where it stands now. */
    private moved(to: { prev: Step | null } | null): { prev: Step | null } | null {
        if (to) this.redraw(true, this.repoMoved(to.prev));
        return to;
    }

    /** Whether the repository actually did something between `prev` and the step
     *  now on screen — the one thing the reserved accent is spent on. */
    private repoMoved(prev: Step | null): boolean {
        return prev !== null && describe(prev, this.recording.current!) !== S.change.none;
    }

    /** Fit the width and stay at the top: the way back from anywhere. */
    fitCamera(): void {
        if (!this.scene) return;
        this.camera = fit(this.scene, this.element.clientWidth);
        this.glide = null;
        this.schedule();
    }

    /** Paint on the next frame. Painting stops the moment nothing is moving, so
     *  a canvas sitting still costs nothing at all. */
    schedule(): void {
        if (this.running) return;
        this.running = true;
        requestAnimationFrame(() => this.paint());
    }

    /** Every listener dropped and the frame loop left to stop. The canvas element
     *  itself is removed only if this made it — a page that handed one over keeps
     *  what it owns. */
    destroy(): void {
        this.listeners.abort();
        this.sizing.disconnect();
        this.scene = null;
        if (this.made) this.element.remove();
    }

    // -----------------------------------------------------------------------
    // Painting
    // -----------------------------------------------------------------------

    private resized(): void {
        this.element.width = Math.round(this.element.clientWidth * devicePixelRatio);
        this.element.height = Math.round(this.element.clientHeight * devicePixelRatio);
        this.schedule();
    }

    private paint(): void {
        this.running = false;
        if (!this.scene) return;
        const now = performance.now();
        const still = this.reduceMotion;
        const flash = still ? 0 : Math.max(0, 1 - (now - this.flashAt) / 5000);
        const enter = still ? 1 : Math.min(1, (now - this.enterAt) / theme.duration);
        const exit = still ? 1 : Math.min(1, (now - this.enterAt) / this.exitMs);
        if (this.glide) {
            const step = glideStep(this.camera, this.glide, still ? 1 : 0.22);
            this.camera = step.camera;
            if (step.done) this.glide = null;
        }
        const settling = draw(this.ctx, this.scene, {
            camera: this.camera,
            width: this.element.clientWidth,
            height: this.element.clientHeight,
            dpr: devicePixelRatio,
            change: this.change,
            flash,
            hover: this.hovered,
            selected: this.chosen,
            marked: this.marked,
            showPins: this.settings.showPins,
            showNames: this.settings.showNames,
            enter,
            leaving: this.leaving,
            exit,
            motion: !still,
            resizing: this.hoverEdge,
        });
        if (flash > 0 || enter < 1 || exit < 1 || settling || this.glide) this.schedule();
    }

    // -----------------------------------------------------------------------
    // The camera and the mouse
    // -----------------------------------------------------------------------

    private at(ev: { clientX: number; clientY: number }): { x: number; y: number } {
        return toCanvas(this.camera, ev, this.element.getBoundingClientRect());
    }

    private pointerDown(e: PointerEvent): void {
        if (e.button !== 0) return;
        this.glide = null;
        this.element.setPointerCapture(e.pointerId);
        this.element.style.cursor = 'grabbing';
        const w = this.at(e);
        const hit = this.scene ? hitTest(this.scene, w.x, w.y) : null;
        // A shape under the pointer wins the edge: the edge is empty space by nature.
        const key = hit || !this.scene ? null : columnEdgeAt(this.scene, w.x);
        const column = this.scene?.columns.find((b) => b.key === key);
        this.resize = key && column ? { key, column: { x: column.x, w: column.w } } : null;
        this.drag = hit
            ? {
                  id: hit.id,
                  x: e.clientX,
                  y: e.clientY,
                  moved: false,
                  dx: w.x - hit.x,
                  dy: w.y - hit.y,
              }
            : { id: null, x: e.clientX, y: e.clientY, moved: false, dx: 0, dy: 0 };
    }

    private pointerMove(e: PointerEvent): void {
        const drag = this.drag;
        if (!drag) {
            const w = this.at(e);
            const hit = this.scene ? hitTest(this.scene, w.x, w.y) : null;
            const id = hit?.id ?? null;
            const over = hit || !this.scene ? null : columnEdgeAt(this.scene, w.x);
            if (id !== this.hovered || over !== this.hoverEdge) {
                this.hovered = id;
                this.hoverEdge = over;
                this.element.style.cursor = id ? 'pointer' : over ? 'col-resize' : 'grab';
                this.schedule();
            }
            return;
        }
        const dx = e.clientX - drag.x;
        const dy = e.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (this.resize) {
            // The edge sits half a gap past the column's right edge, and the width is
            // clamped back to the content's own in `layout`, so dragging left stops
            // where the column is full rather than at some number invented here.
            this.columnWidths[this.resize.key] =
                this.at(e).x - M.columnGap / 2 - this.resize.column.x;
            drag.moved = true;
            this.redraw(false);
        } else if (drag.id && drag.moved) {
            const w = this.at(e);
            this.pins.put(this.recording.current?.seq ?? 0, drag.id, w.x - drag.dx, w.y - drag.dy);
            this.redraw(false);
        } else if (!drag.id && this.scene) {
            this.camera = {
                ...this.camera,
                ...bounded(
                    { x: this.camera.x + dx, y: this.camera.y + dy },
                    this.camera.scale,
                    this.scene,
                    this.viewport,
                ),
            };
            drag.x = e.clientX;
            drag.y = e.clientY;
            this.schedule();
        }
    }

    private pointerUp(e: PointerEvent): void {
        this.element.style.cursor = this.hovered ? 'pointer' : 'grab';
        const drag = this.drag;
        if (this.resize) {
            this.resize = null;
            this.drag = null;
            // Told at the end of the gesture, not per pointermove: one drag is a
            // hundred of those.
            this.options.onChange?.('columns');
            return;
        }
        const click: Click | null =
            drag && !drag.moved
                ? { at: e.timeStamp, x: e.clientX, y: e.clientY, id: drag.id }
                : null;
        if (drag?.moved && drag.id) this.options.onChange?.('pins');
        this.drag = null;
        if (!click) return;

        // The pair acts on what the *first* click hit, because that click may have
        // centred it and moved it out from under the pointer.
        const double = isDouble(this.lastClick, click);
        const id = double ? this.lastClick!.id : click.id;
        this.lastClick = double ? null : click;
        const shape = this.shape(id);

        if (double) {
            // Double-click opens the thing you double-clicked, the way it opens a
            // folder everywhere else — and empty space pulls the whole object graph back.
            if (shape?.kind === 'commit') this.recording.toggle(shape.id);
            else if (shape?.kind === 'tree') this.recording.toggleTree(shape.id);
            else if (!shape && this.scene) {
                this.camera = zoomOut(this.scene, this.viewport, this.at(e).y);
                this.glide = null;
                this.schedule();
                return;
            } else return;
            this.redraw(true);
            this.options.onChange?.('view');
            return;
        }
        // Shift is the undo of dragging: the pin comes out and the layout takes the
        // shape back. Nothing is selected or copied on the way — it is one act.
        if (e.shiftKey && id) {
            this.unpin(id);
            return;
        }
        this.chosen = id;
        this.options.onSelect?.(shape);
        if (shape && this.settings.centreOnClick) {
            this.glide = null;
            this.camera = centre(this.camera, shape, this.viewport);
        }
        this.schedule();
    }

    private mark(e: MouseEvent): void {
        e.preventDefault();
        const w = this.at(e);
        const hit = this.scene ? hitTest(this.scene, w.x, w.y) : null;
        if (!hit) return;
        // A shape moves around as the object graph is expanded and collapsed, and a
        // mark is how you follow it. One gesture for every kind: a mark says "keep an
        // eye on this", and that is the same wish whether the thing is a commit, a
        // blob, a branch or a staged path.
        if (!this.marked.delete(hit.id)) this.marked.add(hit.id);
        this.schedule();
        this.options.onChange?.('marks');
    }

    private wheel(e: WheelEvent): void {
        e.preventDefault();
        if (!this.scene) return;
        if (e.ctrlKey || e.metaKey) {
            this.glide = null;
            this.camera = zoom(this.camera, this.at(e), e.deltaY, this.scene, this.viewport);
        } else {
            const at = this.glide ?? this.camera;
            this.glide = bounded(
                { x: at.x - e.deltaX, y: at.y - e.deltaY },
                this.camera.scale,
                this.scene,
                this.viewport,
            );
        }
        this.schedule();
    }
}

/**
 * Put a canvas in the page. `target` is either a `<canvas>` to take over or an
 * element to put one inside — sized by the page, in css pixels.
 */
export function mount(target: HTMLElement, options: MountOptions = {}): Canvas {
    return new Canvas(target, options);
}

export { setLanguage, LANGUAGES } from './localization/index.js';
export { setTheme } from './theme.js';
export { renderInspector } from './inspector.js';
export type { Scene, Shape } from './layout.js';
export type { Mode } from './theme.js';
export type { Arrival } from './recording.js';
export type * from '../src/types.js';
