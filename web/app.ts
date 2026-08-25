/**
 * The page: the toolbars, the inspector, the stream of steps — everything
 * around the canvas.
 *
 * It only ever reads. Every way the user can change what is on screen is a
 * change to the view, which lives here and goes nowhere: the server is told
 * nothing, asked nothing, and one browser cannot alter another's canvas.
 * Everything the browser is shown is kept, so a demo can be replayed instead of
 * redone — and once the recording has arrived, a lost connection costs nothing
 * but the next step.
 *
 * The canvas itself is `canvas.ts`, mounted here and published as
 * `gitva/canvas`: the object graph, the camera and every gesture on it, so a
 * page that is not this one can draw the same steps. What is left here is the
 * page around it. Every decision the gestures make is in `recording.ts` and
 * `camera.ts`, where it is tested.
 */

import { describe } from './diff.js';
import { language, LANGUAGES, S, setLanguage } from './localization/index.js';
import type { Step } from '../src/types.js';
import { mount, type CanvasSettings } from './canvas.js';
import { renderInspector } from './inspector.js';
import { type Mode, setTheme, theme } from './theme.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inspector = $('inspector');

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

/** What was kept in `localStorage`, or the empty JSON to stand in for it. The
 *  browser is the only writer of these keys, so the shape is known. */
const kept = <T>(key: string, empty: string): T =>
    JSON.parse(localStorage.getItem(key) ?? empty) as T;

// --- settings: about how you like to work, not about this session. The ones
// about the canvas are the canvas's own (`CanvasSettings`), kept in the same
// place: they are one answer to "how do you like to work", not two.
interface Settings {
    language: string;
    showIndex: boolean;
    showUnreachable: boolean;
    /** `null` until you have said: `--learning` puts the links from unreachable
     *  up before anyone asks, and must not keep overruling an answer you gave. */
    showLinksFromUnreachable: boolean | null;
    theme: Mode;
    inspectorWidth: number;
}
const keptSettings = kept<Partial<Settings & CanvasSettings>>('gitva.settings', '{}');
const DEFAULTS: Settings = {
    language: 'en',
    showIndex: true,
    showUnreachable: true,
    showLinksFromUnreachable: null,
    theme: 'dark',
    inspectorWidth: 430,
};
// This file's own keys off what was kept, and no others: the rest of that object
// is the canvas's, and each half is only ever written back from the one that
// owns it. Both halves taking the whole is how a setting toggled after a reload
// used to be overwritten by the copy the page loaded with.
const settings: Settings = {
    ...DEFAULTS,
    ...(Object.fromEntries(
        Object.entries(keptSettings).filter(([key]) => key in DEFAULTS),
    ) as Partial<Settings>),
};
const saveSettings = () =>
    localStorage.setItem('gitva.settings', JSON.stringify({ ...canvas.settings, ...settings }));

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
    canvas.schedule();
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
    renderInspector(inspector, recording.current, canvas.shape(canvas.selected));
    showChange(recording.current ? describe(shownFrom, recording.current) : '');
    canvas.redraw(false);
}

// --- the canvas: the object graph, the camera, and every gesture on it. It
// owns the recording, the pins, the marks and the widths; nothing here keeps a
// second copy to drift, and everything below is the page around it.
const canvas = mount($<HTMLCanvasElement>('canvas'), {
    settings: keptSettings,
    view: {
        showIndex: settings.showIndex,
        showUnreachable: settings.showUnreachable,
        ...(settings.showLinksFromUnreachable !== null
            ? { showLinksFromUnreachable: settings.showLinksFromUnreachable }
            : {}),
        // `collapsed` is this browser's and nobody else's — a tree it shut before
        // a reload is still shut, the same way a commit it collapsed is.
        collapsed: kept('gitva.collapsed', '[]'),
    },
    onSelect: (shape) => {
        if (shape) localStorage.setItem('gitva.selected', shape.id);
        else localStorage.removeItem('gitva.selected');
        renderInspector(inspector, recording.current, shape);
        // Anything with a sha is a key in the key-value store, so a click hands
        // you the key: the whole point is that you can paste it into the next
        // command.
        if (shape?.oid) copied(shape.oid);
    },
    onChange: (what) => {
        if (what === 'view') persistView();
        else if (what === 'pins') savePins();
        else if (what === 'marks') saveMarks();
        else saveColumns();
    },
});
const recording = canvas.recording;
// Which commits you have opened and collapsed is an answer you gave, so
// it outlives the page the way the settings do — and a tree you shut is the
// same answer about a different kind of shape.
// ponytail: one key for the origin, so two repositories served on the same
// port share it — harmless, the shas of one are never the shas of the other.
recording.answers = kept('gitva.answers', '{}');
const saveAnswers = () => {
    localStorage.setItem('gitva.answers', JSON.stringify(recording.answers));
    localStorage.setItem('gitva.collapsed', JSON.stringify(recording.view.collapsed ?? []));
};
// Where you dragged something is the same kind of answer as a collapse: yours, and
// no reason for a reload to undo it. Same one key per origin.
canvas.pins.restore(kept('gitva.pins', '[]'));
const savePins = () => localStorage.setItem('gitva.pins', JSON.stringify(canvas.pins.all));
// How wide you have dragged each column. A hand-set width, like a pin, so
// it outlives the page — and like the collapses, one key for the origin.
Object.assign(canvas.columnWidths, kept<Record<string, number>>('gitva.columns', '{}'));
const saveColumns = () =>
    localStorage.setItem('gitva.columns', JSON.stringify(canvas.columnWidths));
// A mark is an answer you gave, like a pin, so it comes back across a reload.
for (const id of kept<string[]>('gitva.marks', '[]')) canvas.marked.add(id);
const saveMarks = () => localStorage.setItem('gitva.marks', JSON.stringify([...canvas.marked]));
canvas.selected = localStorage.getItem('gitva.selected');

/** The step the change line was worked out from, so it can be said again in
 *  another language without the recording moving. */
let shownFrom: Step | null = null;

// ---------------------------------------------------------------------------
// The recording
// ---------------------------------------------------------------------------

/** The recording moved: say where it stands now, having come from `prev`.
 *  `drawn` is a step the canvas has already painted — `show` does that itself,
 *  because a step arriving is the one move the canvas makes on its own. */
function showStep(prev: Step | null, drawn = false) {
    shownFrom = prev;
    const changed = describe(prev, recording.current!);
    showChange(prev ? changed : S.change.first);
    if (!drawn) canvas.redraw(true, prev !== null && changed !== S.change.none);
    redressed();
}

/** Same step, drawn again — an expand, a toggle, a widened column. */
function redressed() {
    updateToolbars();
    if (canvas.selected)
        renderInspector(inspector, recording.current, canvas.shape(canvas.selected));
}

// ---------------------------------------------------------------------------
// Listening to the server
// ---------------------------------------------------------------------------

/** The view changed: write down the part of it that outlives the page, and say
 *  it again. Nothing is sent anywhere — the step on screen already holds
 *  everything the new view needs, which is what keeps the view yours. */
function persistView() {
    settings.showIndex = recording.view.showIndex;
    settings.showUnreachable = recording.view.showUnreachable !== false;
    settings.showLinksFromUnreachable = recording.view.showLinksFromUnreachable === true;
    saveSettings();
    saveAnswers();
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
    const steps = JSON.parse(e.data as string) as Step[];
    for (const s of steps) canvas.show(s, true);
    showStep(null);
    canvas.fitCamera();
});

source.addEventListener('step', (e) => {
    showConnection(true);
    const s = JSON.parse(e.data as string) as Step;
    const a = canvas.show(s);
    if (a.kind === 'shown') showStep(a.prev, true);
    else updateToolbars();
});
/** Which recording this is, and whether the presenter asked for every commit
 *  expanded — both facts about the run, told once per connection. A click hands
 *  the identifier over, so a repository about to move can be picked up again
 *  with `gitva --id <it>`. */
source.addEventListener('recording', (e) => {
    const { id, learning } = JSON.parse(e.data as string) as {
        id: string;
        learning: boolean;
    };
    recording.presenting(learning, settings.showLinksFromUnreachable);
    const el = $('recording-id');
    el.textContent = id;
    el.onclick = () => copied(id, id);
});

source.addEventListener('trouble', (e) => {
    showChange((JSON.parse(e.data as string) as { message: string }).message);
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
    $('tally').textContent = recording.tally(canvas.drawn?.shapes.length ?? 0);

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
    canvas.setView({ showIndex: !recording.view.showIndex });
});
$('toggle-unreachable').addEventListener('click', () => {
    canvas.setView({ showUnreachable: recording.view.showUnreachable === false });
});
$('toggle-links-from-unreachable').addEventListener('click', () => {
    canvas.setView({ showLinksFromUnreachable: !recording.view.showLinksFromUnreachable });
});
// The names on a tree's links are painting, not a question for the server: it
// is a setting, so turning them off is nobody else's business.
const namesBtn = $('toggle-names');
const showNames = () => {
    namesBtn.setAttribute('aria-pressed', String(canvas.settings.showNames));
    canvas.schedule();
};
showNames();
namesBtn.addEventListener('click', () => {
    canvas.settings.showNames = !canvas.settings.showNames;
    saveSettings();
    showNames();
});
$('expand-all').addEventListener('click', () => canvas.expandAll());
$('collapse-all').addEventListener('click', () => canvas.collapseAll());
// Dropping every pin, at every moment of the recording: a pin is a thing you put
// there by hand, so taking them all back is one gesture, not a page reload.
// A widened column is the same kind of thing, and goes back with them.
$('unpin').addEventListener('click', () => canvas.resetView());
$('help-btn').addEventListener('click', () => $<HTMLDialogElement>('help').showModal());
$('settings-btn').addEventListener('click', () => $<HTMLDialogElement>('settings').showModal());
const centreBox = $<HTMLInputElement>('centre-on-click');
centreBox.checked = canvas.settings.centreOnClick;
centreBox.addEventListener('change', () => {
    canvas.settings.centreOnClick = centreBox.checked;
    saveSettings();
});
const expandNew = $<HTMLInputElement>('expand-new-commits');
expandNew.checked = canvas.settings.expandNewCommits;
expandNew.addEventListener('change', () => {
    canvas.settings.expandNewCommits = expandNew.checked;
    saveSettings();
});
const pinBox = $<HTMLInputElement>('show-pins');
pinBox.checked = canvas.settings.showPins;
pinBox.addEventListener('change', () => {
    canvas.settings.showPins = pinBox.checked;
    saveSettings();
    canvas.schedule();
});
const refitBox = $<HTMLInputElement>('refit-on-change');
refitBox.checked = canvas.settings.refitOnChange;
refitBox.addEventListener('change', () => {
    canvas.settings.refitOnChange = refitBox.checked;
    saveSettings();
});
$('play').addEventListener('click', () => {
    if (recording.following) {
        recording.following = false;
        updateToolbars();
    } else moved(canvas.live());
});
$('step-back').addEventListener('click', () => moved(canvas.step(-1)));
$('step-fwd').addEventListener('click', () => moved(canvas.step(1)));
$('scrub').addEventListener('input', () => {
    moved(canvas.scrubTo(Number($<HTMLInputElement>('scrub').value)));
});

/** The canvas has drawn wherever it landed; what is left is saying so. */
const moved = (j: { prev: Step | null } | null) => (j ? showStep(j.prev, true) : updateToolbars());

addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (e.key === 'f') canvas.fitCamera();
    else if (e.key === '[' || e.key === 'ArrowLeft') moved(canvas.step(-1));
    else if (e.key === ']' || e.key === 'ArrowRight') moved(canvas.step(1));
    else if (e.key === ' ') {
        e.preventDefault();
        $('play').click();
    } else if (e.key === 'i') $('toggle-index').click();
});

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

// The canvas sizes itself; the rain is a second canvas over it, so it follows.
new ResizeObserver(() => {
    rain.width = Math.round(canvas.element.clientWidth * devicePixelRatio);
    rain.height = Math.round(canvas.element.clientHeight * devicePixelRatio);
}).observe(canvas.element);

applyWords();
$('live-text').textContent = S.status.connecting;
renderInspector(inspector, null, null);
