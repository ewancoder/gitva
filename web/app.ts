/**
 * The client: one view, one tape, one camera.
 *
 * Every way the user can change what is on screen is a change to the view —
 * branch filtering, search, paging and drill-down are one mechanism, not four
 * features. Everything the browser is shown is kept, so a demo can be replayed
 * instead of redone.
 *
 * What is left here is DOM: elements, events and painting. Every decision the
 * gestures make is in `tape.ts` and `camera.ts`, where it is tested.
 */

import { diffScenes, describe, EMPTY_CHANGE, type Change } from '../src/diff.js';
import { layout, type Scene, type SceneNode } from '../src/layout.js';
import { type Snapshot, type View } from '../src/types.js';
import { bounded, centre, fit, glideStep, refit, toWorld, zoom, zoomOut, type Camera } from './camera.js';
import { renderPanel } from './panel.js';
import { draw, hitTest, snapPositions } from './render.js';
import { canMark, isDouble, Pins, questionFor, Tape, type Click } from './tape.js';
import { theme } from './theme.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('graph');
const ctx = canvas.getContext('2d')!;
const panel = $('panel');
const port = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });

/** Copy a sha and say so briefly; a clipboard the browser refuses is not worth a dialog. */
let copiedTimer = 0;
function copied(oid: string) {
  void navigator.clipboard?.writeText(oid).then(
    () => {
      const el = $('copied');
      el.textContent = `copied ${oid.slice(0, 7)}`;
      el.classList.add('show');
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => el.classList.remove('show'), 1200) as unknown as number;
    },
    () => {},
  );
}

// --- preferences: about how this person likes to work, not about this session
interface Prefs {
  showIndex: boolean;
  centreOnClick: boolean;
  openNewCommits: boolean;
  refitOnChange: boolean;
}
const prefs: Prefs = {
  showIndex: true,
  centreOnClick: false,
  openNewCommits: true,
  refitOnChange: true,
  ...JSON.parse(localStorage.getItem('gitva.prefs') ?? '{}'),
};
const savePrefs = () => localStorage.setItem('gitva.prefs', JSON.stringify(prefs));

// --- the tape: every state seen, where we stand in it, and the view we ask
// with. It owns all three, so nothing here keeps a second copy to drift.
const tape = new Tape();
tape.view = { ...tape.view, showIndex: prefs.showIndex };
const pins = new Pins();

// --- what is on screen
let scene: Scene | null = null;
let ghosts: SceneNode[] = [];
let change: Change = EMPTY_CHANGE;
let flashAt = -1e9;
let enterAt = -1e9;
let camera: Camera = { x: 24, y: 24, scale: 1 };
let hover: string | null = null;
let selected: string | null = null;
/** The last click, waiting to see whether a second one joins it. */
let lastClick: Click | null = null;

/** Objects marked by right-click, kept by sha until right-clicked again. */
const marked = new Set<string>();

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
  const flash = reduceMotion ? 0 : Math.max(0, 1 - (now - flashAt) / 1100);
  const enter = reduceMotion ? 1 : Math.min(1, (now - enterAt) / theme.duration);
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
    enter,
    ghosts,
    motion: !reduceMotion,
  });
  if (flash > 0 || enter < 1 || settling || glide) schedule();
}

/** Where wheel panning is heading. Every other camera move is direct, and
 *  cancels it. */
let glide: { x: number; y: number } | null = null;

function relayout(animate: boolean, repoChanged: boolean) {
  // Every tree the tape has ever read, not only the ones this state came with:
  // a commit opened now has to draw open on a state recorded before it was.
  const state = tape.world;
  if (!state) return;
  const next = layout(state, tape.view, pins.at(state.seq));
  // Losing your last arrow is the lesson — being teleported to the bottom of the
  // page is not. An object whose relations changed used to be pinned where it
  // already was, which froze it there for good: everything else went on
  // reflowing underneath, and the pile-up was the pins, not the layout. It
  // travels instead — see `snapPositions`. Dragging is the one move that must
  // not lag the cursor, so it snaps.
  if (!animate) snapPositions();
  change = diffScenes(scene, next);
  ghosts = scene ? scene.nodes.filter((n) => change.removed.has(n.id)) : [];
  scene = next;
  if (animate) {
    enterAt = performance.now();
    // The one reserved accent, spent on nothing but "this just changed".
    if (repoChanged) flashAt = performance.now();
  } else {
    enterAt = -1e9;
  }
  schedule();
}

// ---------------------------------------------------------------------------
// The tape
// ---------------------------------------------------------------------------

/** The tape moved: draw where it stands now, having come from `prev`. */
function shown(prev: Snapshot | null) {
  const changed = describe(prev, tape.current!);
  renderHeaderChange(prev ? changed : 'first read');
  relayout(true, prev !== null && changed !== 'no visible change');
  redressed();
}

/** Same state, drawn again — a fold, a filter, a wider window. */
function redressed() {
  updateHeader();
  if (selected) {
    renderPanel(panel, tape.current, scene?.nodes.find((n) => n.id === selected) ?? null);
  }
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

let postTimer: number | undefined;
function postView(v: View) {
  clearTimeout(postTimer);
  postTimer = setTimeout(() => {
    void fetch('/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(v),
    });
  }, 60) as unknown as number;
}

function pushView() {
  prefs.showIndex = tape.view.showIndex;
  savePrefs();
  relayout(true, false);
  updateHeader();
  postView(tape.view);
}

const source = new EventSource('/events');

/** Everything the room walked through before this browser arrived. It is
 *  recorded, not performed: a page opened an hour in would otherwise strobe
 *  through the whole session, painting and posting a view per state on the
 *  way. One state is painted at the end — the newest — exactly as the very
 *  first state is. */
source.addEventListener('history', (e) => {
  live(true);
  const states: Snapshot[] = JSON.parse((e as MessageEvent).data);
  for (const s of states) tape.arrive(s, prefs, true);
  fillBranches(states[states.length - 1]);
  shown(null);
  if (scene) {
    camera = fit(scene, canvas.clientWidth);
    glide = null;
    schedule();
  }
});

source.addEventListener('snapshot', (e) => {
  live(true);
  const s: Snapshot = JSON.parse((e as MessageEvent).data);
  fillBranches(s);
  const a = tape.arrive(s, prefs);
  if (a.post) postView(a.post);
  if (a.kind === 'shown') {
    shown(a.prev);
    // The first state frames the graph; after that only if asked to, because
    // history arriving is what makes the graph outgrow the window.
    if (scene && (a.first || prefs.refitOnChange)) {
      camera = a.first ? fit(scene, canvas.clientWidth) : refit(scene, port(), camera);
      glide = null;
      schedule();
    }
  } else if (a.kind === 'inplace') {
    relayout(true, false);
    redressed();
  } else updateHeader();
});
source.addEventListener('trouble', (e) => {
  renderHeaderChange(JSON.parse((e as MessageEvent).data).message);
});
source.onerror = () => live(false);
source.onopen = () => live(true);

function live(ok: boolean) {
  const dot = $('live-dot');
  dot.className = 'dot' + (ok ? (tape.following ? '' : ' paused') : ' off');
  $('live-text').textContent = ok ? (tape.following ? 'live' : 'paused') : 'connection lost';
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function updateHeader() {
  const snap = tape.current;
  if (!snap) return;
  $('repo-name').textContent = snap.repo;
  $('repo-dir').textContent = snap.gitDir;
  $('tally').textContent = tape.tally(scene?.nodes.length ?? 0);

  const list = $('notes-list');
  list.replaceChildren();
  for (const n of tape.notes()) {
    const li = document.createElement('li');
    li.textContent = n;
    list.append(li);
  }

  const n = tape.states.length;
  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(Math.max(0, n - 1));
  scrub.value = String(Math.max(0, tape.cursor));
  $('tape-pos').textContent = n ? `${tape.cursor + 1}/${n}` : '';
  $('play').textContent = tape.following ? 'pause' : 'go live';
  $('play').setAttribute('aria-pressed', String(!tape.following));
  $('toggle-index').setAttribute('aria-pressed', String(tape.view.showIndex));
  $('toggle-orphans').setAttribute('aria-pressed', String(tape.view.showUnreachable !== false));
  $('toggle-cross').setAttribute('aria-pressed', String(tape.view.showCrossLinks === true));
  $<HTMLButtonElement>('load-all').disabled = !tape.canLoadMore;
  live(source.readyState !== 2);
}

function renderHeaderChange(text: string) {
  $('change').textContent = text;
}

let branchNames = '';
function fillBranches(s: Snapshot) {
  const names = s.refs.map((r) => r.name).join(' ');
  if (names === branchNames) return;
  branchNames = names;
  const sel = $<HTMLSelectElement>('branches');
  const chosen = new Set([...sel.selectedOptions].map((o) => o.value));
  sel.replaceChildren();
  for (const r of s.refs) {
    const o = document.createElement('option');
    o.value = r.name;
    o.textContent = r.name.replace(/^refs\//, '');
    o.selected = chosen.has(r.name);
    sel.append(o);
  }
  sel.size = Math.min(6, Math.max(2, s.refs.length));
}

/** The one question the toolbar is asking, whichever control was touched. */
function askFromToolbar() {
  const kind = $<HTMLSelectElement>('question').value;
  const refs = [...$<HTMLSelectElement>('branches').selectedOptions].map((o) => o.value);
  tape.ask(questionFor(kind, $<HTMLInputElement>('search').value, refs));
  pushView();
}

$('question').addEventListener('change', () => {
  const kind = $<HTMLSelectElement>('question').value;
  $('search').hidden = kind === 'all' || kind === 'branches';
  $('branches').hidden = kind !== 'branches';
  askFromToolbar();
});
$('search').addEventListener('input', () => {
  const kind = $<HTMLSelectElement>('question').value;
  if (kind === 'all' || kind === 'branches') return;
  askFromToolbar();
});
$('branches').addEventListener('change', askFromToolbar);
$('toggle-index').addEventListener('click', () => {
  tape.view = { ...tape.view, showIndex: !tape.view.showIndex };
  pushView();
});
$('toggle-orphans').addEventListener('click', () => {
  tape.view = { ...tape.view, showUnreachable: tape.view.showUnreachable === false };
  pushView();
});
$('toggle-cross').addEventListener('click', () => {
  tape.view = { ...tape.view, showCrossLinks: !tape.view.showCrossLinks };
  pushView();
});
$('load-all').addEventListener('click', () => {
  if (tape.loadAll()) pushView();
});
$('unfold').addEventListener('click', () => {
  tape.unfoldAll();
  pushView();
});
$('fold').addEventListener('click', () => {
  tape.foldAll();
  pushView();
});
// Dropping every pin, at every moment of the tape: a pin is a thing you put
// there by hand, so taking them all back is one gesture, not a page reload.
$('unpin').addEventListener('click', () => {
  pins.clear();
  relayout(true, false);
});
$('legend-btn').addEventListener('click', () => $<HTMLDialogElement>('legend').showModal());
const centreBox = $<HTMLInputElement>('centre-on-click');
centreBox.checked = prefs.centreOnClick;
centreBox.addEventListener('change', () => {
  prefs.centreOnClick = centreBox.checked;
  savePrefs();
});
const openNew = $<HTMLInputElement>('open-new-commits');
openNew.checked = prefs.openNewCommits;
openNew.addEventListener('change', () => {
  prefs.openNewCommits = openNew.checked;
  savePrefs();
});
const refitBox = $<HTMLInputElement>('refit-on-change');
refitBox.checked = prefs.refitOnChange;
refitBox.addEventListener('change', () => {
  prefs.refitOnChange = refitBox.checked;
  savePrefs();
});
$('play').addEventListener('click', () => {
  if (tape.following) {
    tape.following = false;
    updateHeader();
  } else moved(tape.goLive());
});
$('step-back').addEventListener('click', () => moved(tape.step(-1)));
$('step-fwd').addEventListener('click', () => moved(tape.step(1)));
$('scrub').addEventListener('input', () => {
  moved(tape.scrubTo(Number($<HTMLInputElement>('scrub').value)));
});

const moved = (j: { prev: Snapshot | null } | null) => (j ? shown(j.prev) : updateHeader());

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'f' && scene) {
    camera = fit(scene, canvas.clientWidth);
    glide = null;
    schedule();
  } else if (e.key === '[' || e.key === 'ArrowLeft') moved(tape.step(-1));
  else if (e.key === ']' || e.key === 'ArrowRight') moved(tape.step(1));
  else if (e.key === ' ') {
    e.preventDefault();
    $('play').click();
  } else if (e.key === 'i') $('toggle-index').click();
});

// ---------------------------------------------------------------------------
// The camera and the mouse
// ---------------------------------------------------------------------------

const world = (ev: { clientX: number; clientY: number }) =>
  toWorld(camera, ev, canvas.getBoundingClientRect());

let drag: { id: string | null; x: number; y: number; moved: boolean; dx: number; dy: number } | null = null;

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  glide = null;
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add('dragging');
  const w = world(e);
  const hit = scene ? hitTest(scene, w.x, w.y) : null;
  drag = hit
    ? { id: hit.id, x: e.clientX, y: e.clientY, moved: false, dx: w.x - hit.x, dy: w.y - hit.y }
    : { id: null, x: e.clientX, y: e.clientY, moved: false, dx: 0, dy: 0 };
});

canvas.addEventListener('pointermove', (e) => {
  if (!drag) {
    const w = world(e);
    const hit = scene ? hitTest(scene, w.x, w.y) : null;
    const id = hit?.id ?? null;
    if (id !== hover) {
      hover = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
      schedule();
    }
    return;
  }
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.id && drag.moved) {
    const w = world(e);
    pins.put(tape.current?.seq ?? 0, drag.id, w.x - drag.dx, w.y - drag.dy);
    relayout(false, false);
  } else if (!drag.id && scene) {
    camera = { ...camera, ...bounded({ x: camera.x + dx, y: camera.y + dy }, camera.scale, scene, port()) };
    drag.x = e.clientX;
    drag.y = e.clientY;
    schedule();
  }
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  const click: Click | null =
    drag && !drag.moved ? { at: e.timeStamp, x: e.clientX, y: e.clientY, id: drag.id } : null;
  drag = null;
  if (!click) return;

  // The pair acts on what the *first* click hit, because that click may have
  // centred it and moved it out from under the pointer.
  const double = isDouble(lastClick, click);
  const id = double ? lastClick!.id : click.id;
  lastClick = double ? null : click;
  const node = id ? (scene?.nodes.find((n) => n.id === id) ?? null) : null;

  if (double) {
    // Double-click opens the thing you double-clicked, the way it opens a
    // folder everywhere else — and empty space pulls the whole graph back.
    if (node?.kind === 'commit') tape.toggle(node.id);
    else if (node?.kind === 'tree') tape.toggleTree(node.id);
    else if (!node && scene) {
      camera = zoomOut(scene, port(), world(e).y);
      glide = null;
      schedule();
      return;
    } else return;
    pushView();
    return;
  }

  // A button, not an object: clicking it loads, it never becomes the thing
  // the rest of the graph is dimmed around.
  if (id === 'more') {
    if (tape.loadMore()) pushView();
    return;
  }
  // Shift is the undo of dragging: the pin comes out and the layout takes the
  // node back. Nothing is selected or copied on the way — it is one act.
  if (e.shiftKey && id) {
    if (pins.drop(id)) relayout(true, false);
    return;
  }
  selected = id;
  renderPanel(panel, tape.current, node);
  // Anything with a sha is a key in the key-value store, so a click hands you
  // the key: the whole point is that you can paste it into the next command.
  if (node?.oid) copied(node.oid);
  if (node && prefs.centreOnClick) {
    glide = null;
    camera = centre(camera, node, port());
  }
  schedule();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const w = world(e);
  const hit = scene ? hitTest(scene, w.x, w.y) : null;
  if (!hit) return;
  // A node moves around as history is filtered and folded, and a mark is how
  // you follow it.
  if (!canMark(hit.kind)) return;
  if (!marked.delete(hit.id)) marked.add(hit.id);
  schedule();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (!scene) return;
    if (e.ctrlKey || e.metaKey) {
      glide = null;
      camera = zoom(camera, world(e), e.deltaY, scene, port());
    } else {
      const at = glide ?? camera;
      glide = bounded({ x: at.x - e.deltaX, y: at.y - e.deltaY }, camera.scale, scene, port());
    }
    schedule();
  },
  { passive: false },
);

// ---------------------------------------------------------------------------

new ResizeObserver(() => {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  schedule();
}).observe(canvas);

renderPanel(panel, null, null);
