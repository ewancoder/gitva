/**
 * The words and the markup have to agree. index.html holds keys and no copy,
 * so a key nobody wrote a string for renders as an empty button — which is
 * invisible in a diff and obvious only to whoever opens the page.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { language, LANGUAGES, S, setLanguage } from '../web/localization/index.js';
import { NOTE_IDS } from '../src/types.js';

const html = readFileSync(fileURLToPath(new URL('../../web/index.html', import.meta.url)), 'utf8');
const keys = [...html.matchAll(/data-t(?:-html|-title|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
const ui = S.ui as Record<string, string>;

describe('the strings behind the chrome', () => {
  it('has a string for every key in index.html', () => {
    assert.deepEqual(
      keys.filter((k) => !(k in ui)),
      [],
    );
  });

  it('has no string the page never asks for', () => {
    const asked = new Set(keys);
    assert.deepEqual(
      Object.keys(ui).filter((k) => !asked.has(k)),
      [],
    );
  });

  // `data-t-html` is the one place a string reaches the page as markup, and it
  // exists for the <kbd> inside two of the key descriptions. Anything else in
  // there is a tag nobody meant to allow.
  it('lets nothing but <kbd> through the html keys', () => {
    for (const k of [...html.matchAll(/data-t-html="([^"]+)"/g)].map((m) => m[1])) {
      assert.match(ui[k], /^[^<>]*(<kbd>[^<>]*<\/kbd>[^<>]*)*$/, k);
    }
  });
});


describe('the language in force', () => {
  it('has words for every language it offers', async () => {
    try {
      for (const l of LANGUAGES) {
        await setLanguage(l.code);
        assert.equal(language, l.code, l.code);
        assert.ok(Object.keys(S.ui).length > 0, l.code);
      }
    } finally {
      await setLanguage('en');
    }
  });

  it('falls back to English for a language nobody wrote', async () => {
    // The code comes out of a stored setting, which can outlive a language.
    await setLanguage('kx');
    assert.equal(language, 'en');
  });
});

// Russian counts three ways where English counts two, so the words a number
// sits beside are chosen by the number: 1 коммит, 2 коммита, 5 коммитов.
describe('the Russian counted forms', () => {
  it('agrees with the number in front of it', async () => {
    // A failed assertion must not leave Russian in force: `S` is a live
    // binding shared by every test after this one.
    await setLanguage('ru');
    try {
      assert.equal(S.change.kind(1, 'commit'), '1 коммит');
      assert.equal(S.change.kind(2, 'tree'), '2 дерева');
      assert.equal(S.change.kind(5, 'blob'), '5 блобов');
      assert.equal(S.change.kind(21, 'tag'), '21 тег');
      assert.equal(S.change.kind(11, 'whatever'), '11 объектов');
      assert.match(
        S.status.tally(3, 2, { commit: 1, tree: 1, blob: 1, tag: 1 }, 0, 0),
        /2 коммита · 1c 1t 1b 1g/,
      );
    } finally {
      await setLanguage('en');
    }
  });
});

/**
 * The server picks a note id out of `NOTE_IDS`; the browser looks it up in the
 * words. Nothing makes those two lists agree — the server may not reach into
 * `web/localization/`, which is the whole point of writing the ids out — so
 * this is what makes a note that renders blank fail here instead of on screen.
 */
describe('the notes and the ids the server can send', () => {
  it('has words for every note, in every language', async () => {
    try {
      for (const l of LANGUAGES) {
        await setLanguage(l.code);
        const words = S.notes as Record<string, unknown>;
        assert.deepEqual(NOTE_IDS.filter((id) => !(id in words)), [], l.code);
      }
    } finally {
      await setLanguage('en');
    }
  });

  it('has no words for a note the server cannot send', () => {
    const sendable = new Set<string>(NOTE_IDS);
    assert.deepEqual(Object.keys(S.notes).filter((k) => !sendable.has(k)), []);
  });
});
