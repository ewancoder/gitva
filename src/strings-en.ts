/**
 * English. **Every user-facing string lives here** — the toolbars, the
 * tooltips, the help, the teaching text, the notes, what the CLI prints.
 * Nothing here is code you have to understand: it is text you can rewrite.
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
 * To add a language: copy this file to `src/strings-<code>.ts`, translate the
 * right-hand sides, and point `src/strings.ts` at it. The type comes from this
 * file, so a translation that forgets an entry fails the build.
 *
 * Keep the vocabulary in CLAUDE.md: object, pointer, tree, blob, commit,
 * index, unreachable are git's own words, and gitva does not improve on them.
 */

export const en = {
  // -------------------------------------------------------------------------
  // The chrome: keyed from web/index.html
  // -------------------------------------------------------------------------
  ui: {
    'recording-id.title':
      'What this recording is filed under. Click to copy: `gitva --id <it>` picks the same recording up from anywhere',

    'question.title': 'What this view is asking',
    'question.all': 'everything',
    'question.branches': 'branches…',
    'question.message': 'search: message',
    'question.author': 'search: author',
    'question.path': 'search: path',
    'question.content': 'search: content',
    'search.placeholder': 'search',

    'load-all': 'load all commits',
    'load-all.title': 'Load the whole history, not just the first page',
    'expand-all': 'expand all',
    'expand-all.title': 'Expand every commit (double-click one commit for just it)',
    'collapse-all': 'collapse all',
    'collapse-all.title': 'Collapse everything back to the commit DAG',
    index: 'index',
    'index.title': 'The index is the sandbox beside the object graph',
    unreachable: 'unreachable',
    'unreachable.title': 'Objects nothing points at — still in the object database either way',
    'cross-links': 'links from unreachable',
    'cross-links.title':
      "What unreachable objects still point at: a tree's entries, and a discarded commit's parent. Nothing points at them; they still point at plenty",
    help: 'help',
    settings: 'settings',

    'reset-view': 'reset view',
    'reset-view.title':
      'Send everything you dragged, and every widened column, back to where the layout puts it',
    'step-back.title': 'Previous step',
    'pause.title': 'Pause following new steps',
    'step-forward.title': 'Next step',
    clear: 'clear',
    'clear.title': 'Throw away every recorded step and start again at the repository as it is now',

    'help.title': 'what you are looking at',
    'help.lede': 'A live object graph of a repository.',
    'help.legend.commit': 'commit',
    'help.legend.tree': 'tree',
    'help.legend.blob': 'blob',
    'help.legend.staged': 'staged blob',
    'help.legend.ref': 'ref / HEAD',
    'help.legend.tag': 'annotated tag',
    'help.legend.index': 'index entry',
    'help.legend.unreachable': 'unreachable',
    'help.legend.changed': 'just changed',
    'help.keyboard': 'keyboard',
    'help.keys.wheel': 'wheel',
    'help.keys.wheel.does': 'pan · hold <kbd>ctrl</kbd> to zoom',
    'help.keys.dragBackground': 'drag background',
    'help.keys.dragBackground.does': 'pan',
    'help.keys.doubleBackground': 'double-click background',
    'help.keys.doubleBackground.does': 'fit the canvas to the width again',
    'help.keys.click': 'click',
    'help.keys.click.does': 'select it — read what it is, and copy its sha',
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
    'help.keys.seam': 'drag a column seam',
    'help.keys.seam.does': 'widen that column (“reset view” puts it back)',
    'help.keys.fit.does': 'the same fit, from the keyboard',
    'help.keys.index.does': 'show or hide the index',
    'help.keys.back.does': 'step back through the recording',
    'help.keys.forward.does': 'step forward again',
    'help.keys.space.does': 'pause, or go live',
    close: 'close',

    'clear-confirm.title': 'Clear the recording?',
    'clear-confirm.lede':
      'Every step recorded of this repository goes — for every viewer, not just this browser — and the recording starts again at the repository as it is now. Nothing in the repository itself changes: gitva does not write to it.',
    'clear-confirm.yes': 'clear the recording',
    'clear-confirm.no': 'keep it',

    'settings.title': 'settings',
    'settings.lede':
      'These are about how you like to work, not about this session, so they survive a reload.',
    'settings.centreOnClick': 'clicking something centres the view on it',
    'settings.refitOnChange': 'the canvas refits the width when the repository changes',
    'settings.showPins': 'anything you pinned wears a pushpin',
    'settings.openNewCommits': 'a commit git just made arrives expanded',
  },

  // -------------------------------------------------------------------------
  // The canvas: column labels, and the block that loads the rest of history
  // -------------------------------------------------------------------------
  canvas: {
    bands: {
      pointers: 'pointers and tags',
      commits: 'commits',
      objects: 'trees and blobs',
      index: 'index',
    },
    /** What a lightweight tag's chip is prefixed with in the gutter. */
    tagPrefix: 'tag: ',
    /** A collapsed tree looks like an empty one, so it says how much it holds. */
    heldBack: (entries: number) => `tree +${entries}`,
    more: {
      label: 'load more history',
      of: (shown: number, total: number) => `${shown} of ${total} commits`,
      shown: (shown: number) => `${shown} commits shown`,
    },
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
    tallyBig: (drawn: number, commits: number, objects: string, index: number) =>
      `${drawn} on screen · ${commits} commits · ${objects} objects · ${index} index`,
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
    noUnreachableDetection: (objects: string) =>
      `Unreachable detection is off: ${objects} objects, and finding an unreachable object means reading every one. Everything drawn here is reachable by construction.`,
    treesOnDemand: 'Trees load only for the commits you expand — nothing walks the object database.',
    indexElided: (shown: number, total: number) =>
      `Index: showing the ${shown} entries that differ from HEAD, of ${total} staged paths.`,
    more: (shown: number) => `Showing ${shown} commits — click "load more history" for the rest.`,
    refsOutside: (n: number) => `${n} refs point outside this window and are left out.`,
    indexHidden: 'The index is hidden.',
    unreachableHidden:
      'Unreachable objects are hidden — they are still in the object database.',
    noCommitGraph:
      'This repo has no commit-graph. `git commit-graph write --reachable` would make walking history much faster — gitva will not write it for you.',
    looseObjects: (loose: string) =>
      `${loose} loose objects. \`git gc\` would pack them — gitva will not run it for you.`,
    bodiesOnSelection:
      'Object contents are fetched when you select something, not shipped every update.',
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
      path: 'path',
      blob: 'blob',
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
        made: 'git write-tree  (from the index)',
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
      more: {
        title: 'Load more history',
        what: 'These commits have parents that are real, but outside the window gitva asked for. The link is drawn honestly into here rather than pointing at an object that is not on screen. Click this block to load the rest of the history.',
        made: 'git rev-list -n <more>',
      },
    },
  },

  // -------------------------------------------------------------------------
  // The terminal, and the one trouble the browser is told about in words
  // -------------------------------------------------------------------------
  cli: {
    watching: (repo: string, url: string) => `gitva watching ${repo}\n${url}\n`,
    serving: (host: string, port: number) =>
      `serving ${host}:${port} to the network — no auth\n`,
  },
  server: {
    noRepo: (path: string) => `no repository at ${path} yet — waiting for \`git init\``,
  },
};
