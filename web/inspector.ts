/**
 * The details inspector: what this is, its facts, the plain-language explanation,
 * then its contents. Contents are fetched when something is read — a body is
 * for reading one thing, not for shipping with every step update.
 *
 * What the inspector *says* is `inspectorModel`, which is pure and tested; this file
 * only turns that into elements and asks the server for the body.
 */

import { explain, refName } from './explain.js';
import { S } from './localization/index.js';
import type { Oid, Step } from '../src/types.js';
import type { Shape } from './layout.js';

/** Objects whose bytes are worth reading out — the rest have nothing stored. */
const READABLE = ['blob', 'tree', 'index', 'commit', 'tag'];

export interface InspectorModel {
  title: string;
  what: string;
  made: string;
  facts: [string, string][];
  /** A ref is a file with a sha in it, and HEAD a file with a ref in it — so
   *  show those bytes too. No fetch: the step already carries them. */
  raw: string | null;
  /** The object to read out of the database, once it arrives. */
  body: { oid: Oid; heading: string } | null;
}

export function inspectorModel(step: Step, shape: Shape): InspectorModel {
  // A submodule is a commit that lives in another repository: nothing here has
  // its object, but what it *is* is still a commit.
  const e = explain(step, shape.kind === 'submodule' ? 'commit' : shape.kind, shape.id);
  const raw = shape.kind === 'ref' ? refFile(step, shape.id) : shape.kind === 'head' ? headFile(step) : null;
  return {
    ...e,
    raw,
    // A commit is an object like any other: the parsed facts are above, the
    // body is what git actually stored.
    body:
      raw === null && shape.oid && READABLE.includes(shape.kind)
        ? { oid: shape.oid, heading: headingFor(shape.kind) }
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
function refFile(step: Step, name: string): string {
  const r = step.refs.find((x) => x.name === refName(name));
  if (!r) return '';
  return r.packed ? `${r.oid} ${r.name}\n` : `${r.oid}\n`;
}

function headFile(step: Step): string {
  return step.head.detached ? `${step.head.oid ?? ''}\n` : `ref: ${step.head.ref ?? ''}\n`;
}

let token = 0;

export function renderInspector(el: HTMLElement, step: Step | null, shape: Shape | null) {
  const mine = ++token;
  el.replaceChildren();
  if (!step || !shape) {
    el.append(el2('p', 'empty', S.inspector.empty));
    return;
  }

  const m = inspectorModel(step, shape);
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
      if (body.path) storedIn(dl, after, step.gitDir, body.path);
    })
    .catch(() => {
      if (mine !== token) return;
      pre.textContent = S.inspector.unreadable;
      // A failure to read is a warning, not content: warning red, like `clear`.
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
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  el.textContent = text;
  return el;
}
