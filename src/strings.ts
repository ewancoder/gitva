/**
 * Which language the words come from. Every user-facing string is in
 * `strings-<code>.ts`; nothing else in the codebase spells one out.
 *
 * One language is chosen here, for the whole run: the words are shared by the
 * server and the browser, and the recording is shared by every viewer, so a
 * per-viewer language would be the same open work the view has (CLAUDE.md,
 * "Known open work"). To add one: copy `strings-en.ts`, translate it, import it
 * beside `en` and pick it below.
 */

import { en } from './strings-en.js';

/** The shape a translation has to fill — English is the reference. */
export type Strings = typeof en;

export const S: Strings = en;
