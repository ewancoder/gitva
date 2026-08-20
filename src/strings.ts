/**
 * Which language the words are in.
 *
 * One language is in force at a time, and it is **the viewer's** — the
 * repository is shared, the view is yours, and so are the words. Nothing about
 * the choice reaches the server: a step carries note *ids* rather than
 * sentences (`Note` in `types.ts`), so the same recorded step reads in whatever
 * language the browser holding it is set to, including one added long after the
 * step was recorded.
 *
 * `S` is a live binding, so every `S.x.y` reads the language in force at the
 * moment it is read. Nothing may cache a sentence: `setLanguage` swaps the
 * words and the caller redraws.
 *
 * Adding a language is two lines — an entry in `LANGUAGES` and a loader beside
 * it — plus the translated file itself. It arrives when it is chosen and never
 * before, which is why the loaders are functions.
 */

import { en } from './strings-en.js';
import type { Note } from './types.js';

/** The shape a translation has to fill — English is the reference. */
export type Strings = typeof en;

/**
 * The languages on offer, in the order their buttons appear. A language names
 * itself: someone looking for Russian is looking for `RU` and «Русский», not
 * for whatever the language they cannot read calls it. That is why these two
 * are here and not in the translated files.
 */
export const LANGUAGES: { code: string; label: string; name: string }[] = [
  { code: 'en', label: 'EN', name: 'English' },
];

/**
 * One module per language, loaded when it is chosen. English is already here
 * because the first paint cannot wait for a fetch, and because the server
 * prints in it.
 */
const LOADERS: Record<string, () => Promise<Strings>> = {
  en: async () => en,
};

/** The words in force. Read it, never keep what it gave you. */
export let S: Strings = en;

/** Which language that is — the code, for the button that is pressed. */
export let language = 'en';

/** Which choice is the current one. Two clicks in a row are two loads, and the
 *  slower one must not land last: only the newest choice may take effect —
 *  `panel.ts` guards a fetched body the same way. */
let choice = 0;

/** A code nobody has words for falls back to English rather than blanking the
 *  page: it comes out of a stored preference, which can outlive a language. */
export async function setLanguage(code: string): Promise<void> {
  const want = code in LOADERS ? code : 'en';
  const mine = ++choice;
  const words = await LOADERS[want]!();
  if (mine === choice) {
    S = words;
    language = want;
  }
}

/**
 * One note from a step, in the language in force. A recording written before
 * notes became ids holds the prose itself; it is shown as it was written rather
 * than thrown away.
 */
export function renderNote(note: Note | string): string {
  if (typeof note === 'string') return note;
  const words = S.notes[note.id];
  return typeof words === 'function'
    ? (words as (...args: (string | number)[]) => string)(...(note.args ?? []))
    : words;
}
