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
  if (m.facts.length > 0) {
    const dl = document.createElement('dl');
    for (const [k, v] of m.facts) dl.append(el2('dt', '', k), el2('dd', '', v));
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
      if (mine === token) pre.textContent = bodyText(body);
    })
    .catch(() => {
      if (mine === token) pre.textContent = S.inspector.unreadable;
    });
}

function el2(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = text;
  return n;
}
