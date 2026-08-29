/**
 * Real fixture repositories, built with real plumbing commands.
 *
 * Isolated from the recording gitva keeps in the user's own step directory as
 * well: a test that started a server would otherwise write into it, and load
 * back whatever an earlier run left there.
 *
 * Isolated from the author's global config — which signs commits and tags — by
 * pointing GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM at nothing. Scoped to the
 * throwaway repo; global is never the answer.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Step } from '../src/types.js';

// Every test process gets its own, and takes it away again.
process.env.GITVA_STATE_DIR ??= mkdtempSync(join(tmpdir(), 'gitva-step-'));
process.on('exit', () => rmSync(process.env.GITVA_STATE_DIR!, { recursive: true, force: true }));

const ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_DATE: '1700000000 +0000',
};

export class Repo {
    readonly dir: string;
    constructor() {
        this.dir = mkdtempSync(join(tmpdir(), 'gitva-fixture-'));
        this.git('init', '-q', '-b', 'main');
        this.git('config', 'commit.gpgsign', 'false');
        this.git('config', 'tag.gpgsign', 'false');
    }

    git(...args: string[]): string {
        return execFileSync('git', ['-C', this.dir, ...args], {
            env: ENV,
            encoding: 'utf8',
        }).trim();
    }

    write(name: string, contents: string) {
        writeFileSync(join(this.dir, name), contents);
    }

    dispose() {
        rmSync(this.dir, { recursive: true, force: true });
    }
}

/**
 * A repo built the way the tutorial teaches it: hash an object, update the
 * index, write a tree, commit — plus a branch, a merge, an annotated tag, and
 * a deliberate unreachable object that nothing points at.
 */
export function plumbedRepo(): Repo {
    const r = new Repo();
    r.write('a.txt', 'alpha\n');
    r.write('b.txt', 'beta\n');
    r.git('hash-object', '-w', 'a.txt');
    r.git('hash-object', '-w', 'b.txt');
    r.git('update-index', '--add', 'a.txt', 'b.txt');
    const tree = r.git('write-tree');
    const first = r.git('commit-tree', tree, '-m', 'the first commit');
    r.git('update-ref', 'refs/heads/main', first);

    // A directory, so there is a tree inside a tree.
    mkdirSync(join(r.dir, 'lib'), { recursive: true });
    r.write('lib/c.txt', 'alpha\n'); // same contents as a.txt: one blob, two names
    r.git('add', 'lib/c.txt');
    const tree2 = r.git('write-tree');
    const second = r.git('commit-tree', tree2, '-p', first, '-m', 'a nested tree');
    r.git('update-ref', 'refs/heads/main', second);

    // A side branch and a merge, so the lanes have something to do.
    r.write('d.txt', 'delta\n');
    r.git('update-index', '--add', 'd.txt');
    const sideTree = r.git('write-tree');
    const side = r.git('commit-tree', sideTree, '-p', first, '-m', 'a side branch');
    r.git('update-ref', 'refs/heads/side', side);
    const mergeTree = r.git('write-tree');
    const merge = r.git('commit-tree', mergeTree, '-p', second, '-p', side, '-m', 'a merge');
    r.git('update-ref', 'refs/heads/main', merge);
    r.git('symbolic-ref', 'HEAD', 'refs/heads/main');
    r.git('read-tree', mergeTree);

    r.git('tag', '-a', 'v1', '-m', 'the first release', merge);

    // The unreachable object: a blob written into the object database and never referenced.
    r.write('unreachable.txt', 'nobody points at me\n');
    r.git('hash-object', '-w', 'unreachable.txt');

    return r;
}

/**
 * An empty but valid step, for the tests that are about what gitva *says*
 * rather than about what git did — the inspector, the counts, the explanations.
 * Fill in only the part being asked about.
 */
export function fakeStep(extra: Partial<Step> = {}): Step {
    return {
        seq: 1,
        time: 0,
        repo: 'fake',
        gitDir: '/tmp/fake/.git',
        head: { ref: 'refs/heads/main', oid: 'a'.repeat(40), detached: false, unborn: false },
        refs: [],
        objects: {},
        commits: {},
        trees: {},
        tags: {},
        index: [],
        unreachable: [],
        capabilities: {
            objectCount: 10,
            looseCount: 10,
            refCount: 1,
            fullLoad: true,
            indexShapes: true,
            commitGraph: false,
            limits: { fullLoad: 60_000, indexShapes: 400 },
        },
        window: { commits: [], totalCommits: 0, more: false, refsOutside: 0 },
        notes: [],
        ...extra,
    };
}

// ---------------------------------------------------------------------------
// The smallest browser `web/canvas.ts` will run in
// ---------------------------------------------------------------------------

/**
 * A canvas context that records nothing and refuses nothing. Painting is checked
 * by looking at it; this is here so the branches that decide *what* to paint are
 * walked, and so is the easing that tells the canvas whether to ask for another
 * frame.
 */
export function fakeCtx(): CanvasRenderingContext2D {
    const it: Record<string, unknown> = {
        globalAlpha: 1,
        lineWidth: 1,
        font: '',
        fillStyle: '',
        strokeStyle: '',
        textAlign: 'left',
        measureText: (s: string) => ({ width: s.length * 7 }),
    };
    return new Proxy(it, {
        get: (t, k) => (k in t ? t[k as string] : () => {}),
        set: (t, k, v) => ((t[k as string] = v), true),
    }) as unknown as CanvasRenderingContext2D;
}

/** What a synthetic gesture carries, with the blanks a real event would fill. */
export interface FakeEvent {
    button: number;
    pointerId: number;
    clientX: number;
    clientY: number;
    timeStamp: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    deltaX: number;
    deltaY: number;
    preventDefault: () => void;
}

/**
 * An element, in the smallest possible print: enough for a canvas to be mounted
 * in, sized, listened to and dragged on. Only what `web/canvas.ts` actually
 * reaches for — a stub that grows past that is a second browser to maintain.
 */
export class FakeElement {
    style: Record<string, string> = {};
    clientWidth = 900;
    clientHeight = 600;
    width = 0;
    height = 0;
    readonly children: FakeElement[] = [];
    parent: FakeElement | null = null;
    readonly ownerDocument = { createElement: () => new FakeCanvas() };
    private readonly handlers: Record<string, ((e: FakeEvent) => void)[]> = {};

    addEventListener(type: string, f: (e: FakeEvent) => void, opts?: { signal?: AbortSignal }) {
        (this.handlers[type] ??= []).push(f);
        opts?.signal?.addEventListener('abort', () => {
            this.handlers[type] = this.handlers[type].filter((h) => h !== f);
        });
    }

    append(child: FakeElement) {
        this.children.push(child);
        child.parent = this;
    }

    remove() {
        const at = this.parent?.children.indexOf(this) ?? -1;
        if (this.parent && at >= 0) this.parent.children.splice(at, 1);
        this.parent = null;
    }

    getBoundingClientRect() {
        return { left: 0, top: 0 };
    }

    setPointerCapture() {}

    getContext() {
        return fakeCtx();
    }

    /** One gesture, from a test. */
    fire(type: string, e: Partial<FakeEvent> = {}) {
        const event: FakeEvent = {
            button: 0,
            pointerId: 1,
            clientX: 0,
            clientY: 0,
            timeStamp: 0,
            shiftKey: false,
            ctrlKey: false,
            metaKey: false,
            deltaX: 0,
            deltaY: 0,
            preventDefault: () => {},
            ...e,
        };
        for (const f of [...(this.handlers[type] ?? [])]) f(event);
    }

    /** Whether anything is still listening — what `destroy()` has to leave behind. */
    get listening(): boolean {
        return Object.values(this.handlers).some((h) => h.length > 0);
    }
}

/** A `<canvas>`, told apart from any other element by `instanceof`, exactly as
 *  `mount` tells them apart. */
export class FakeCanvas extends FakeElement {}

class FakeResizeObserver {
    static readonly all: FakeResizeObserver[] = [];
    private live = true;
    constructor(private readonly f: () => void) {
        FakeResizeObserver.all.push(this);
    }
    observe() {}
    disconnect() {
        this.live = false;
    }
    fire() {
        if (this.live) this.f();
    }
}

/** The globals, and what a test has to be able to do to them: let a frame
 *  happen, let time pass, and change the size of the element. */
export interface Browser {
    /** Every frame asked for since the last call, run once. */
    paint(): void;
    /** Time passing, for the fades and for the flash. */
    advance(ms: number): void;
    /** The element changed size. */
    resize(): void;
    /** Frames still wanted — zero is what "idle costs nothing" looks like. */
    readonly pending: number;
    /** Read as a canvas is built, so set it before mounting one. */
    reduceMotion: boolean;
}

/** Install them. `web/render.ts` keeps where each shape was last painted in one
 *  module-level map — a page has one canvas — so a test that mounts a second one
 *  destroys the first, or the two ease the same shape towards two places for
 *  ever. */
export function browser(): Browser {
    const g = globalThis as unknown as {
        HTMLCanvasElement: unknown;
        devicePixelRatio: number;
        matchMedia: (q: string) => { matches: boolean };
        requestAnimationFrame: (f: () => void) => number;
        ResizeObserver: unknown;
    };
    let queue: (() => void)[] = [];
    let clock = 0;
    const api: Browser = {
        paint() {
            const run = queue;
            queue = [];
            for (const f of run) f();
        },
        advance(ms) {
            clock += ms;
        },
        resize() {
            for (const o of FakeResizeObserver.all) o.fire();
        },
        get pending() {
            return queue.length;
        },
        reduceMotion: false,
    };
    g.HTMLCanvasElement = FakeCanvas;
    g.devicePixelRatio = 2;
    g.matchMedia = () => ({ matches: api.reduceMotion });
    g.requestAnimationFrame = (f) => queue.push(f);
    g.ResizeObserver = FakeResizeObserver;
    performance.now = () => clock;
    return api;
}
