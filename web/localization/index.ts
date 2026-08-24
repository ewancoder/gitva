/**
 * Localization for UI.
 *
 * `S` holds all strings in for the currently selected language.
 */

import type { Strings } from './strings.js';
import { en } from './languages/en.js';

/** The list of languages, in the order their buttons appear. */
export const LANGUAGES: { code: string; label: string; name: string }[] = [
    { code: 'en', label: 'EN', name: 'English' },
    { code: 'ru', label: 'RU', name: 'Русский' },
];

/** One module per language, loaded when it is chosen. */
const LOADERS: Record<string, () => Promise<Strings>> = {
    en: () => Promise.resolve(en),
    ru: async () => (await import('./languages/ru.js')).ru,
};

/** Currently loaded language (Strings). */
export let S: Strings = en;

/** Highlights which language button is currently pressed. */
export let language = 'en';

/**
 * Set a language by code ('en', 'ru').
 * Non-existent codes fall back to English.
 */
export async function setLanguage(code: string): Promise<void> {
    const wantCode = code in LOADERS ? code : 'en';
    S = await LOADERS[wantCode]();
    language = wantCode;
}
