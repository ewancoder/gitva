/**
 * The details inspector: what this is, its facts, the plain-language explanation,
 * then its contents. Contents are fetched when something is read — a body is
 * for reading one thing, not for shipping with every step update.
 *
 * What the inspector *says* is `inspectorModel`, which is pure and tested; this file
 * only turns that into elements and asks the server for the body.
 */

import { explain, indexEntry, isGitlink, refName } from './explain.js';
import type { Fact, Key } from './explain.js';
import { S } from './localization/index.js';
import type { Oid, Step } from '../src/types.js';
import type { Shape } from './layout.js';

/** Objects whose bytes are worth reading out — the rest have nothing stored. */
const READABLE = ['blob', 'tree', 'index', 'commit', 'tag'];

export interface InspectorModel {
    title: string;
    what: string;
    made: string;
    facts: Fact[];
    /** A ref is a file with a sha in it, and HEAD a file with a ref in it — so
     *  show those bytes too. No fetch: the step already carries them. */
    raw: string | null;
    /** The object to read out of the database, once it arrives. */
    body: { oid: Oid } | null;
}

export function inspectorModel(step: Step, shape: Shape): InspectorModel {
    // A submodule is a commit that lives in another repository: nothing here has
    // its object, but what it *is* is still a commit.
    const e = explain(step, shape.kind === 'submodule' ? 'commit' : shape.kind, shape.id);
    const raw =
        shape.kind === 'ref'
            ? refFile(step, shape.id)
            : shape.kind === 'head'
              ? headFile(step)
              : null;
    // A gitlink entry stages a commit that lives in another repository, so there
    // are no bytes here to read out — the same reason a submodule shape has none.
    const gitlink = shape.kind === 'index' && isGitlink(indexEntry(step, shape.id));
    return {
        ...e,
        raw,
        // A commit is an object like any other: the parsed facts are above, the
        // body is what git actually stored.
        body:
            raw === null && !gitlink && shape.oid && READABLE.includes(shape.kind)
                ? { oid: shape.oid }
                : null,
    };
}

/** What `/object` answers. The server is the only writer, so the shape is known. */
export interface Body {
    entries?: { mode: string; type: string; oid: string; name: string }[];
    text?: string | null;
    size?: number;
    truncated?: boolean;
    /** Where the bytes are kept — `null` once they are packed. */
    path?: string | null;
}

/** What `/object` answered, as the lines to show. */
export function bodyText(body: Body): string {
    if (body.entries) return body.entries.map(entryLine).join('\n');
    if (body.text == null) return S.inspector.notText(body.size ?? 0);
    return body.truncated ? `${body.text}\n\n${S.inspector.truncated(body.size ?? 0)}` : body.text;
}

/** One tree entry, as git's own `ls-tree` says it. */
function entryLine(x: { mode: string; type: string; oid: string; name: string }): string {
    return `${x.mode} ${x.type} ${x.oid.slice(0, 7)}\t${x.name}`;
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

/** `compact` is the page's global compact setting: the object itself and nothing
 *  about it — the title, the facts and the bytes, without the paragraph that
 *  teaches what the kind is and the command that makes one. */
export function renderInspector(
    el: HTMLElement,
    step: Step | null,
    shape: Shape | null,
    compact = false,
) {
    const mine = ++token;
    el.replaceChildren();
    if (!step || !shape) {
        el.append(el2('p', 'empty', S.inspector.empty));
        return;
    }

    const m = inspectorModel(step, shape);
    // Which kind is being read: the compact inspector keeps a different row or
    // two per kind, and that is a stylesheet's decision, not this file's.
    el.dataset.kind = shape.kind;
    el.append(el2('h2', '', m.title));
    if (!compact) {
        el.append(el2('p', 'what', m.what));
        if (m.made) el.append(el2('div', 'made', m.made));
    }
    const dl = document.createElement('dl');
    const F = S.inspector.fields;
    // The row the file it is stored in pushes down when it arrives: the sha is
    // the key, and where git kept that key's value belongs directly under it.
    let seenSha = false;
    let after: HTMLElement | null = null;
    if (m.facts.length > 0) {
        // The sha is the key the store is addressed by, so it is worth handing
        // over: marked here, copied by whoever owns the clipboard.
        for (const [k, v] of m.facts) {
            const dt = el2('dt', '', k);
            if (k === F.sha) seenSha = true;
            else if (seenSha && !after) after = dt;
            const dd = cell(k, v, F);
            dt.dataset.field = dd.dataset.field = fieldKey(k, F);
            dl.append(dt, dd);
        }
        el.append(dl);
    }
    if (m.raw !== null) {
        el.append(el2('dt', '', S.inspector.heading.contents), el2('pre', '', m.raw));
        return;
    }
    if (!m.body) return;

    const pre = el2('pre', '', S.inspector.reading);
    el.append(el2('dt', '', S.inspector.heading.contents), pre);
    void fetch(`/object?oid=${m.body.oid}`)
        .then((r) => r.json() as Promise<Body>)
        .then((body) => {
            if (mine !== token) return;
            fillContents(pre, body);
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

/** A tree's entries name shas, and a sha is a key you can take — so the seven
 *  characters of each one are clickable, exactly as the sha field is. The rest
 *  of the line is text like any other, and reads and selects as text. */
function fillContents(pre: HTMLElement, body: Body) {
    if (!body.entries) {
        pre.textContent = bodyText(body);
        return;
    }
    pre.replaceChildren(
        ...body.entries.map((x) => {
            const sha = el2('span', 'sha', x.oid.slice(0, 7));
            sha.dataset.copy = x.oid;
            // The line is its own element so that hovering the sha can light the
            // whole of it: which name the key belongs to is the thing being read.
            const line = el2('span', 'entry', '');
            line.append(`${x.mode} ${x.type} `, sha, `\t${x.name}`);
            return line;
        }),
    );
}

/** A fact's name in the strings rather than its words — what a row is hidden
 *  by has to hold in every language. */
function fieldKey(label: string, F: Record<string, string>): string {
    return Object.keys(F).find((n) => F[n] === label) ?? '';
}

/**
 * One field's value. Words are words; a single key fills the field, as the sha
 * does, because a path is read; the keys a commit holds sit side by side, each
 * no wider than the seven characters it shows.
 *
 * `shas`, not `keys` — the help dialog's keyboard keys own that class, and its
 * rule reaches any child of one.
 */
function cell(label: string, v: string | Key | Key[], F: { sha: string }): HTMLElement {
    if (typeof v === 'string') return el2('dd', label === F.sha ? 'sha' : '', v);
    if (!Array.isArray(v)) {
        const dd = el2('dd', 'sha', v.short);
        dd.dataset.copy = v.full;
        return dd;
    }
    const dd = el2('dd', 'shas', '');
    for (const k of v) {
        const span = el2('span', 'sha key', k.short);
        span.dataset.copy = k.full;
        dd.append(span);
    }
    return dd;
}

/**
 * The file .git keeps it in, shown inside .git — the part a viewer can type —
 * and handing over the whole path on a click, exactly as the sha hands over the
 * key.
 */
function storedIn(dl: HTMLElement, before: HTMLElement | null, gitDir: string, path: string) {
    const F = S.inspector.fields;
    const dt = el2('dt', '', F.file);
    const dd = cell(F.file, { short: path, full: `${gitDir}/${path}` }, F);
    dt.dataset.field = dd.dataset.field = 'file';
    dl.insertBefore(dt, before);
    dl.insertBefore(dd, before);
}

function el2(tag: string, cls: string, text: string): HTMLElement {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    el.textContent = text;
    return el;
}
