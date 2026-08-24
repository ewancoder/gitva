/** AI-assisted. */
/**
 * English. **Every string the browser shows lives here** — the toolbars, the
 * tooltips, the help, the teaching text, the notes. Nothing here is code you
 * have to understand: it is text you can rewrite.
 *
 * What the *server* prints is not here and is not translated: it goes to a
 * terminal the viewer never sees, in a process with no way to be told which
 * language to use. Those sentences sit in `src/cli.ts` and `src/server.ts`,
 * where they are printed.
 *
 * Two shapes, and only two:
 *
 *   `ui`      one flat entry per `data-t` / `data-t-title` / `data-t-placeholder`
 *             key in `web/index.html`. The key is on the element; the words are
 *             here. `data-t-html` entries may hold `<kbd>` and nothing else.
 *   the rest  what code asks for by name. A plain string, or an arrow function
 *             when a number or a name has to sit inside the sentence — edit
 *             between the backticks and leave the `${...}` holes where they
 *             are, though you may reorder them.
 *
 * To add a language: copy this file to `src/localization/languages/<code>.ts`, translate
 * the right-hand sides, and register it in `src/localization/index.ts`. The
 * type comes from this file, so a forgotten entry fails the build.
 *
 * Keep the vocabulary in CLAUDE.md: object, pointer, tree, blob, commit,
 * index, unreachable are git's own words, and gitva does not improve on them.
 */

export const en = {
    // -------------------------------------------------------------------------
    // The toolbars and dialogs: keyed from web/index.html
    // -------------------------------------------------------------------------
    ui: {
        'recording-id.title':
            'Unique ID of a repository recording. Click to copy: `gitva --id ID` picks the same recording up from anywhere',
        'expand-all': 'expand all',
        'expand-all.title':
            'Expand every commit and tree (double-click a commit/tree to expand/collapse)',
        'collapse-all': 'collapse all',
        'collapse-all.title': 'Collapse all commits (trees always stay expanded)',
        index: 'index',
        'index.title': 'Show Index on the right',
        unreachable: 'unreachable',
        'unreachable.title': 'Show unreachable objects',
        'links-from-unreachable': 'links from unreachable',
        'links-from-unreachable.title': 'Show links from unreachable objects to reachable ones',
        names: 'names',
        'names.title': 'Show the names tree entries carry, on the links',
        'theme.title': 'Switch between the light and the dark ground',
        help: 'help',
        settings: 'settings',

        'reset-view': 'reset view',
        'reset-view.title':
            'Send everything you dragged, and every widened column, back to where the layout puts it',
        'step-back.title': 'Previous step',
        'pause.title': 'Pause following live steps',
        'step-forward.title': 'Next step',

        'help.title': 'what you are looking at',
        'help.lede': 'A live object graph of the repository.',
        'help.legend.commit': 'commit',
        'help.legend.tree': 'tree',
        'help.legend.blob': 'blob',
        'help.legend.staged': 'staged blob',
        'help.legend.submodule': 'submodule',
        'help.legend.ref': 'ref / HEAD',
        'help.legend.tag': 'annotated tag',
        'help.legend.index': 'index entry',
        'help.legend.unreachable': 'unreachable',
        'help.legend.changed': 'just changed',
        'help.keyboard': 'keyboard',
        'help.keys.wheel': 'wheel',
        'help.keys.wheel.does': 'scroll up/down · hold <kbd>ctrl</kbd> to zoom',
        'help.keys.dragBackground': 'drag background',
        'help.keys.dragBackground.does': 'pan',
        'help.keys.doubleBackground': 'double-click background',
        'help.keys.doubleBackground.does': 'fit the canvas to the width',
        'help.keys.click': 'click',
        'help.keys.click.does': 'select it — show what it is, and copy its sha',
        'help.keys.rightClick': 'right-click',
        'help.keys.rightClick.does': 'mark it, to follow it as the object graph moves',
        'help.keys.doubleCommit': 'double-click commit',
        'help.keys.doubleCommit.does': 'expand or collapse — show what this commit links to',
        'help.keys.doubleTree': 'double-click tree',
        'help.keys.doubleTree.does': 'expand or collapse that subtree',
        'help.keys.drag': 'drag anything',
        'help.keys.drag.does': 'pin it where you put it (“reset view” drops every pin)',
        'help.keys.shiftClick': 'shift-click it',
        'help.keys.shiftClick.does': 'unpin it again',
        'help.keys.columnEdge': 'drag a column edge',
        'help.keys.columnEdge.does': 'widen that column (“reset view” puts it back)',
        'help.keys.fit.does': 'fit the canvas to the width',
        'help.keys.index.does': 'show or hide the index',
        'help.keys.back.does': 'step back through the recording',
        'help.keys.forward.does': 'step forward through the recording',
        'help.keys.space.does': 'pause, or go live',
        close: 'close',

        'settings.title': 'settings',
        'settings.lede': 'Personal settings for your viewing experience.',
        'settings.centreOnClick': 'clicking something centres the view on it',
        'settings.refitOnChange': 'auto-zoom the view when something happens in the repository',
        'settings.showPins': 'visual pins for everything you moved manually',
        'settings.expandNewCommits': 'new commits expanded by default',
    },

    // -------------------------------------------------------------------------
    // The canvas: the column labels, and what a shape says about itself
    // -------------------------------------------------------------------------
    canvas: {
        columns: {
            pointersAndTags: 'pointers and tags',
            commits: 'commits',
            treesAndBlobs: 'trees and blobs',
            index: 'index',
        },
        /** What a lightweight tag's chip is prefixed with in the gutter. */
        tagPrefix: 'tag: ',
        /** A collapsed tree looks like an empty one, so it says how much it holds. */
        heldBack: (entries: number) => `tree +${entries}`,
    },

    // -------------------------------------------------------------------------
    // Live status: the recording toolbar's right-hand end, and the copy toast
    // -------------------------------------------------------------------------
    status: {
        live: 'live',
        paused: 'paused',
        connecting: 'connecting',
        lost: 'connection lost',
        pause: 'pause',
        goLive: 'go live',
        copied: (what: string) => `copied ${what}`,
        /** What is on screen, and what the repository holds. */
        tally: (
            drawn: number,
            commits: number,
            counts: { commit: number; tree: number; blob: number; tag: number },
            unreachable: number,
            index: number,
        ) =>
            `${drawn} on screen · ${commits} commits` +
            ` · ${counts.commit}c ${counts.tree}t ${counts.blob}b${counts.tag ? ` ${counts.tag}g` : ''}` +
            ` · ${unreachable} unreachable · ${index} index`,
        /** The same line where unreachable detection is off: objects, not kinds. */
        tallyBig: (drawn: number, commits: number, objects: number, index: number) =>
            `${drawn} on screen · ${commits} commits · ${objects.toLocaleString()} objects · ${index} index`,
        stepsDropped: (kept: number, dropped: number) =>
            `Recording: ${kept} steps kept, ${dropped} older ones dropped.`,
    },

    // -------------------------------------------------------------------------
    // What the last step did — the recording toolbar's change line
    // -------------------------------------------------------------------------
    change: {
        first: 'first read',
        none: 'no visible change',
        join: ', ',
        /** `2 blobs, 1 tree` — one entry per kind, then `added` wraps the lot. */
        kind: (n: number, type: string) => `${n} ${type}${n === 1 ? '' : 's'}`,
        added: (kinds: string) => `+${kinds}`,
        gone: (n: number) => `-${n} objects`,
        newRef: (name: string) => `new ref ${name}`,
        refMoved: (name: string, sha: string) => `${name} → ${sha}`,
        refDeleted: (name: string) => `deleted ${name}`,
        headTo: (name: string) => `HEAD → ${name}`,
        headDetached: 'detached',
        headMoved: 'HEAD moved',
        staged: (n: number) => `${n} index ${n === 1 ? 'entry' : 'entries'} added`,
        unstaged: (n: number) => `${n} index ${n === 1 ? 'entry' : 'entries'} gone`,
        nowUnreachable: (n: number) => `${n} now unreachable`,
    },

    // -------------------------------------------------------------------------
    // The notes toolbar: what the canvas is not showing, and why
    // -------------------------------------------------------------------------
    notes: {
        noUnreachableDetection:
            'Unreachable detection is off — this repository has too many objects for it.',
        indexElided: 'The index is showing only the entries that differ from HEAD.',
        more: 'Showing the newest commits — older history is not drawn.',
        refsOutside: 'Some refs point outside this window and are left out.',
        indexHidden: 'The index is hidden.',
        unreachableHidden:
            'Unreachable objects are hidden — they are still in the object database.',
        bodiesOnSelection: 'Object contents are fetched when you select something.',
    },

    // -------------------------------------------------------------------------
    // The inspector: what you selected, and the teaching that goes with it
    // -------------------------------------------------------------------------
    inspector: {
        empty: 'Click anything to find out what it is.',
        reading: 'reading…',
        unreadable: 'could not read it',
        unexplained: 'No explanation written for this yet.',
        heading: {
            entries: 'entries',
            object: 'raw object',
            contents: 'contents',
            raw: 'raw content',
        },
        notText: (size: number) => `${size} bytes, not text.`,
        truncated: (size: number) => `… first 64 KiB of ${size} bytes.`,
        size: {
            bytes: (n: number) => `${n} B`,
            kib: (n: string) => `${n} KiB`,
        },

        /** The field names down the left of the inspector. */
        fields: {
            sha: 'sha',
            size: 'size',
            reachable: 'reachable',
            tree: 'tree',
            parents: 'parents',
            author: 'author',
            authored: 'authored',
            message: 'message',
            entries: 'entries',
            tagName: 'tag name',
            pointsAt: 'points at',
            tagger: 'tagger',
            name: 'name',
            file: 'file',
            contains: 'contains',
            peelsTo: 'peels to',
            resolvesTo: 'resolves to',
            stored: 'stored',
            storedIn: 'stored in',
            path: 'path',
            blob: 'blob',
            commit: 'commit',
            mode: 'mode',
            stage: 'stage',
        },

        values: {
            unreachable:
                'no — nothing points here. It is still in the object database and can be rescued by name until git gc removes it.',
            stagedOnly:
                'only through the index — no commit names it yet. git gc keeps it while it is staged, and unstaging it makes it unreachable.',
            noParents: 'none (root)',
            // git's own word for it, and the reason ours had to give way.
            packed: 'packed — folded into .git/packed-refs, so the file itself is gone',
            loose: 'loose — a real file on disk',
            unborn: (ref: string) =>
                `ref: ${ref} — which does not exist yet. An unborn branch: HEAD names a file that will appear on the first commit.`,
            detached: (oid: string) => `${oid} — detached, a raw sha with no branch in between`,
            headRef: (ref: string) => `ref: ${ref}`,
            pointsAt: (type: string, oid: string) => `${type} ${oid}`,
            conflictStage: (stage: number) =>
                `${stage} — a conflict entry (1 = common ancestor, 2 = ours, 3 = theirs). Resolving writes one clean stage-0 entry in their place.`,
        },

        /** One entry per kind of shape: what it is, and the command that makes it. */
        kinds: {
            blob: {
                title: 'Blob',
                what: "A blob is a file's contents and nothing else — no name, no path, no date, no permissions. Two files with identical contents anywhere in history are the same blob, stored once. The name you know the file by lives in the tree that points here.",
                made: 'git hash-object -w <file>',
            },
            tree: {
                title: 'Tree',
                what: 'A tree is one directory: a sorted list of names, each with a mode and the sha of what it holds — a blob for a file, another tree for a subdirectory. Names live in trees. This is the whole of how git stores a directory.',
                made: 'git write-tree  (from the index), or git mktree',
            },
            commit: {
                title: 'Commit',
                what: 'A commit is a tiny text object: the sha of one tree — the entire project at that moment — plus the shas of its parents, an author, a committer and a message. It stores no diff. The diff is something git works out on demand by comparing two trees.',
                made: 'git commit-tree <tree> -p <parent>',
            },
            tag: {
                title: 'Annotated tag',
                what: 'An annotated tag is a real object: a name, a tagger, a message, and the sha of what it points at. That is nearly a pointer with a story attached, which is why it sits with the pointers here rather than with the objects.',
                made: 'git mktag  /  git tag -a <name>',
            },
            ref: {
                title: 'Ref',
                what: 'A ref is a file with a sha in it. That is the entire mechanism. A branch is a ref under refs/heads that gets rewritten every time you commit; a lightweight tag is a ref under refs/tags that does not. Nothing about a branch is a first-class object.',
                made: 'git update-ref refs/heads/<name> <sha>',
            },
            head: {
                title: 'HEAD',
                what: 'HEAD is a file holding the text "ref: refs/heads/<branch>" — a pointer to a pointer. That indirection is what makes committing move the branch. Detach it and HEAD holds a raw sha instead, which is why commits made there are so easy to lose.',
                made: 'git symbolic-ref HEAD refs/heads/<name>',
            },
            index: {
                title: 'Index entry',
                what: 'The index is a single binary file listing the paths that will go into the next commit, each with a blob sha and a mode. It is the only place a half-staged change exists: not in the working tree, not in any object. Staging writes here; committing turns it into a tree.',
                made: 'git update-index --add <path>',
            },
            indexSubmodule: {
                title: 'Submodule entry',
                what: 'A submodule is one index entry with mode 160000, holding the sha of a commit — and that commit lives in the other repository, not this one. That is the whole of the mechanism: the superproject records which commit of the submodule it wants, and nothing else about it. There are no bytes to read here, because this database does not have that object.',
                made: 'git submodule add <url> <path>',
            },
        },
    },

    /** The buttons in the corner. A language names itself; this says what one does. */
    language: {
        switchTo: (name: string) => `Show gitva in ${name}`,
    },
};
