/**
 * The details panel: what this is, its facts, the plain-language explanation,
 * then its contents. Contents are fetched when something is read — a body is
 * for reading one thing, not for shipping with every state update.
 */

import { explain } from '../src/explain.js';
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

  const e = explain(snap, node.kind === 'submodule' ? 'commit' : node.kind, node.id);
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

  if (node.oid && (node.kind === 'blob' || node.kind === 'tree' || node.kind === 'index')) {
    const oid = node.kind === 'index' ? node.oid : node.oid;
    const pre = document.createElement('pre');
    pre.textContent = 'reading…';
    el.append(el2('dt', '', node.kind === 'tree' ? 'entries' : 'contents'), pre);
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

function el2(tag: string, cls: string, text: string): HTMLElement {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  n.textContent = text;
  return n;
}
