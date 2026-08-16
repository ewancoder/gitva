/**
 * Colour: three hues, and no more.
 *
 * A node-link graph is an all-pairs problem — any kind can end up next to any
 * other — so every pair has to separate. On this dark ground exactly three hues
 * clear the contrast and colour-vision floors; four does not. So the three go
 * to the three things you look at constantly, and everything else is separated
 * by silhouette and by the name it already carries.
 *
 * Unreachable is a state, not an identity, so it is never a hue: it is a ghost,
 * because that is what it is. One accent means "this just changed" and is spent
 * on nothing else — not hover, not selection, not focus.
 *
 * The theme is data handed to the renderer. A light palette would be a new one
 * of these, never a rewrite.
 */

export const theme = {
  ground: '#0d0f13',
  panel: '#171a21',
  raised: '#20242e',
  line: '#2c313d',

  ink: '#dfe4ee',
  muted: '#8d96a8',
  faint: '#59616f',

  commit: '#e8a33c',
  tree: '#54bf85',
  blob: '#5aa7ea',

  accent: '#ff5ea8',

  // Pointer chips are outlines, not fills, so they can carry their own hues
  // without competing with the three object hues above: what a chip is
  // (HEAD, local, remote, tag, tag object) is the thing you scan for first.
  head: '#b98cff',
  refLocal: '#4fd1c5',
  refRemote: '#f08c5a',
  refTag: '#e0c74f',
  tagObject: '#8fb0ff',

  ghost: '#6b7488',

  sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',

  radius: 4,
  /** One duration, one curve, nothing slow. */
  duration: 220,
};

export type Theme = typeof theme;

export const hueFor = (kind: string): string =>
  kind === 'commit' ? theme.commit : kind === 'tree' ? theme.tree : kind === 'blob' ? theme.blob : theme.ink;

/** Chip hue by what the pointer is. Ids are `ref:<full ref name>`. */
export const chipHue = (kind: string, id: string): string =>
  kind === 'head'
    ? theme.head
    : kind === 'tag'
      ? theme.tagObject
      : kind !== 'ref'
        ? theme.muted
        : id.startsWith('ref:refs/remotes/')
          ? theme.refRemote
          : id.startsWith('ref:refs/tags/')
            ? theme.refTag
            : theme.refLocal;
