/**
 * The teaching. Point at anything and learn what that file in .git actually
 * does, and which command creates it. Pure, so it can be tested without a
 * browser — and the wording itself lives in `src/localization/languages/en.ts`, which is
 * where you fix it.
 */

import { S } from './localization/index.js';
import type { Step } from '../src/types.js';

/** Something shown short and handed over whole: a sha as its first seven
 *  characters, a file as the part of the path you can type after `.git/`. */
export interface Key {
    short: string;
    full: string;
}

/** One row of the inspector: what it is called, and what it says — plain words,
 *  one key, or the keys it holds, a commit's parents being one row however many
 *  there are. */
export type Fact = [label: string, value: string | Key | Key[]];

export interface Explanation {
    title: string;
    what: string;
    made: string;
    facts: Fact[];
}

export function explainKind(kind: string): { title: string; what: string; made: string } {
    const kinds: Record<string, { title: string; what: string; made: string }> = S.inspector.kinds;
    return kinds[kind] ?? { title: kind, what: S.inspector.unexplained, made: '' };
}

const short = (oid: string) => oid.slice(0, 7);
const when = (ms: number) => new Date(ms).toLocaleString();
const key = (oid: string): Key => ({ short: short(oid), full: oid });
/** Shown inside .git — the part you can type — and copied whole. */
const inGitDir = (gitDir: string, path: string): Key => ({
    short: path,
    full: `${gitDir}/${path}`,
});
const bytes = (n: number) =>
    n < 1024 ? S.inspector.size.bytes(n) : S.inspector.size.kib((n / 1024).toFixed(1));

/** Every distinct mode this step's tree entries and index entries give an object. */
function modesFor(step: Step, oid: string): string {
    const modes = new Set<string>();
    for (const entries of Object.values(step.trees))
        for (const e of entries) if (e.oid === oid) modes.add(e.mode);
    for (const e of step.index) if (e.oid === oid) modes.add(e.mode);
    return [...modes].sort().join(', ');
}

/** Everything the inspector says about one selected shape. */
/** The sha behind a tag object's scene id. Anything else is a sha already. */
const tagOid = (id: string) => (id.startsWith('tag:') ? id.slice(4) : id);

export function explain(step: Step, kind: string, id: string): Explanation {
    let base = explainKind(kind);
    // The scene keys a tag object `tag:<oid>` so it cannot collide with the ref of
    // the same name. Everything git knows is keyed by the sha alone — and the sha
    // is what a click hands you, so it is what is shown.
    id = tagOid(id);
    const F = S.inspector.fields;
    const V = S.inspector.values;
    const facts: Fact[] = [];
    const c = kind === 'commit' ? step.commits[id] : undefined;

    if (kind === 'commit' || kind === 'tree' || kind === 'blob' || kind === 'tag') {
        const obj = step.objects[id];
        facts.push([F.sha, id]);
        // The keys a commit holds sit beside its own, because they are the same
        // kind of thing: shas you take away and hand to the next command. Short,
        // because a column of forty characters is not read, it is scrolled.
        if (c) {
            facts.push([F.tree, [key(c.tree)]]);
            // A merge's two parents are two keys in one row: each is taken on its
            // own, and neither is a string with a comma in it.
            facts.push([F.parents, c.parents.length ? c.parents.map(key) : V.noParents]);
        }
        if (obj) facts.push([F.size, bytes(obj.size)]);
        // A mode belongs to the entry that names an object, never to the object —
        // the same blob is 100644 under one tree and 100755 under another — so
        // what is shown is every mode anything in this step names it with. A
        // commit has one only when a tree entry stages it: a submodule.
        const modes = modesFor(step, id);
        if (modes) facts.push([F.mode, modes]);
        if (step.unreachable?.includes(id)) {
            facts.push([F.reachable, V.unreachable]);
        } else if (step.stagedOnly?.includes(id)) {
            facts.push([F.reachable, V.stagedOnly]);
        }
    }

    if (kind === 'commit') {
        if (c) {
            facts.push([F.author, c.author]);
            if (c.authorDate) facts.push([F.authored, when(c.authorDate)]);
            // Who wrote it and who committed it are the same person until a rebase,
            // an amend or an applied patch makes them two — which is the moment
            // worth showing, so they are shown only then.
            // A date of 0 is one this step never carried — a recording from an
            // older gitva — and something unknown is not something different.
            const moved = c.committerDate > 0 && c.committerDate !== c.authorDate;
            if (c.committer !== c.author || moved) {
                facts.push([F.committer, c.committer]);
                if (c.committerDate) facts.push([F.committed, when(c.committerDate)]);
            }
        }
    } else if (kind === 'tree') {
        const entries = step.trees[id];
        if (entries) facts.push([F.entries, String(entries.length)]);
    } else if (kind === 'tag') {
        const t = step.tags[id];
        if (t) {
            facts.push([F.tagName, t.name]);
            // What it says names the kind, because a tag can point at any of them;
            // what it hands over is the sha alone, which is what a command takes.
            facts.push([
                F.pointsAt,
                { short: V.pointsAt(t.targetType, short(t.target)), full: t.target },
            ]);
            facts.push([F.tagger, t.tagger]);
            // The message is read out under `contents`, where its length is nobody's
            // problem — the same reason a commit's is not a field either.
        }
    } else if (kind === 'ref') {
        const r = step.refs.find((x) => x.name === refName(id));
        if (r) {
            // A ref is a file, so the file leads: its path under .git *is* its
            // full name, which leaves `name` to say the part you type.
            // A packed ref has no file of its own — `stored` is what says where it
            // went — so there is no path here to hand over.
            if (!r.packed) facts.push([F.file, inGitDir(step.gitDir, r.name)]);
            // Where the ref ends up once the tag object in between is followed —
            // the same second hop HEAD makes, so it says the same thing. What the
            // ref itself contains is the file, read out under `contents` below.
            if (r.target) facts.push([F.resolvesTo, { short: r.target, full: r.target }]);
            facts.push([F.name, r.name.replace(/^refs\/(heads|tags|remotes)\//, '')]);
            facts.push([F.stored, r.packed ? V.packed : V.loose]);
        }
    } else if (kind === 'head') {
        facts.push([F.file, inGitDir(step.gitDir, 'HEAD')]);
        // What HEAD holds is the file, read out under `contents`. Where that ends
        // up is not in the file at all — the branch it names holds the sha — and
        // that second hop is the whole of what HEAD teaches, so it is the one
        // thing said here. Detached, there is no hop and no row.
        const at = step.head.oid;
        if (!step.head.detached && at) facts.push([F.resolvesTo, { short: at, full: at }]);
    } else if (kind === 'index') {
        const e = indexEntry(step, id);
        if (e) {
            // A gitlink is the one entry that stages something this database does
            // not have — so it is taught as what it is, and its sha is a commit's.
            if (isGitlink(e)) base = explainKind('indexSubmodule');
            // The sha leads, as it does on an object: an entry is a mode, a name
            // and a key, and the key is the part you take away. A gitlink's is a
            // commit's, which the title and mode 160000 already say.
            facts.push([F.sha, e.oid]);
            facts.push([F.path, e.path]);
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
