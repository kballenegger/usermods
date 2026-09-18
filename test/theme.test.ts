// The theme choice: how it cycles, and — the part with real consequences — how an existing user's
// saved choice survives the change of default from 'dark' to 'system'.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, THEME_CYCLE, nextTheme, resolveTheme } from '../lib/types.ts';

test('the toggle cycles Dark -> Light -> System -> Dark', () => {
  assert.equal(nextTheme('dark'), 'light');
  assert.equal(nextTheme('light'), 'system');
  assert.equal(nextTheme('system'), 'dark');
});

test('cycling three times returns to where it started, from any choice', () => {
  for (const start of THEME_CYCLE) {
    assert.equal(nextTheme(nextTheme(nextTheme(start))), start);
  }
});

test('a new install follows the OS', () => {
  // The design system's own default is dark; this extension's is not. A side panel sits beside
  // arbitrary websites all day, so it follows the OS unless told otherwise.
  assert.equal(DEFAULT_SETTINGS.theme, 'system');
  assert.equal(resolveTheme(undefined), 'system');
});

test('an existing profile is never restyled by the change of default', () => {
  // Someone who installed before this change and never touched the theme had a dark panel. Merging
  // the new default into their stored settings would silently turn it light on a light desktop.
  assert.equal(resolveTheme({}), 'dark');
  assert.equal(resolveTheme({ provider: 'anthropic' }), 'dark');
});

test('an explicit choice is always kept, whichever it is', () => {
  assert.equal(resolveTheme({ theme: 'dark' }), 'dark');
  assert.equal(resolveTheme({ theme: 'light' }), 'light');
  assert.equal(resolveTheme({ theme: 'system' }), 'system');
});

test('a stored value that is not a theme falls back rather than reaching the DOM', () => {
  // Storage is not typed at runtime; a corrupted or hand-edited profile must not put an arbitrary
  // string into the data-theme attribute.
  assert.equal(resolveTheme({ theme: 'chartreuse' } as never), 'dark');
  assert.equal(resolveTheme({ theme: null } as never), 'dark');
});
