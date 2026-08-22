/**
 * What changed. This is what makes a plumbing command land — it is not polish.
 *
 * Whole steps are compared, not deltas: bounding the view is what makes
 * sending whole steps affordable, and whole steps are what make this simple.
 * Each step is diffed against whatever is currently on screen, so stepping
 * backwards through the recording highlights the change in reverse — which is how
 * you show a reset twice without doing it twice.
 */

import type { Scene } from './layout.js';
import { S } from './localization/index.js';
import type { Step } from '../src/types.js';

export interface Change {
  added: Set<string>;
  removed: Set<string>;
  moved: Set<string>;
  /** Shapes present in both, but saying something different. */
  updated: Set<string>;
}

export const EMPTY_CHANGE: Change = {
  added: new Set(),
  removed: new Set(),
  moved: new Set(),
  updated: new Set(),
};

export function diffScenes(prev: Scene | null, next: Scene): Change {
  const added = new Set<string>();
  const removed = new Set<string>();
  const moved = new Set<string>();
  const updated = new Set<string>();
  if (!prev) return { added, removed, moved, updated };

  const before = new Map(prev.shapes.map((n) => [n.id, n]));
  const after = new Map(next.shapes.map((n) => [n.id, n]));
  for (const [id, n] of after) {
    const b = before.get(id);
    if (!b) {
      added.add(id);
      continue;
    }
    if (b.x !== n.x || b.y !== n.y) moved.add(id);
    if (b.label !== n.label || b.sub !== n.sub || b.unreachable !== n.unreachable) updated.add(id);
  }
  for (const id of before.keys()) if (!after.has(id)) removed.add(id);

  return { added, removed, moved, updated };
}

/** Whether a diff has anything to show. A step can arrive that draws exactly
 *  the same shapes — `git status` rewrites the index's stat cache, and the
 *  change signal moves — and such a step must not cancel the flash, or a fade,
 *  that the last real change started. `moved` does not count: a column resize
 *  moves everything and changes nothing. */
export function isVisible(c: Change): boolean {
  return c.added.size > 0 || c.removed.size > 0 || c.updated.size > 0;
}

/** The sentence in the recording toolbar: what the last step actually did. */
export function describe(prev: Step | null, next: Step): string {
  const T = S.change;
  if (!prev) return T.first;
  const parts: string[] = [];

  const objs = (s: Step) => new Set(Object.keys(s.objects));
  const [a, b] = [objs(prev), objs(next)];
  const newObjects = [...b].filter((o) => !a.has(o));
  const goneObjects = [...a].filter((o) => !b.has(o));
  if (newObjects.length) {
    const kinds = tally(newObjects.map((o) => next.objects[o]?.type ?? 'object'));
    parts.push(T.added(kinds));
  }
  if (goneObjects.length) parts.push(T.gone(goneObjects.length));

  for (const r of next.refs) {
    const was = prev.refs.find((x) => x.name === r.name);
    if (!was) parts.push(T.newRef(strip(r.name)));
    else if (was.oid !== r.oid) parts.push(T.refMoved(strip(r.name), r.oid.slice(0, 7)));
  }
  for (const r of prev.refs)
    if (!next.refs.find((x) => x.name === r.name)) parts.push(T.refDeleted(strip(r.name)));

  if (prev.head.ref !== next.head.ref)
    parts.push(T.headTo(next.head.ref ? strip(next.head.ref) : T.headDetached));
  else if (prev.head.detached && next.head.oid !== prev.head.oid) parts.push(T.headMoved);

  const ia = new Set(prev.index.map((e) => `${e.stage}:${e.path}:${e.oid}`));
  const ib = new Set(next.index.map((e) => `${e.stage}:${e.path}:${e.oid}`));
  const staged = [...ib].filter((k) => !ia.has(k)).length;
  const unstaged = [...ia].filter((k) => !ib.has(k)).length;
  if (staged) parts.push(T.staged(staged));
  if (unstaged) parts.push(T.unstaged(unstaged));

  const unreachableNow = (next.unreachable ?? []).length;
  const unreachableWas = (prev.unreachable ?? []).length;
  if (unreachableNow > unreachableWas) parts.push(T.nowUnreachable(unreachableNow - unreachableWas));

  return parts.length ? parts.join(T.join) : T.none;
}

function tally(kinds: string[]): string {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([k, n]) => S.change.kind(n, k)).join(S.change.join);
}

const strip = (name: string) => name.replace(/^refs\/(heads|tags|remotes)\//, '');
