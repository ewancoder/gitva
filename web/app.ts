/**
 * The client: one view, one tape, one camera.
 *
 * Every way the user can change what is on screen is a change to the view —
 * branch filtering, search, paging and drill-down are one mechanism, not four
 * features. Everything the browser is shown is kept, so a demo can be replayed
 * instead of redone.
 */

import { diffScenes, describe, EMPTY_CHANGE, type Change } from '../src/diff.js';
import { layout, type Scene, type SceneNode } from '../src/layout.js';
import { type Snapshot, type View } from '../src/types.js';
import { renderPanel } from './panel.js';
import { draw, fit, hitTest, snapPositions, type Camera } from './render.js';
import { Tape } from './tape.js';
import { theme } from './theme.js';

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('graph');
const ctx = canvas.getContext('2d')!;
const panel = $('panel');

// --- preferences: about how this person likes to work, not about this session
interface Prefs {
  showIndex: boolean;
  centreOnClick: boolean;
  openNewCommits: boolean;
}
const prefs: Prefs = {
  showIndex: true,
  centreOnClick: false,
  openNewCommits: true,
  ...JSON.parse(localStorage.getItem('gitva.prefs') ?? '{}'),
};
const savePrefs = () => localStorage.setItem('gitva.prefs', JSON.stringify(prefs));

// --- the tape: every state seen, where we stand in it, and the view we ask
// with. It owns all three, so nothing here keeps a second copy to drift.
const tape = new Tape();
tape.view = { ...tape.view, showIndex: prefs.showIndex };

// --- what is on screen
let scene: Scene | null = null;
let ghosts: SceneNode[] = [];
let change: Change = EMPTY_CHANGE;
let flashAt = -1e9;
let enterAt = -1e9;
let camera: Camera = { x: 24, y: 24, scale: 1 };
let hover: string | null = null;
let selected: string | null = null;
let exhausted = false;

/** Objects marked by right-click, kept by sha until right-clicked again. */
const marked = new Set<string>();

/** A pin belongs to the moment it was made in, and is keyed to the object. */
const pins: { seq: number; id: string; x: number; y: number }[] = [];
function pinsAt(seq: number): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {};
  for (const p of pins) if (p.seq <= seq) out[p.id] = { x: p.x, y: p.y };
  return out;
}

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
  glideStep();
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

/**
 * Wheel panning glides to where it was asked for rather than jumping there:
 * the graph is a page, and a page that lurches is a page you lose your place in.
 * Every other way of moving the camera is direct, and cancels the glide.
 */
let glide: { x: number; y: number } | null = null;

/**
 * The graph is a page, not a plane: you can reach every edge of it and no
 * further. Panning past the last commit into empty grey is how you lose the
 * whole thing and have to scroll back for it.
 */
function bounded(c: { x: number; y: number }, scale = camera.scale): { x: number; y: number } {
  if (!scene) return c;
  const m = 20;
  const axis = (v: number, span: number, content: number) => {
    const far = span - content * scale - m;
    return Math.min(Math.max(v, Math.min(m, far)), Math.max(m, far));
  };
  return {
    x: axis(c.x, canvas.clientWidth, scene.width),
    y: axis(c.y, canvas.clientHeight, scene.height),
  };
}
function glideStep() {
  if (!glide) return;
  const k = reduceMotion ? 1 : 0.22;
  const x = camera.x + (glide.x - camera.x) * k;
  const y = camera.y + (glide.y - camera.y) * k;
  const done = Math.abs(glide.x - x) < 0.5 && Math.abs(glide.y - y) < 0.5;
  camera = { ...camera, x: done ? glide.x : x, y: done ? glide.y : y };
  if (done) glide = null;
}

function relayout(animate: boolean, repoChanged: boolean) {
  // Every tree the tape has ever read, not only the ones this state came with:
  // a commit opened now has to draw open on a state recorded before it was.
  const state = tape.world;
  if (!state) return;
  const next = layout(state, tape.view, pinsAt(state.seq));
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
source.addEventListener('snapshot', (e) => {
  live(true);
  const s: Snapshot = JSON.parse((e as MessageEvent).data);
  fillBranches(s);
  if (s.window.commits.length < s.view.limit) exhausted = true;
  const a = tape.arrive(s, prefs);
  if (a.post) postView(a.post);
  if (a.kind === 'shown') {
    shown(a.prev);
    if (a.first && scene) {
      camera = fit(scene, canvas.clientWidth);
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

  const kinds = { commit: 0, tree: 0, blob: 0, tag: 0 };
  for (const o of Object.values(snap.objects)) kinds[o.type]++;
  const drawn = scene?.nodes.length ?? 0;
  $('tally').textContent =
    `${drawn} on screen · ${snap.window.commits.length} commits` +
    (snap.caps.fullLoad
      ? ` · ${kinds.commit}c ${kinds.tree}t ${kinds.blob}b${kinds.tag ? ` ${kinds.tag}g` : ''}` +
        ` · ${(snap.unreachable ?? []).length} unreachable`
      : ` · ${snap.caps.objectCount.toLocaleString()} objects`) +
    ` · ${snap.index.length} index`;

  const list = $('notes-list');
  list.replaceChildren();
  const notes = [...snap.notes];
  if (tape.dropped > 0) {
    notes.push(`Tape: ${tape.states.length} states kept, ${tape.dropped} older ones dropped.`);
  }
  for (const n of notes) {
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
  $<HTMLButtonElement>('load-all').disabled = !canLoadMore();
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

$('question').addEventListener('change', () => {
  const kind = $<HTMLSelectElement>('question').value;
  const search = $<HTMLInputElement>('search');
  const branches = $<HTMLSelectElement>('branches');
  search.hidden = kind === 'all' || kind === 'branches';
  branches.hidden = kind !== 'branches';
  exhausted = false;
  if (kind === 'all') tape.view = { ...tape.view, question: { kind: 'all' } };
  else if (kind === 'branches')
    tape.view = { ...tape.view, question: { kind: 'refs', refs: [...branches.selectedOptions].map((o) => o.value) } };
  else tape.view = { ...tape.view, question: { kind: 'search', text: search.value, in: kind as 'message' } };
  pushView();
});
$('search').addEventListener('input', () => {
  const kind = $<HTMLSelectElement>('question').value;
  if (kind === 'all' || kind === 'branches') return;
  exhausted = false;
  const text = $<HTMLInputElement>('search').value;
  tape.view = { ...tape.view, question: { kind: 'search', text, in: kind as 'message' } };
  pushView();
});
$('branches').addEventListener('change', () => {
  exhausted = false;
  tape.view = {
    ...tape.view,
    question: { kind: 'refs', refs: [...$<HTMLSelectElement>('branches').selectedOptions].map((o) => o.value) },
  };
  pushView();
});
$('toggle-index').addEventListener('click', () => {
  tape.view = { ...tape.view, showIndex: !tape.view.showIndex };
  pushView();
});
$('load-all').addEventListener('click', loadAllHistory);
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
  pins.length = 0;
  relayout(true, false);
});
$('legend-btn').addEventListener('click', () => $<HTMLDialogElement>('legend').showModal());
const centre = $<HTMLInputElement>('centre-on-click');
centre.checked = prefs.centreOnClick;
centre.addEventListener('change', () => {
  prefs.centreOnClick = centre.checked;
  savePrefs();
});
const openNew = $<HTMLInputElement>('open-new-commits');
openNew.checked = prefs.openNewCommits;
openNew.addEventListener('change', () => {
  prefs.openNewCommits = openNew.checked;
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
  } else if (e.key === '[') moved(tape.step(-1));
  else if (e.key === ']') moved(tape.step(1));
  else if (e.key === ' ') {
    e.preventDefault();
    $('play').click();
  } else if (e.key === 'i') $('toggle-index').click();
});

// ---------------------------------------------------------------------------
// The camera and the mouse
// ---------------------------------------------------------------------------

const world = (ev: { clientX: number; clientY: number }) => {
  const r = canvas.getBoundingClientRect();
  return {
    x: (ev.clientX - r.left - camera.x) / camera.scale,
    y: (ev.clientY - r.top - camera.y) / camera.scale,
  };
};

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
    const seq = tape.current?.seq ?? 0;
    const existing = pins.find((p) => p.id === drag!.id && p.seq === seq);
    if (existing) {
      existing.x = w.x - drag.dx;
      existing.y = w.y - drag.dy;
    } else pins.push({ seq, id: drag.id, x: w.x - drag.dx, y: w.y - drag.dy });
    relayout(false, false);
  } else if (!drag.id) {
    camera = { ...camera, ...bounded({ x: camera.x + dx, y: camera.y + dy }) };
    drag.x = e.clientX;
    drag.y = e.clientY;
    schedule();
  }
});

canvas.addEventListener('pointerup', (e) => {
  canvas.classList.remove('dragging');
  if (drag && !drag.moved) {
    // A button, not an object: clicking it loads, it never becomes the thing
    // the rest of the graph is dimmed around.
    if (drag.id === 'more') {
      loadMoreHistory();
      drag = null;
      return;
    }
    selected = drag.id;
    const node = scene?.nodes.find((n) => n.id === selected) ?? null;
    renderPanel(panel, tape.current, node);
    if (node && prefs.centreOnClick) {
      glide = null;
      camera = {
        ...camera,
        x: canvas.clientWidth / 2 - (node.x + node.w / 2) * camera.scale,
        y: canvas.clientHeight / 2 - (node.y + node.h / 2) * camera.scale,
      };
    }
    schedule();
  }
  drag = null;
  void e;
});

// Double-clicking nothing in particular is the way back to the starting zoom —
// full width, but staying where you are: jumping to the top would lose the
// place you were reading.
canvas.addEventListener('dblclick', (e) => {
  const w = world(e);
  const hit = scene ? hitTest(scene, w.x, w.y) : null;
  // Double-clicking a node is the undo of dragging it: the pin comes out and
  // the layout takes it back.
  if (hit) {
    const n = pins.length;
    for (let i = pins.length - 1; i >= 0; i--) if (pins[i].id === hit.id) pins.splice(i, 1);
    if (n !== pins.length) relayout(true, false);
    return;
  }
  if (!scene) return;
  const { scale } = fit(scene, canvas.clientWidth);
  camera = { scale, ...bounded({ x: 20, y: canvas.clientHeight / 2 - w.y * scale }, scale) };
  glide = null;
  schedule();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const w = world(e);
  const hit = scene ? hitTest(scene, w.x, w.y) : null;
  if (!hit) return;
  if (hit.kind === 'commit') {
    tape.toggle(hit.id);
    pushView();
    return;
  }
  // Everything else that is an object gets a mark instead: an object moves
  // around as history is filtered and folded, and a mark is how you follow it.
  if (hit.kind !== 'tree' && hit.kind !== 'blob' && hit.kind !== 'tag' && hit.kind !== 'submodule') return;
  if (!marked.delete(hit.id)) marked.add(hit.id);
  schedule();
});

canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      glide = null;
      const w = world(e);
      const k = Math.exp(-e.deltaY / 400);
      const scale = Math.min(4, Math.max(0.1, camera.scale * k));
      const at = bounded({ x: camera.x + (w.x * camera.scale - w.x * scale), y: camera.y + (w.y * camera.scale - w.y * scale) }, scale);
      camera = { scale, ...at };
    } else {
      const at = glide ?? camera;
      glide = bounded({ x: at.x - e.deltaX, y: at.y - e.deltaY });
    }
    schedule();
  },
  { passive: false },
);

function canLoadMore() {
  return !exhausted && !!tape.current?.window.more && tape.following;
}

/** Clicking "load more history" pages — scrolling never loads anything. */
function loadMoreHistory() {
  if (!canLoadMore()) return;
  tape.view = { ...tape.view, limit: tape.view.limit + 1000 };
  pushView();
}

/**
 * "load all" asks for no limit at all and lets the server's ceiling be the only
 * bound. Not `totalCommits`: that is null on a big repo, and counts the whole
 * repository rather than the matches under a search.
 */
function loadAllHistory() {
  if (!canLoadMore()) return;
  tape.view = { ...tape.view, limit: Number.MAX_SAFE_INTEGER };
  pushView();
}

// ---------------------------------------------------------------------------

new ResizeObserver(() => {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  schedule();
}).observe(canvas);

renderPanel(panel, null, null);
