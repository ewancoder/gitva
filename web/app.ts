/**
 * The client: one view, one recording, one camera.
 *
 * It only ever reads. Every way the user can change what is on screen is a
 * change to the view, which lives here and goes nowhere: the server is told
 * nothing, asked nothing, and one browser cannot alter another's canvas.
 * Everything the browser is shown is kept, so a demo can be replayed instead of
 * redone — and once the recording has arrived, a lost connection costs nothing
 * but the next step.
 *
 * What is left here is DOM: elements, events and painting. Every decision the
 * gestures make is in `recording.ts` and `camera.ts`, where it is tested.
 */

import { diffScenes, isVisible, describe, EMPTY_CHANGE, type Change } from './diff.js';
import { layout, M, type Scene, type Shape } from './layout.js';
import { language, LANGUAGES, S, setLanguage } from './localization/index.js';
import type { Step } from '../src/types.js';
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
import { renderInspector } from './inspector.js';
import { columnEdgeAt, draw, hitTest, snapPositions } from './render.js';
import { isDouble, Pins, Recording, type Click } from './recording.js';
import { type Mode, setTheme, theme } from './theme.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('canvas');
const ctx = canvas.getContext('2d')!;
const inspector = $('inspector');
const viewport = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });

/** Copy a sha and say so briefly; a clipboard the browser refuses is not worth
 *  a dialog. `said` is what to show having copied it: a sha is shown short, and
 *  anything already short enough to read is shown whole. */
let copiedTimer = 0;
function copied(oid: string, said = oid.slice(0, 7)) {
    void navigator.clipboard?.writeText(oid).then(
        () => {
            const el = $('copied');
            el.textContent = S.status.copied(said);
            el.classList.add('show');
            clearTimeout(copiedTimer);
            copiedTimer = setTimeout(() => el.classList.remove('show'), 1200) as unknown as number;
        },
        () => {},
    );
}

// --- settings: about how you like to work, not about this session
interface Settings {
    language: string;
    showIndex: boolean;
    showUnreachable: boolean;
    /** `null` until you have said: `--learning` puts the links from unreachable
     *  up before anyone asks, and must not keep overruling an answer you gave. */
    showLinksFromUnreachable: boolean | null;
    centreOnClick: boolean;
    expandNewCommits: boolean;
    refitOnChange: boolean;
    showPins: boolean;
    showNames: boolean;
    theme: Mode;
    inspectorWidth: number;
}
const settings: Settings = {
    language: 'en',
    showIndex: true,
    showUnreachable: true,
    showLinksFromUnreachable: null,
    centreOnClick: false,
    expandNewCommits: true,
    refitOnChange: true,
    showPins: false,
    showNames: true,
    theme: 'dark',
    inspectorWidth: 430,
    ...JSON.parse(localStorage.getItem('gitva.settings') ?? '{}'),
};
const saveSettings = () => localStorage.setItem('gitva.settings', JSON.stringify(settings));

// --- the ground. Yours, like the language: a setting in this browser,
// never posted, so nobody else's canvas turns white when yours does. Chosen
// before the first paint, because the canvas is painted from it.
const themeBtn = $('theme-btn');

// Rain, on its own canvas over the object graph. The only thing gitva draws
// that says nothing about the repository, so it is kept where it can be left
// out: a separate canvas, faint, and running only while that ground is on —
// idle still costs nothing everywhere else.
const rain = $<HTMLCanvasElement>('rain');
const GLYPHS = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789abcdef';
const CELL = 10;
let drops: number[] = [];
let raining = 0;
function rainFrame() {
    const g = rain.getContext('2d')!;
    const w = rain.width / devicePixelRatio;
    const h = rain.height / devicePixelRatio;
    g.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    // Not a clear: the fade is what leaves a trail behind each drop.
    g.fillStyle = 'rgba(0,6,0,0.04)';
    g.fillRect(0, 0, w, h);
    g.fillStyle = theme.ink;
    g.font = `${CELL}px ${theme.mono}`;
    // Whole cells only: a drop on a fractional row lands between pixels, and a
    // column of glyphs each blurred a different way reads as jitter.
    for (let i = 0; i < Math.ceil(w / CELL); i++) {
        drops[i] ??= -Math.floor(Math.random() * 40);
        g.fillText(GLYPHS[Math.floor(Math.random() * GLYPHS.length)], i * CELL, drops[i] * CELL);
        if (drops[i] * CELL > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
    }
}
function setRain(on: boolean) {
    clearInterval(raining);
    raining = on && !reduceMotion ? (setInterval(rainFrame, 35) as unknown as number) : 0;
    if (!raining) {
        drops = [];
        rain.getContext('2d')!.clearRect(0, 0, rain.width, rain.height);
    }
}

function applyTheme() {
    setTheme(settings.theme);
    setRain(settings.theme === 'matrix');
    document.documentElement.dataset.theme = settings.theme;
    themeBtn.textContent =
        settings.theme === 'matrix' ? 'ﾊ' : settings.theme === 'light' ? '☀' : '☾';
}
let clicks: number[] = [];
themeBtn.addEventListener('click', () => {
    const now = Date.now();
    clicks = [...clicks, now].filter((t) => now - t < 1500);
    if (settings.theme === 'matrix') settings.theme = 'dark';
    else if (clicks.length >= 5) {
        settings.theme = 'matrix';
        clicks = [];
    } else settings.theme = settings.theme === 'light' ? 'dark' : 'light';
    saveSettings();
    applyTheme();
    schedule();
});
applyTheme();

// --- the words. The language is yours, like every other setting:
// it is never posted, and nobody else's canvas changes when it does. Chosen
// before the first paint, because every label on screen comes out of it.
await setLanguage(settings.language);

/**
 * index.html carries keys, not copy: everything visible in it is filled in
 * from the language in force. The `data-t-html` handful may contain a <kbd>
 * and nothing else — they come from the strings file, not from anything a
 * viewer or a repository can write.
 */
function applyWords() {
    const words = S.ui as Record<string, string>;
    for (const el of document.querySelectorAll<HTMLElement>('[data-t]'))
        el.textContent = words[el.dataset.t!] ?? '';
    for (const el of document.querySelectorAll<HTMLElement>('[data-t-html]'))
        el.innerHTML = words[el.dataset.tHtml!] ?? '';
    for (const el of document.querySelectorAll<HTMLElement>('[data-t-title]'))
        el.title = words[el.dataset.tTitle!] ?? '';
    for (const el of document.querySelectorAll<HTMLInputElement>('[data-t-placeholder]'))
        el.placeholder = words[el.dataset.tPlaceholder!] ?? '';
    // What language this page is in, for anything reading it out loud.
    document.documentElement.lang = language;

    // One button per language on offer, the one in force pressed. Rendered here
    // rather than written into index.html so that registering a language is the
    // whole of adding it.
    const box = $('languages');
    box.replaceChildren();
    for (const l of LANGUAGES) {
        const b = document.createElement('button');
        b.textContent = l.label;
        b.title = S.language.switchTo(l.name);
        b.setAttribute('aria-pressed', String(l.code === language));
        b.onclick = () => void chooseLanguage(l.code);
        box.append(b);
    }
}

/** A different language: swap the words, then say everything again. Nothing is
 *  asked of the server — a step carries note *ids*, and the words are already
 *  here. The inspector does re-read the selected object's body, because that is
 *  how `renderInspector` gets one at all; it is one object, on demand, and the same
 *  fetch a click makes. */
async function chooseLanguage(code: string) {
    settings.language = code;
    saveSettings();
    await setLanguage(code);
    applyWords();
    showConnection(source.readyState !== 2);
    updateToolbars();
    renderInspector(
        inspector,
        recording.current,
        scene?.shapes.find((n) => n.id === selected) ?? null,
    );
    showChange(recording.current ? describe(shownFrom, recording.current) : '');
    relayout(false, false);
}

// --- the recording: every step seen, where you stand in it, and the view you ask
// with. It owns all three, so nothing here keeps a second copy to drift.
const recording = new Recording();
// Which commits you have opened and collapsed is an answer you gave, so
// it outlives the page the way the settings do — and a tree you shut is the
// same answer about a different kind of shape.
// ponytail: one key for the origin, so two repositories served on the same
// port share it — harmless, the shas of one are never the shas of the other.
recording.answers = JSON.parse(localStorage.getItem('gitva.answers') ?? '{}');
recording.view = {
    ...recording.view,
    showIndex: settings.showIndex,
    showUnreachable: settings.showUnreachable,
    showLinksFromUnreachable:
        settings.showLinksFromUnreachable ?? recording.view.showLinksFromUnreachable,
    collapsed: JSON.parse(localStorage.getItem('gitva.collapsed') ?? '[]'),
};
const saveAnswers = () => {
    localStorage.setItem('gitva.answers', JSON.stringify(recording.answers));
    localStorage.setItem('gitva.collapsed', JSON.stringify(recording.view.collapsed ?? []));
};
const pins = new Pins();
// Where you dragged something is the same kind of answer as a collapse: yours, and
// no reason for a reload to undo it. Same one key per origin.
pins.restore(JSON.parse(localStorage.getItem('gitva.pins') ?? '[]'));
const savePins = () => localStorage.setItem('gitva.pins', JSON.stringify(pins.all));
// How wide you have dragged each column. A hand-set width, like a pin, so
// it outlives the page — and like the collapses, one key for the origin.
const columnWidths: Record<string, number> = JSON.parse(
    localStorage.getItem('gitva.columns') ?? '{}',
);
const saveColumns = () => localStorage.setItem('gitva.columns', JSON.stringify(columnWidths));

// --- what is on screen
let scene: Scene | null = null;
let leaving: Shape[] = [];
let change: Change = EMPTY_CHANGE;
let flashAt = -1e9;
let enterAt = -1e9;
// A shape you removed yourself is gone the moment you asked; one git removed has
// to be seen going, or the lesson leaves the screen before you read it.
let exitMs = theme.duration;
let camera: Camera = { x: 24, y: 24, scale: 1 };
let hover: string | null = null;
let selected: string | null = localStorage.getItem('gitva.selected');
/** The step the change line was worked out from, so it can be said again in
 *  another language without the recording moving. */
let shownFrom: Step | null = null;
/** The last click, waiting to see whether a second one joins it. */
let lastClick: Click | null = null;

/** Objects marked by right-click, kept by sha until right-clicked again — and
 *  across a reload, because a mark is an answer you gave, like a pin. */
const marked = new Set<string>(JSON.parse(localStorage.getItem('gitva.marks') ?? '[]'));
const saveMarks = () => localStorage.setItem('gitva.marks', JSON.stringify([...marked]));

// ---------------------------------------------------------------------------
// Painting on demand — sitting still costs no CPU at all
// ---------------------------------------------------------------------------

let running = false;
function schedule() {
    if (running) return;
    running = true;
    requestAnimationFrame(paint);
}

function paint() {
    running = false;
    if (!scene) return;
    const now = performance.now();
    const flash = reduceMotion ? 0 : Math.max(0, 1 - (now - flashAt) / 5000);
    const enter = reduceMotion ? 1 : Math.min(1, (now - enterAt) / theme.duration);
    const exit = reduceMotion ? 1 : Math.min(1, (now - enterAt) / exitMs);
    if (glide) {
        const step = glideStep(camera, glide, reduceMotion ? 1 : 0.22);
        camera = step.camera;
        if (step.done) glide = null;
    }
    const settling = draw(ctx, scene, {
        camera,
        width: canvas.clientWidth,
        height: canvas.clientHeight,
        dpr: devicePixelRatio,
        change,
        flash,
        hover,
        selected,
        marked,
        showPins: settings.showPins,
        showNames: settings.showNames,
        enter,
        leaving,
        exit,
        motion: !reduceMotion,
        resizing: hoverEdge,
    });
    if (flash > 0 || enter < 1 || exit < 1 || settling || glide) schedule();
}

/** Where wheel panning is heading. Every other camera move is direct, and
 *  cancels it. */
let glide: { x: number; y: number } | null = null;

function relayout(animate: boolean, repoChanged: boolean) {
    // Every tree the recording has ever read, not only the ones this step came with:
    // a commit opened now has to draw open on a step recorded before it was.
    const step = recording.shown;
    if (!step) return;
    const next = layout(step, recording.view, pins.at(step.seq), columnWidths);
    // Losing your last link is the lesson — being teleported to the bottom of the
    // page is not. An object whose relations changed used to be pinned where it
    // already was, which froze it there for good: everything else went on
    // reflowing underneath, and the pile-up was the pins, not the layout. It
    // travels instead — see `snapPositions`. Dragging is the one move that must
    // not lag the cursor, so it snaps.
    if (!animate) snapPositions();
    const fresh = diffScenes(scene, next);
    const same = scene !== null && !isVisible(fresh);
    const going = scene ? scene.shapes.filter((n) => fresh.removed.has(n.id)) : [];
    scene = next;
    // A step that draws the same shapes leaves the flash and any fade alone.
    if (same) return schedule();
    change = fresh;
    leaving = going;
    if (animate) {
        enterAt = performance.now();
        exitMs = repoChanged ? 2500 : theme.duration;
        // The one reserved accent, spent on nothing but "this just changed".
        if (repoChanged) flashAt = performance.now();
    } else {
        enterAt = -1e9;
    }
    schedule();
}

// ---------------------------------------------------------------------------
// The recording
// ---------------------------------------------------------------------------

/** The recording moved: draw where it stands now, having come from `prev`. */
function showStep(prev: Step | null) {
    shownFrom = prev;
    const changed = describe(prev, recording.current!);
    showChange(prev ? changed : S.change.first);
    relayout(true, prev !== null && changed !== S.change.none);
    redressed();
}

/** Same step, drawn again — an expand, a toggle, a widened column. */
function redressed() {
    updateToolbars();
    if (selected) {
        renderInspector(
            inspector,
            recording.current,
            scene?.shapes.find((n) => n.id === selected) ?? null,
        );
    }
}

// ---------------------------------------------------------------------------
// Listening to the server
// ---------------------------------------------------------------------------

/** The view changed: write down the part of it that outlives the page, and
 *  draw again. Nothing is sent anywhere — the step on screen already holds
 *  everything the new view needs, which is what keeps the view yours. */
function viewChanged() {
    settings.showIndex = recording.view.showIndex;
    settings.showUnreachable = recording.view.showUnreachable !== false;
    settings.showLinksFromUnreachable = recording.view.showLinksFromUnreachable === true;
    saveSettings();
    saveAnswers();
    relayout(true, false);
    updateToolbars();
}

const source = new EventSource('/events');

/** Everything the viewers walked through before this browser arrived. It is
 *  recorded, not performed: a page opened an hour in would otherwise strobe
 *  through the whole session, painting and posting a view per step on the
 *  way. One step is painted at the end — the newest — exactly as the very
 *  first step is. */
source.addEventListener('steps', (e) => {
    showConnection(true);
    const steps: Step[] = JSON.parse((e as MessageEvent).data);
    for (const s of steps) recording.arrive(s, settings, true);
    showStep(null);
    if (scene) {
        camera = fit(scene, canvas.clientWidth);
        glide = null;
        schedule();
    }
});

source.addEventListener('step', (e) => {
    showConnection(true);
    const s: Step = JSON.parse((e as MessageEvent).data);
    const a = recording.arrive(s, settings);
    if (a.kind === 'shown') {
        showStep(a.prev);
        // The first step frames the object graph; after that only if asked to, because
        // history arriving is what makes the object graph outgrow the canvas.
        if (scene && (a.first || settings.refitOnChange)) {
            camera = a.first ? fit(scene, canvas.clientWidth) : refit(scene, viewport(), camera);
            glide = null;
            schedule();
        }
    } else updateToolbars();
});
/** Which recording this is, and whether the presenter asked for every commit
 *  expanded — both facts about the run, told once per connection. A click hands
 *  the identifier over, so a repository about to move can be picked up again
 *  with `gitva --id <it>`. */
source.addEventListener('recording', (e) => {
    const { id, learning } = JSON.parse((e as MessageEvent).data) as {
        id: string;
        learning: boolean;
    };
    recording.presenting(learning, settings.showLinksFromUnreachable);
    const el = $('recording-id');
    el.textContent = id;
    el.onclick = () => copied(id, id);
});

source.addEventListener('trouble', (e) => {
    showChange(JSON.parse((e as MessageEvent).data).message);
});
source.onerror = () => showConnection(false);
source.onopen = () => showConnection(true);

function showConnection(ok: boolean) {
    const dot = $('live-dot');
    dot.className = 'dot' + (ok ? (recording.following ? '' : ' paused') : ' off');
    $('live-text').textContent = ok
        ? recording.following
            ? S.status.live
            : S.status.paused
        : S.status.lost;
}

// ---------------------------------------------------------------------------
// The toolbars
// ---------------------------------------------------------------------------

function updateToolbars() {
    const step = recording.current;
    if (!step) return;
    $('repo-name').textContent = step.repo;
    // The path is a tooltip now: the view toolbar's machine text is the identifier the
    // recording is filed under, which is the thing worth copying.
    $('repo-name').title = step.gitDir;
    $('tally').textContent = recording.tally(scene?.shapes.length ?? 0);

    const list = $('notes-list');
    list.replaceChildren();
    for (const n of recording.notes()) {
        const li = document.createElement('li');
        li.textContent = n;
        list.append(li);
    }

    const n = recording.steps.length;
    const scrub = $<HTMLInputElement>('scrub');
    scrub.max = String(Math.max(0, n - 1));
    scrub.value = String(Math.max(0, recording.cursor));
    $('recording-pos').textContent = n ? `${recording.cursor + 1}/${n}` : '';
    $('play').textContent = recording.following ? S.status.pause : S.status.goLive;
    $('play').setAttribute('aria-pressed', String(!recording.following));
    $('toggle-index').setAttribute('aria-pressed', String(recording.view.showIndex));
    const unreachableShown = recording.view.showUnreachable !== false;
    $('toggle-unreachable').setAttribute('aria-pressed', String(unreachableShown));
    $('toggle-links-from-unreachable').setAttribute(
        'aria-pressed',
        String(recording.view.showLinksFromUnreachable === true),
    );
    // Links from unreachable are drawn from the unreachable set, so with that set
    // hidden there is nothing for them to leave from.
    $<HTMLButtonElement>('toggle-links-from-unreachable').disabled = !unreachableShown;
    showConnection(source.readyState !== 2);
}

function showChange(text: string) {
    $('change').textContent = text;
}

$('toggle-index').addEventListener('click', () => {
    recording.view = { ...recording.view, showIndex: !recording.view.showIndex };
    viewChanged();
});
$('toggle-unreachable').addEventListener('click', () => {
    recording.view = {
        ...recording.view,
        showUnreachable: recording.view.showUnreachable === false,
    };
    viewChanged();
});
$('toggle-links-from-unreachable').addEventListener('click', () => {
    recording.view = {
        ...recording.view,
        showLinksFromUnreachable: !recording.view.showLinksFromUnreachable,
    };
    viewChanged();
});
// The names on a tree's links are painting, not a question for the server: it
// is a setting, so turning them off is nobody else's business.
const namesBtn = $('toggle-names');
const showNames = () => {
    namesBtn.setAttribute('aria-pressed', String(settings.showNames));
    schedule();
};
showNames();
namesBtn.addEventListener('click', () => {
    settings.showNames = !settings.showNames;
    saveSettings();
    showNames();
});
$('expand-all').addEventListener('click', () => {
    recording.expandAll();
    viewChanged();
});
$('collapse-all').addEventListener('click', () => {
    recording.collapseAll();
    viewChanged();
});
// Dropping every pin, at every moment of the recording: a pin is a thing you put
// there by hand, so taking them all back is one gesture, not a page reload.
// A widened column is the same kind of thing, and goes back with them.
$('unpin').addEventListener('click', () => {
    pins.clear();
    savePins();
    for (const k of Object.keys(columnWidths)) delete columnWidths[k];
    saveColumns();
    relayout(true, false);
});
$('help-btn').addEventListener('click', () => $<HTMLDialogElement>('help').showModal());
$('settings-btn').addEventListener('click', () => $<HTMLDialogElement>('settings').showModal());
const centreBox = $<HTMLInputElement>('centre-on-click');
centreBox.checked = settings.centreOnClick;
centreBox.addEventListener('change', () => {
    settings.centreOnClick = centreBox.checked;
    saveSettings();
});
const expandNew = $<HTMLInputElement>('expand-new-commits');
expandNew.checked = settings.expandNewCommits;
expandNew.addEventListener('change', () => {
    settings.expandNewCommits = expandNew.checked;
    saveSettings();
});
const pinBox = $<HTMLInputElement>('show-pins');
pinBox.checked = settings.showPins;
pinBox.addEventListener('change', () => {
    settings.showPins = pinBox.checked;
    saveSettings();
    schedule();
});
const refitBox = $<HTMLInputElement>('refit-on-change');
refitBox.checked = settings.refitOnChange;
refitBox.addEventListener('change', () => {
    settings.refitOnChange = refitBox.checked;
    saveSettings();
});
$('play').addEventListener('click', () => {
    if (recording.following) {
        recording.following = false;
        updateToolbars();
    } else moved(recording.goLive());
});
$('step-back').addEventListener('click', () => moved(recording.step(-1)));
$('step-fwd').addEventListener('click', () => moved(recording.step(1)));
$('scrub').addEventListener('input', () => {
    moved(recording.scrubTo(Number($<HTMLInputElement>('scrub').value)));
});

const moved = (j: { prev: Step | null } | null) => (j ? showStep(j.prev) : updateToolbars());

addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'f' && scene) {
        camera = fit(scene, canvas.clientWidth);
        glide = null;
        schedule();
    } else if (e.key === '[' || e.key === 'ArrowLeft') moved(recording.step(-1));
    else if (e.key === ']' || e.key === 'ArrowRight') moved(recording.step(1));
    else if (e.key === ' ') {
        e.preventDefault();
        $('play').click();
    } else if (e.key === 'i') $('toggle-index').click();
});

// ---------------------------------------------------------------------------
// The camera and the mouse
// ---------------------------------------------------------------------------

const canvasAt = (ev: { clientX: number; clientY: number }) =>
    toCanvas(camera, ev, canvas.getBoundingClientRect());

let drag: {
    id: string | null;
    x: number;
    y: number;
    moved: boolean;
    dx: number;
    dy: number;
} | null = null;
/** The column edge under the pointer, or the one being dragged. */
let hoverEdge: string | null = null;
let resize: { key: string; column: { x: number; w: number } } | null = null;

canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    glide = null;
    canvas.setPointerCapture(e.pointerId);
    canvas.classList.add('dragging');
    const w = canvasAt(e);
    const hit = scene ? hitTest(scene, w.x, w.y) : null;
    // A shape under the pointer wins the edge: the edge is empty space by nature.
    const key = hit || !scene ? null : columnEdgeAt(scene, w.x);
    const column = scene?.columns.find((b) => b.key === key);
    resize = key && column ? { key, column: { x: column.x, w: column.w } } : null;
    drag = hit
        ? { id: hit.id, x: e.clientX, y: e.clientY, moved: false, dx: w.x - hit.x, dy: w.y - hit.y }
        : { id: null, x: e.clientX, y: e.clientY, moved: false, dx: 0, dy: 0 };
});

canvas.addEventListener('pointermove', (e) => {
    if (!drag) {
        const w = canvasAt(e);
        const hit = scene ? hitTest(scene, w.x, w.y) : null;
        const id = hit?.id ?? null;
        const over = hit || !scene ? null : columnEdgeAt(scene, w.x);
        if (id !== hover || over !== hoverEdge) {
            hover = id;
            hoverEdge = over;
            canvas.style.cursor = id ? 'pointer' : over ? 'col-resize' : 'grab';
            schedule();
        }
        return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (resize) {
        // The edge sits half a gap past the column's right edge, and the width is
        // clamped back to the content's own in `layout`, so dragging left stops
        // where the column is full rather than at some number invented here.
        columnWidths[resize.key] = canvasAt(e).x - M.columnGap / 2 - resize.column.x;
        drag.moved = true;
        relayout(false, false);
    } else if (drag.id && drag.moved) {
        const w = canvasAt(e);
        pins.put(recording.current?.seq ?? 0, drag.id, w.x - drag.dx, w.y - drag.dy);
        relayout(false, false);
    } else if (!drag.id && scene) {
        camera = {
            ...camera,
            ...bounded({ x: camera.x + dx, y: camera.y + dy }, camera.scale, scene, viewport()),
        };
        drag.x = e.clientX;
        drag.y = e.clientY;
        schedule();
    }
});

canvas.addEventListener('pointerup', (e) => {
    canvas.classList.remove('dragging');
    if (resize) {
        resize = null;
        saveColumns();
        drag = null;
        return;
    }
    const click: Click | null =
        drag && !drag.moved ? { at: e.timeStamp, x: e.clientX, y: e.clientY, id: drag.id } : null;
    // Written out at the end of the gesture, not per pointermove: one drag is a
    // hundred of those, and the same reason `saveColumns` sits where it does.
    if (drag?.moved && drag.id) savePins();
    drag = null;
    if (!click) return;

    // The pair acts on what the *first* click hit, because that click may have
    // centred it and moved it out from under the pointer.
    const double = isDouble(lastClick, click);
    const id = double ? lastClick!.id : click.id;
    lastClick = double ? null : click;
    const shape = id ? (scene?.shapes.find((n) => n.id === id) ?? null) : null;

    if (double) {
        // Double-click opens the thing you double-clicked, the way it opens a
        // folder everywhere else — and empty space pulls the whole object graph back.
        if (shape?.kind === 'commit') recording.toggle(shape.id);
        else if (shape?.kind === 'tree') recording.toggleTree(shape.id);
        else if (!shape && scene) {
            camera = zoomOut(scene, viewport(), canvasAt(e).y);
            glide = null;
            schedule();
            return;
        } else return;
        viewChanged();
        return;
    }
    // Shift is the undo of dragging: the pin comes out and the layout takes the
    // shape back. Nothing is selected or copied on the way — it is one act.
    if (e.shiftKey && id) {
        if (pins.drop(id)) {
            savePins();
            relayout(true, false);
        }
        return;
    }
    selected = id;
    if (id) localStorage.setItem('gitva.selected', id);
    else localStorage.removeItem('gitva.selected');
    renderInspector(inspector, recording.current, shape);
    // Anything with a sha is a key in the key-value store, so a click hands you
    // the key: the whole point is that you can paste it into the next command.
    if (shape?.oid) copied(shape.oid);
    if (shape && settings.centreOnClick) {
        glide = null;
        camera = centre(camera, shape, viewport());
    }
    schedule();
});

canvas.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const w = canvasAt(e);
    const hit = scene ? hitTest(scene, w.x, w.y) : null;
    if (!hit) return;
    // A shape moves around as the object graph is expanded and collapsed, and a
    // mark is how you follow it. One gesture for every kind: a mark says "keep an
    // eye on this", and that is the same wish whether the thing is a commit, a
    // blob, a branch or a staged path.
    if (!marked.delete(hit.id)) marked.add(hit.id);
    saveMarks();
    schedule();
});

canvas.addEventListener(
    'wheel',
    (e) => {
        e.preventDefault();
        if (!scene) return;
        if (e.ctrlKey || e.metaKey) {
            glide = null;
            camera = zoom(camera, canvasAt(e), e.deltaY, scene, viewport());
        } else {
            const at = glide ?? camera;
            glide = bounded(
                { x: at.x - e.deltaX, y: at.y - e.deltaY },
                camera.scale,
                scene,
                viewport(),
            );
        }
        schedule();
    },
    { passive: false },
);

// ---------------------------------------------------------------------------
// The inspector
// ---------------------------------------------------------------------------

/** How wide the teaching is, is yours. The canvas follows on its own — its
 *  ResizeObserver is what redraws it. */
const inspectorEdgeEl = $('inspector-edge');
const setInspectorWidth = (w: number) => {
    settings.inspectorWidth = Math.max(240, Math.min(w, innerWidth - 240));
    inspector.style.width = `${settings.inspectorWidth}px`;
};
setInspectorWidth(settings.inspectorWidth);
inspectorEdgeEl.addEventListener('pointerdown', (e) => {
    inspectorEdgeEl.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => setInspectorWidth(innerWidth - m.clientX);
    inspectorEdgeEl.addEventListener('pointermove', move);
    // Written out at the end of the gesture, like the columns and the pins.
    inspectorEdgeEl.addEventListener(
        'pointerup',
        () => {
            inspectorEdgeEl.removeEventListener('pointermove', move);
            saveSettings();
        },
        { once: true },
    );
});

/** A click on the sha hands you the key, exactly as a click on a shape does —
 *  and a field carrying more than it shows, like the path inside .git, hands
 *  over the whole of it. */
inspector.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    if (!el.classList.contains('sha')) return;
    const text = el.textContent ?? '';
    const whole = el.dataset.copy;
    copied(whole ?? text, whole ? text : text.slice(0, 7));
});

// ---------------------------------------------------------------------------

new ResizeObserver(() => {
    canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
    canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
    rain.width = Math.round(canvas.clientWidth * devicePixelRatio);
    rain.height = Math.round(canvas.clientHeight * devicePixelRatio);
    schedule();
}).observe(canvas);

applyWords();
$('live-text').textContent = S.status.connecting;
renderInspector(inspector, null, null);
