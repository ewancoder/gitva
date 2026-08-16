/**
 * The details panel: what this is, its facts, the plain-language explanation,
 * then its contents. Contents are fetched when something is read — a body is
 * for reading one thing, not for shipping with every state update.
 */

import { explain, refName } from '../src/explain.js';
import type { Snapshot } from '../src/types.js';
import type { SceneNode } from '../src/layout.js';

let token = 0;

export function renderPanel(el: HTMLElement, snap: Snapshot | null, node: SceneNode | null) {
  const mine = ++token;
  el.replaceChildren();
  if (!snap || !node) {
    el.append(el2('p', 'empty', 'Click anything to find out what it is.'));
    return;
  }

  const e = explain(snap, node.kind, node.id);
  el.append(el2('h2', '', e.title));
  el.append(el2('p', 'what', e.what));
  if (e.made) el.append(el2('div', 'made', e.made));

  if (e.facts.length > 0) {
    const dl = document.createElement('dl');
    for (const [k, v] of e.facts) {
      dl.append(el2('dt', '', k), el2('dd', '', v));
    }
    el.append(dl);
  }

  // A ref is a file with a sha in it, and HEAD is a file with a ref in it —
  // so show those bytes too. No fetch: the snapshot already carries them.
  const file = node.kind === 'ref' ? refFile(snap, node.id) : node.kind === 'head' ? headFile(snap) : null;
  if (file !== null) {
    el.append(el2('dt', '', 'raw content'), el2('pre', '', file));
    return;
  }

  // A commit is an object like any other: the parsed facts are above, this is
  // what git actually stored.
  if (node.oid && (node.kind === 'blob' || node.kind === 'tree' || node.kind === 'index' || node.kind === 'commit' || node.kind === 'tag')) {
    const oid = node.oid;
    const pre = document.createElement('pre');
    pre.textContent = 'reading…';
    const heading =
      node.kind === 'tree' ? 'entries' : node.kind === 'commit' || node.kind === 'tag' ? 'raw object' : 'contents';
    el.append(el2('dt', '', heading), pre);
    void fetch(`/object?oid=${oid}`)
      .then((r) => r.json())
      .then((body) => {
        if (mine !== token) return;
        if (body.entries) {
          pre.textContent = body.entries
            .map((x: { mode: string; type: string; oid: string; name: string }) =>
              `${x.mode} ${x.type} ${x.oid.slice(0, 7)}\t${x.name}`,
            )
            .join('\n');
        } else if (body.text === null) {
          pre.textContent = `${body.size} bytes, not text.`;
        } else {
          pre.textContent = body.text;
        }
      })
      .catch(() => {
        if (mine === token) pre.textContent = 'could not read it';
      });
  }
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

function el2(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = text;
  return n;
}
