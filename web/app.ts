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
import { DEFAULT_VIEW, type Snapshot, type View } from '../src/types.js';
import { renderPanel } from './panel.js';
import { draw, fit, hitTest, type Camera } from './render.js';
import { theme } from './theme.js';

const TAPE_CAP = 400;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('graph');
const ctx = canvas.getContext('2d')!;
const panel = $('panel');

// --- preferences: about how this person likes to work, not about this session
interface Prefs {
  showIndex: boolean;
  centreOnClick: boolean;
}
const prefs: Prefs = {
  showIndex: true,
  centreOnClick: false,
  ...JSON.parse(localStorage.getItem('gitva.prefs') ?? '{}'),
};
const savePrefs = () => localStorage.setItem('gitva.prefs', JSON.stringify(prefs));

let view: View = { ...DEFAULT_VIEW, showIndex: prefs.showIndex };

// --- the tape
const tape: Snapshot[] = [];
let dropped = 0;
let cursor = -1;
let following = true;

// --- what is on screen
let snap: Snapshot | null = null;
let scene: Scene | null = null;
let ghosts: SceneNode[] = [];
let change: Change = EMPTY_CHANGE;
let flashAt = -1e9;
let enterAt = -1e9;
let camera: Camera = { x: 24, y: 24, scale: 1 };
let hover: string | null = null;
let selected: string | null = null;
let exhausted = false;

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

/** Nodes that *are* an object; an index chip only names one. */
const isObject = (n: SceneNode) =>
  n.oid !== undefined && n.kind !== 'index';

function relayout(animate: boolean, repoChanged: boolean) {
  if (!snap) return;
  let next = layout(snap, view, pinsAt(snap.seq));
  // Losing your last arrow is the lesson — being teleported to the bottom of the
  // page is not. An object drawn somewhere new because its relations changed —
  // into the orphanage, or back out of it, or from a gutter chip to a node —
  // keeps the spot it already had, so what changed is the arrow, and only the
  // arrow. Keyed by oid, because the same object is a different node id in the
  // gutter than it is in the object band.
  if (scene) {
    const before = new Map<string, SceneNode>();
    for (const n of scene.nodes) if (isObject(n) && !before.has(n.oid!)) before.set(n.oid!, n);
    let stuck = false;
    for (const n of next.nodes) {
      const was = isObject(n) ? before.get(n.oid!) : undefined;
      // Same node, same place in its band: rows shifting under it is not a
      // change of relation, and freezing those would peg the whole graph.
      if (!was || (was.id === n.id && !!was.stray === !!n.stray)) continue;
      if ((was.x === n.x && was.y === n.y) || pins.some((p) => p.id === n.id)) continue;
      pins.push({ seq: 0, id: n.id, x: was.x, y: was.y });
      stuck = true;
    }
    if (stuck) next = layout(snap, view, pinsAt(snap.seq));
  }
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

function record(s: Snapshot) {
  // A step is a state of the repository. Asking the same repository a different
  // question — folding, filtering, paging — replaces the state in place, so
  // stepping back and forth only ever walks over things git actually did.
  const top = tape.length - 1;
  if (top >= 0 && tape[top].seq === s.seq) {
    tape[top] = s;
    if (cursor !== top) return;
    snap = s;
    relayout(true, false);
    updateHeader();
    if (selected) renderPanel(panel, snap, scene?.nodes.find((n) => n.id === selected) ?? null);
    return;
  }
  tape.push(s);
  if (tape.length > TAPE_CAP) {
    tape.shift();
    dropped++;
  }
  if (following) show(tape.length - 1, true);
  else updateHeader();
}

function show(i: number, live: boolean) {
  const next = tape[i];
  if (!next) return;
  const prev = snap;
  cursor = i;
  snap = next;
  // Each state was a state *of a view*, so going back to one puts its view
  // back. While live the local view wins: it is ahead of what the server has
  // answered with yet.
  if (!live) view = next.view;
  const changed = describe(prev, next);
  renderHeaderChange(prev ? changed : 'first read');
  relayout(true, prev !== null && changed !== 'no visible change');
  updateHeader();
  if (!live) following = false;
  if (selected) renderPanel(panel, snap, scene?.nodes.find((n) => n.id === selected) ?? null);
}

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

let postTimer: number | undefined;
function pushView() {
  prefs.showIndex = view.showIndex;
  savePrefs();
  relayout(true, false);
  updateHeader();
  clearTimeout(postTimer);
  postTimer = setTimeout(() => {
    void fetch('/view', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(view),
    });
  }, 60) as unknown as number;
}

const source = new EventSource('/events');
source.addEventListener('snapshot', (e) => {
  live(true);
  const s: Snapshot = JSON.parse((e as MessageEvent).data);
  const firstEver = snap === null;
  if (firstEver) {
    view = { ...s.view, showIndex: prefs.showIndex };
    // Anything past a handful of commits starts folded.
    if (s.window.commits.length <= 6 && view.expanded.length === 0) {
      view = { ...view, expanded: s.window.commits };
      pushView();
    }
  }
  fillBranches(s);
  if (s.window.commits.length < s.view.limit) exhausted = true;
  record(s);
  if (firstEver && scene) {
    camera = fit(scene, canvas.clientWidth);
    glide = null;
    schedule();
  }
});
source.addEventListener('trouble', (e) => {
  renderHeaderChange(JSON.parse((e as MessageEvent).data).message);
});
source.onerror = () => live(false);
source.onopen = () => live(true);

function live(ok: boolean) {
  const dot = $('live-dot');
  dot.className = 'dot' + (ok ? (following ? '' : ' paused') : ' off');
  $('live-text').textContent = ok ? (following ? 'live' : 'paused') : 'connection lost';
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

function updateHeader() {
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
  if (dropped > 0) notes.push(`Tape: ${tape.length} states kept, ${dropped} older ones dropped.`);
  for (const n of notes) {
    const li = document.createElement('li');
    li.textContent = n;
    list.append(li);
  }

  const scrub = $<HTMLInputElement>('scrub');
  scrub.max = String(Math.max(0, tape.length - 1));
  scrub.value = String(Math.max(0, cursor));
  $('tape-pos').textContent = tape.length ? `${cursor + 1}/${tape.length}` : '';
  $('play').textContent = following ? 'pause' : 'go live';
  $('play').setAttribute('aria-pressed', String(!following));
  $('toggle-index').setAttribute('aria-pressed', String(view.showIndex));
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
  if (kind === 'all') view = { ...view, question: { kind: 'all' } };
  else if (kind === 'branches')
    view = { ...view, question: { kind: 'refs', refs: [...branches.selectedOptions].map((o) => o.value) } };
  else view = { ...view, question: { kind: 'search', text: search.value, in: kind as 'message' } };
  pushView();
});
$('search').addEventListener('input', () => {
  const kind = $<HTMLSelectElement>('question').value;
  if (kind === 'all' || kind === 'branches') return;
  exhausted = false;
  view = { ...view, question: { kind: 'search', text: $<HTMLInputElement>('search').value, in: kind as 'message' } };
  pushView();
});
$('branches').addEventListener('change', () => {
  exhausted = false;
  view = {
    ...view,
    question: { kind: 'refs', refs: [...$<HTMLSelectElement>('branches').selectedOptions].map((o) => o.value) },
  };
  pushView();
});
$('toggle-index').addEventListener('click', () => {
  view = { ...view, showIndex: !view.showIndex };
  pushView();
});
$('load-all').addEventListener('click', loadAllHistory);
$('unfold').addEventListener('click', () => {
  view = { ...view, expanded: snap ? [...snap.window.commits] : [] };
  pushView();
});
$('fold').addEventListener('click', () => {
  view = { ...view, expanded: [] };
  pushView();
});
$('legend-btn').addEventListener('click', () => $<HTMLDialogElement>('legend').showModal());
const centre = $<HTMLInputElement>('centre-on-click');
centre.checked = prefs.centreOnClick;
centre.addEventListener('change', () => {
  prefs.centreOnClick = centre.checked;
  savePrefs();
});
$('play').addEventListener('click', () => {
  following = !following;
  if (following) show(tape.length - 1, true);
  updateHeader();
});
$('step-back').addEventListener('click', () => step(-1));
$('step-fwd').addEventListener('click', () => step(1));
$('scrub').addEventListener('input', () => {
  following = false;
  show(Number($<HTMLInputElement>('scrub').value), false);
});

function step(d: number) {
  const i = Math.min(tape.length - 1, Math.max(0, cursor + d));
  following = i === tape.length - 1;
  show(i, following);
}

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === 'f' && scene) {
    camera = fit(scene, canvas.clientWidth);
    glide = null;
    schedule();
  } else if (e.key === '[') step(-1);
  else if (e.key === ']') step(1);
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
    const seq = snap?.seq ?? 0;
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
    renderPanel(panel, snap, node);
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
  if (!scene || hitTest(scene, w.x, w.y)) return;
  const { scale } = fit(scene, canvas.clientWidth);
  camera = { scale, ...bounded({ x: 20, y: canvas.clientHeight / 2 - w.y * scale }, scale) };
  glide = null;
  schedule();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const w = world(e);
  const hit = scene ? hitTest(scene, w.x, w.y) : null;
  if (!hit || hit.kind !== 'commit') return;
  const on = view.expanded.includes(hit.id);
  view = { ...view, expanded: on ? view.expanded.filter((o) => o !== hit.id) : [...view.expanded, hit.id] };
  pushView();
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
  return !!snap && !exhausted && snap.window.more && following;
}

/** Clicking "load more history" pages — scrolling never loads anything. */
function loadMoreHistory() {
  if (!canLoadMore()) return;
  view = { ...view, limit: view.limit + 1000 };
  pushView();
}

/**
 * "load all" asks for no limit at all and lets the server's ceiling be the only
 * bound. Not `totalCommits`: that is null on a big repo, and counts the whole
 * repository rather than the matches under a search.
 */
function loadAllHistory() {
  if (!canLoadMore()) return;
  view = { ...view, limit: Number.MAX_SAFE_INTEGER };
  pushView();
}

// ---------------------------------------------------------------------------

new ResizeObserver(() => {
  canvas.width = Math.round(canvas.clientWidth * devicePixelRatio);
  canvas.height = Math.round(canvas.clientHeight * devicePixelRatio);
  schedule();
}).observe(canvas);

renderPanel(panel, null, null);
