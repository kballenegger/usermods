// The theme choice: how it cycles, and — the part with real consequences — how an existing user's
// saved choice survives the change of default from 'dark' to 'system'.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, THEME_CYCLE, nextTheme, resolveTheme } from '../lib/types.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the pre-paint script and lib/theme.ts agree on the mirror key', () => {
  // public/theme-boot.js runs before the stylesheet, as a classic script, and imports nothing — it
  // cannot share a constant with lib/theme.ts without pulling in the module graph it exists to
  // avoid. So the key is written in both places. If they ever drift, the pre-paint script reads a
  // key nothing writes, and the dark flash comes back silently on a path nothing else covers.
  const theme = fs.readFileSync(path.join(ROOT, 'lib', 'theme.ts'), 'utf8');
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'theme-boot.js'), 'utf8');

  const inTheme = /MIRROR_KEY\s*=\s*'([^']+)'/.exec(theme)?.[1];
  const inBoot = /localStorage\.getItem\('([^']+)'\)/.exec(boot)?.[1];

  assert.ok(inTheme, 'no MIRROR_KEY found in lib/theme.ts');
  assert.ok(inBoot, 'no localStorage.getItem key found in public/theme-boot.js');
  assert.equal(inBoot, inTheme);
});

test('the pre-paint script stays dependency-free', () => {
  // The moment this file imports anything it stops being able to run before the first paint, which
  // is its entire reason for existing.
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'theme-boot.js'), 'utf8');
  assert.ok(!/^\s*import\s/m.test(boot), 'public/theme-boot.js must not import anything');
  assert.ok(!/\brequire\s*\(/.test(boot), 'public/theme-boot.js must not require anything');
});

test('every page loads the pre-paint script before its stylesheet', () => {
  // A stylesheet applied before the theme attribute is on <html> is exactly the flash. Both pages
  // are checked, because the install page is a second entry point that is easy to forget.
  for (const page of ['entrypoints/sidepanel/index.html', 'entrypoints/install/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
    const script = html.indexOf('theme-boot.js');
    const sheet = html.indexOf('rel="stylesheet"');
    assert.ok(script !== -1, `${page} does not load the pre-paint script`);
    assert.ok(sheet !== -1, `${page} has no stylesheet link`);
    assert.ok(script < sheet, `${page} loads its stylesheet before the pre-paint script`);
    // A module script is deferred, which would put it back after the first paint.
    assert.ok(
      !/<script[^>]*type=["']module["'][^>]*theme-boot/.test(html),
      `${page} loads the pre-paint script as a module, which is deferred past the first paint`,
    );
  }
});

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
