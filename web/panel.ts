/**
 * The details panel: what this is, its facts, the plain-language explanation,
 * then its contents. Contents are fetched when something is read — a body is
 * for reading one thing, not for shipping with every state update.
 *
 * What the panel *says* is `panelModel`, which is pure and tested; this file
 * only turns that into elements and asks the server for the body.
 */

import { explain, refName } from '../src/explain.js';
import { S } from '../src/strings.js';
import type { Oid, Snapshot } from '../src/types.js';
import type { SceneNode } from '../src/layout.js';

/** Objects whose bytes are worth reading out — the rest have nothing stored. */
const READABLE = ['blob', 'tree', 'index', 'commit', 'tag'];

export interface PanelModel {
  title: string;
  what: string;
  made: string;
  facts: [string, string][];
  /** A ref is a file with a sha in it, and HEAD a file with a ref in it — so
   *  show those bytes too. No fetch: the snapshot already carries them. */
  raw: string | null;
  /** The object to read out of the database, once it arrives. */
  body: { oid: Oid; heading: string } | null;
}

export function panelModel(snap: Snapshot, node: SceneNode): PanelModel {
  // A submodule is a commit that lives in another repository: nothing here has
  // its object, but what it *is* is still a commit.
  const e = explain(snap, node.kind === 'submodule' ? 'commit' : node.kind, node.id);
  const raw = node.kind === 'ref' ? refFile(snap, node.id) : node.kind === 'head' ? headFile(snap) : null;
  return {
    ...e,
    raw,
    // A commit is an object like any other: the parsed facts are above, the
    // body is what git actually stored.
    body:
      raw === null && node.oid && READABLE.includes(node.kind)
        ? { oid: node.oid, heading: headingFor(node.kind) }
        : null,
  };
}

const headingFor = (kind: string) =>
  kind === 'tree'
    ? S.inspector.heading.entries
    : kind === 'commit' || kind === 'tag'
      ? S.inspector.heading.object
      : S.inspector.heading.contents;

/** What `/object` answered, as the lines to show. */
export function bodyText(body: {
  entries?: { mode: string; type: string; oid: string; name: string }[];
  text?: string | null;
  size?: number;
  truncated?: boolean;
}): string {
  if (body.entries) {
    return body.entries.map((x) => `${x.mode} ${x.type} ${x.oid.slice(0, 7)}\t${x.name}`).join('\n');
  }
  if (body.text == null) return S.inspector.notText(body.size ?? 0);
  return body.truncated
    ? `${body.text}\n\n${S.inspector.truncated(body.size ?? 0)}`
    : body.text;
}

/** What is in .git/<name> — or, once packed, the line that replaced the file. */
function refFile(snap: Snapshot, name: string): string {
  const r = snap.refs.find((x) => x.name === refName(name));
  if (!r) return '';
  return r.packed ? `${r.oid} ${r.name}\n` : `${r.oid}\n`;
}

function headFile(snap: Snapshot): string {
  return snap.head.detached ? `${snap.head.oid ?? ''}\n` : `ref: ${snap.head.ref ?? ''}\n`;
}

let token = 0;

export function renderPanel(el: HTMLElement, snap: Snapshot | null, node: SceneNode | null) {
  const mine = ++token;
  el.replaceChildren();
  if (!snap || !node) {
    el.append(el2('p', 'empty', S.inspector.empty));
    return;
  }

  const m = panelModel(snap, node);
  el.append(el2('h2', '', m.title), el2('p', 'what', m.what));
  if (m.made) el.append(el2('div', 'made', m.made));
  const dl = document.createElement('dl');
  // The row the file it is stored in pushes down when it arrives: the sha is
  // the key, and where git kept that key's value belongs directly under it.
  let seenSha = false;
  let after: HTMLElement | null = null;
  if (m.facts.length > 0) {
    // The sha is the key the store is addressed by, so it is worth handing
    // over: marked here, copied by whoever owns the clipboard.
    for (const [k, v] of m.facts) {
      const dt = el2('dt', '', k);
      if (k === S.inspector.fields.sha) seenSha = true;
      else if (seenSha && !after) after = dt;
      dl.append(dt, el2('dd', k === S.inspector.fields.sha ? 'sha' : '', v));
    }
    el.append(dl);
  }
  if (m.raw !== null) {
    el.append(el2('dt', '', S.inspector.heading.raw), el2('pre', '', m.raw));
    return;
  }
  if (!m.body) return;

  const pre = el2('pre', '', S.inspector.reading);
  el.append(el2('dt', '', m.body.heading), pre);
  void fetch(`/object?oid=${m.body.oid}`)
    .then((r) => r.json())
    .then((body) => {
      if (mine !== token) return;
      pre.textContent = bodyText(body);
      // Where the bytes turned out to be kept. It comes back with them because
      // only git can say whether this one is still a file or has been packed.
      if (body.path) storedIn(dl, after, snap.gitDir, body.path);
    })
    .catch(() => {
      if (mine !== token) return;
      pre.textContent = S.inspector.unreadable;
      // A failure to read is a warning, not content: chrome red, like `clear`.
      pre.className = 'unreadable danger';
    });
}

/**
 * The file .git keeps it in, shown inside .git — the part a viewer can type —
 * and handing over the whole path on a click, exactly as the sha hands over the
 * key.
 */
function storedIn(dl: HTMLElement, before: HTMLElement | null, gitDir: string, path: string) {
  const dd = el2('dd', 'sha', path);
  dd.dataset.copy = `${gitDir}/${path}`;
  dl.insertBefore(el2('dt', '', S.inspector.fields.storedIn), before);
  dl.insertBefore(dd, before);
}

function el2(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = text;
  return n;
}
