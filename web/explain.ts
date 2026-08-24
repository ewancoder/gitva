/**
 * The teaching. Point at anything and learn what that file in .git actually
 * does, and which command creates it. Pure, so it can be tested without a
 * browser — and the wording itself lives in `src/localization/languages/en.ts`, which is
 * where you fix it.
 */

import { S } from './localization/index.js';
import type { Step } from '../src/types.js';

export interface Explanation {
    title: string;
    what: string;
    made: string;
    facts: [string, string][];
}

export function explainKind(kind: string): { title: string; what: string; made: string } {
    const kinds: Record<string, { title: string; what: string; made: string }> = S.inspector.kinds;
    return kinds[kind] ?? { title: kind, what: S.inspector.unexplained, made: '' };
}

const short = (oid: string) => oid.slice(0, 7);
const bytes = (n: number) =>
    n < 1024 ? S.inspector.size.bytes(n) : S.inspector.size.kib((n / 1024).toFixed(1));

/** Everything the inspector says about one selected shape. */
export function explain(step: Step, kind: string, id: string): Explanation {
    let base = explainKind(kind);
    const F = S.inspector.fields;
    const V = S.inspector.values;
    const facts: [string, string][] = [];

    if (kind === 'commit' || kind === 'tree' || kind === 'blob' || kind === 'tag') {
        const obj = step.objects[id];
        facts.push([F.sha, id]);
        if (obj) facts.push([F.size, bytes(obj.size)]);
        if (step.unreachable?.includes(id)) {
            facts.push([F.reachable, V.unreachable]);
        } else if (step.stagedOnly?.includes(id)) {
            facts.push([F.reachable, V.stagedOnly]);
        }
    }

    if (kind === 'commit') {
        const c = step.commits[id];
        if (c) {
            facts.push([F.tree, short(c.tree)]);
            facts.push([
                F.parents,
                c.parents.length ? c.parents.map(short).join(', ') : V.noParents,
            ]);
            facts.push([F.author, c.author]);
            if (c.authorDate) facts.push([F.authored, new Date(c.authorDate).toLocaleString()]);
            facts.push([F.message, c.message.trim()]);
        }
    } else if (kind === 'tree') {
        const entries = step.trees[id];
        if (entries) facts.push([F.entries, String(entries.length)]);
    } else if (kind === 'tag') {
        const t = step.tags[id];
        if (t) {
            facts.push([F.tagName, t.name]);
            facts.push([F.pointsAt, V.pointsAt(t.targetType, short(t.target))]);
            facts.push([F.tagger, t.tagger]);
            facts.push([F.message, t.message.trim()]);
        }
    } else if (kind === 'ref') {
        const r = step.refs.find((x) => x.name === refName(id));
        if (r) {
            // The chip in the gutter can only ever show a shortened name, so the
            // full one has to live here.
            facts.push([F.name, r.name]);
            facts.push([F.file, `${step.gitDir}/${r.name}`]);
            facts.push([F.contains, r.oid]);
            if (r.target) facts.push([F.peelsTo, r.target]);
            facts.push([F.stored, r.packed ? V.packed : V.loose]);
        }
    } else if (kind === 'head') {
        facts.push([F.file, `${step.gitDir}/HEAD`]);
        if (step.head.unborn) {
            facts.push([F.contains, V.unborn(step.head.ref ?? '')]);
        } else if (step.head.detached) {
            facts.push([F.contains, V.detached(step.head.oid ?? '')]);
        } else {
            facts.push([F.contains, V.headRef(step.head.ref ?? '')]);
            facts.push([F.resolvesTo, step.head.oid ?? '']);
        }
    } else if (kind === 'index') {
        const e = indexEntry(step, id);
        if (e) {
            // A gitlink is the one entry that stages something this database does
            // not have — so it is taught as what it is, and its sha is a commit's.
            if (isGitlink(e)) base = explainKind('indexSubmodule');
            facts.push([F.path, e.path]);
            facts.push([isGitlink(e) ? F.commit : F.blob, e.oid]);
            facts.push([F.mode, e.mode]);
            if (e.stage !== 0) facts.push([F.stage, V.conflictStage(e.stage)]);
        }
    }

    return { ...base, facts };
}

export const entryId = (path: string, stage: number) => `index:${stage}:${path}`;

/** The entry a scene shape in the index column stands for. */
export const indexEntry = (step: Step, id: string) =>
    step.index.find((x) => entryId(x.path, x.stage) === id);

/** Mode 160000: a submodule's commit, which lives in another repository. */
export const isGitlink = (e?: { mode: string }) => e?.mode === '160000';

/** Scene shapes for refs are keyed `ref:<full name>`; the lookups want the name. */
export const refName = (id: string) => id.replace(/^ref:/, '');
