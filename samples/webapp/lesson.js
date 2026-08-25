/**
 * The whole sample: a canvas, a list of steps, and a sentence about each.
 *
 * Nothing here talks to a server or to git. A step is what git did, so steps
 * recorded once — `steps.json`, taken off a gitva session with the recipe in
 * the README and shortened to what each command added — draw exactly as they
 * did on the day they were recorded.
 */

import { mount } from 'gitva/canvas';

import { fill } from './steps.js';

/** One per step in `steps.json`, in the order the commands were run. */
const SLIDES = [
    {
        command: 'git init',
        says: 'An empty repository. HEAD is a pointer, and it already names a branch that does not exist yet: nothing has been written, so there is nothing for it to hold.',
    },
    {
        command: 'git hash-object -w hello.txt',
        says: 'The file is stored as a blob, keyed by the sha of its own content. Nothing points at it, so it is drawn as a ghost — unreachable. git is a key-value store, and this is the store.',
    },
    {
        command: 'git add hello.txt',
        says: 'add writes an index entry: mode, path, sha. The index sits beside the object graph, not in it, which is why staging something does not make it reachable.',
    },
    {
        command: 'git commit -m "the first commit"',
        says: 'Two objects at once. A tree, which is the index made nested, and a commit holding that tree’s sha. refs/heads/main is a pointer, and it now holds the commit’s sha.',
    },
    {
        command: 'git add index-notes.txt',
        says: 'A second blob, and a second index entry. The index is flat — full paths, sorted — and it caches enough about each file that status need not re-hash your working tree.',
    },
    {
        command: 'git reset index-notes.txt',
        says: 'The index entry goes. The blob does not: an object is never edited and never removed by staging. Nothing points at it any more, so it is unreachable again.',
    },
    {
        command: 'git add index-notes.txt && git commit -m "a second commit"',
        says: 'A commit points at its parent and at a whole tree, not at a change. The first tree survives, whole, and both commits reach the blob they share.',
    },
    {
        command: 'git branch experiment',
        says: 'No object was written. A branch is a name holding a sha, living outside every object — which is exactly why a branch can move and an object cannot.',
    },
    {
        command: 'git tag -a v1 -m "first release"',
        says: 'An annotated tag is both at once: an object, with a message and a hash of its own, and a pointer at that object. That is the whole difference between it and a branch.',
    },
];

const steps = fill(await fetch('./steps.json').then((r) => r.json()));

const $ = (id) => document.getElementById(id);
const selected = $('selected');
const NOTHING_SELECTED = 'Click anything to read what it is.';

const canvas = mount($('graph'), {
    settings: { expandNewCommits: true },
    onSelect: (shape) => {
        // Built, not interpolated: a label is a branch name or a path out of
        // someone's repository, and that is not markup.
        selected.replaceChildren();
        if (!shape) return void (selected.textContent = NOTHING_SELECTED);
        const kind = document.createElement('b');
        kind.textContent = shape.kind;
        selected.append(kind, ` ${shape.label}`, document.createElement('br'), shape.oid ?? '');
    },
});

let at = -1;

/** Stand on slide `i`. Steps are shown as they are reached, so the canvas holds
 *  what the lesson has walked through and nothing it has not. */
function go(i) {
    at = Math.max(0, Math.min(i, SLIDES.length - 1));
    for (let s = canvas.recording.steps.length; s <= at; s++) canvas.show(steps[s]);
    // A step just shown is already the one on screen; going back is the jump.
    if (canvas.recording.cursor !== at) canvas.goto(at);

    $('count').textContent = `step ${at + 1} of ${SLIDES.length}`;
    $('command').textContent = SLIDES[at].command;
    $('says').textContent = SLIDES[at].says;
    $('back').disabled = at === 0;
    $('next').disabled = at === SLIDES.length - 1;
}

// Everything gitva's own toolbars do, a page of your own can do too — and
// `resetView` is the only way back from a canvas something has been dragged off
// the edge of.
$('reset').addEventListener('click', () => canvas.resetView());

const index = $('index');
const showIndex = () => index.setAttribute('aria-pressed', String(canvas.recording.view.showIndex));
index.addEventListener('click', () => {
    canvas.setView({ showIndex: !canvas.recording.view.showIndex });
    showIndex();
});
showIndex();

let open = false;
$('expand').addEventListener('click', () => {
    open = !open;
    if (open) canvas.expandAll();
    else canvas.collapseAll();
    $('expand').textContent = open ? 'collapse all' : 'expand all';
});

$('back').addEventListener('click', () => go(at - 1));
$('next').addEventListener('click', () => go(at + 1));
addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') go(at - 1);
    if (e.key === 'ArrowRight') go(at + 1);
});

selected.textContent = NOTHING_SELECTED;
go(0);
