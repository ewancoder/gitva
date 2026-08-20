/**
 * The words and the markup have to agree. index.html holds keys and no copy,
 * so a key nobody wrote a string for renders as an empty button — which is
 * invisible in a diff and obvious only to whoever opens the page.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { S } from '../src/strings.js';

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

