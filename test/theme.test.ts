// The theme choice: how it cycles, and — the part with real consequences — how an existing user's
// saved choice survives the change of default from 'dark' to 'system'.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_SETTINGS, THEME_CYCLE, nextTheme, resolveTheme } from '../lib/types.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// A minimal <html> element: the attribute and style the theme code writes, nothing else.
function fakeDocument() {
  const attrs = new Map<string, string>();
  const documentElement = {
    style: { colorScheme: '' },
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
    getAttribute: (name: string) => attrs.get(name) ?? null,
  };
  return { documentElement } as unknown as Document;
}

function fakeLocalStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

// Runs public/theme-boot.js the way a page does: as a classic script with only the page globals.
// A module-only construct (an `import` statement) is a SyntaxError here, and a `require` would
// throw inside the script's try and leave the document untouched, so both fail the checks below.
function runBootScript(localStorage: ReturnType<typeof fakeLocalStorage>, document: Document): void {
  const boot = fs.readFileSync(path.join(ROOT, 'public', 'theme-boot.js'), 'utf8');
  new Function('localStorage', 'document', boot)(localStorage, document);
}

test('the pre-paint script restores whatever applyTheme last applied', async () => {
  // public/theme-boot.js runs before the stylesheet, as a classic script, and imports nothing, so it
  // cannot share the mirror key with lib/theme.ts. If the two drift, the pre-paint script reads a key
  // nothing writes and the dark flash comes back on a path nothing else covers. This runs both
  // halves: applyTheme writes the mirror, and the boot script on a fresh page must reproduce the
  // same <html> state before any CSS applies.
  const { applyTheme } = await import('../lib/theme.ts');
  const storage = fakeLocalStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
  try {
    for (const choice of ['light', 'dark', 'system'] as const) {
      const live = fakeDocument();
      // Start the fresh page from the opposite state, so a boot script that does nothing fails.
      const fresh = fakeDocument();
      fresh.documentElement.setAttribute('data-theme', choice === 'light' ? 'dark' : 'light');
      applyTheme(choice, live);
      runBootScript(storage, fresh);
      assert.equal(fresh.documentElement.getAttribute('data-theme'), live.documentElement.getAttribute('data-theme'), choice);
      assert.equal(fresh.documentElement.style.colorScheme, live.documentElement.style.colorScheme, choice);
    }
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('the pre-paint script leaves a fresh profile on the CSS default', () => {
  // An empty mirror means no saved choice. The CSS default (System) is the right answer, so the
  // script must not write anything.
  const doc = fakeDocument();
  runBootScript(fakeLocalStorage(), doc);
  assert.equal(doc.documentElement.getAttribute('data-theme'), null);
  assert.equal(doc.documentElement.style.colorScheme, '');
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
