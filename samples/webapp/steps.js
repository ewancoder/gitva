/**
 * `steps.json`, expanded into the whole steps the canvas is handed.
 *
 * A step is what git did, and gitva's server sends a whole one every time —
 * every object, the whole index, every ref — so a browser can draw any view of
 * it without asking for more. Recorded verbatim, this lesson is nine steps
 * restating the same seven objects: a poor thing to read and a worse thing to
 * edit. So `steps.json` says only what each command added, and this fills the
 * rest back in.
 *
 * Each rule below is a fact about git rather than a trick of the file: an
 * object is never unwritten, so objects, commits, trees and tags carry forward;
 * a tree entry's kind follows from its mode; and HEAD holds a ref name, so what
 * it points at is whatever that ref holds. Anything a step spells out for
 * itself wins — which is why the first one spells out everything as a
 * reference, and why a recording taken straight off the event stream still
 * draws.
 */

const HEAD = 'refs/heads/main';
const WHO = 'gitva <gitva@example.com>';
/** One author date for the whole lesson: it is scenery, not a lesson. */
const WHEN = 1767261600000;
/** When the commands were typed. A step a second and a bit, as it was recorded. */
const CLOCK = 1787620895151;

/** What `measure()` found: a repository small enough for everything to be on offer. */
const CAPABILITIES = {
    objectCount: 0,
    looseCount: 0,
    refCount: 0,
    fullLoad: true,
    indexShapes: true,
    commitGraph: false,
    limits: { fullLoad: 12000, indexShapes: 400 },
};

/** git's modes. Everything else — 100644, 100755, 120000 — is a blob. */
const KIND = { 40000: 'tree', 160000: 'commit' };

const mapValues = (o, f) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v, k)]));

/** @param {any[]} recorded @returns {any[]} whole steps, in order */
export function fill(recorded) {
    const kept = { objects: {}, commits: {}, trees: {}, tags: {} };
    return recorded.map((step, i) => {
        const said = { ...step };
        for (const key of Object.keys(kept)) {
            Object.assign(kept[key], said[key]);
            delete said[key];
        }
        const { refs = [], index = [], unreachable = [], stagedOnly = [], ...rest } = said;

        const trees = mapValues(kept.trees, (entries) =>
            entries.map(({ mode = '100644', type = KIND[mode] ?? 'blob', ...entry }) => ({
                mode,
                type,
                ...entry,
            })),
        );
        const commits = mapValues(kept.commits, (commit, oid) => ({
            oid,
            parents: [],
            author: WHO,
            authorDate: WHEN,
            committer: WHO,
            committerDate: WHEN,
            message: `${commit.subject}\n`,
            ...commit,
        }));
        const tags = mapValues(kept.tags, (tag, oid) => ({
            oid,
            targetType: 'commit',
            tagger: WHO,
            ...tag,
        }));
        // A sha and a size is all `cat-file --batch-check` says; the kind is
        // whichever of the four the content turned out to be.
        const kindOf = (oid) =>
            commits[oid] ? 'commit' : trees[oid] ? 'tree' : tags[oid] ? 'tag' : 'blob';
        const objects = mapValues(kept.objects, (size, oid) =>
            typeof size === 'object' ? size : { oid, size, type: kindOf(oid) },
        );
        // Newest first, which is the order they were declared in, reversed: a
        // commit is written after the parent it points at.
        const window = Object.keys(commits).reverse();
        const branch = refs.find((r) => r.name === HEAD);

        return {
            seq: i + 1,
            time: CLOCK + i * 1200,
            repo: 'lesson',
            gitDir: '/home/you/lesson/.git',
            head: { ref: HEAD, oid: branch?.oid, detached: false, unborn: branch === undefined },
            refs: refs.map((ref) => ({ objectType: 'commit', packed: false, ...ref })),
            objects,
            commits,
            trees,
            tags,
            index: index.map((entry) => ({ mode: '100644', stage: 0, ...entry })),
            unreachable,
            stagedOnly,
            capabilities: CAPABILITIES,
            window: { commits: window, totalCommits: window.length, more: false, refsOutside: 0 },
            notes: ['bodiesOnSelection'],
            ...rest,
        };
    });
}
