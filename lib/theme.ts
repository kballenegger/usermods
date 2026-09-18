// Applying the theme choice to a document.
//
// The palette lives entirely in CSS (entrypoints/sidepanel/tokens.css). All this does is put the
// choice where those rules can see it: a `data-theme` attribute on <html>. Leaving the attribute
// off is what "System" means — the prefers-color-scheme rule then decides, and its selector is
// scoped to :root:not([data-theme]) so an explicit choice always wins.

import type { ThemeChoice } from './types';
import { DEFAULT_SETTINGS, resolveTheme } from './types';

// The choice itself (the cycle order, the labels, how a stored value resolves) lives in types.ts
// beside the setting it belongs to. This module is only the part that touches a document.
export { THEME_CYCLE, THEME_LABEL, nextTheme } from './types';

/**
 * A synchronous mirror of the saved choice, so the first paint can be right.
 *
 * chrome.storage is async: by the time it answers, the browser has already painted a frame. For a
 * user whose choice differs from their OS that frame is the wrong palette — a dark flash on a light
 * panel, on every single open. localStorage is synchronous and same-origin per extension page, so
 * the choice is mirrored there and read back before React renders.
 *
 * chrome.storage stays the source of truth: it is what Settings writes, what syncs across pages,
 * and what survives this mirror being cleared. This is a cache, and it is allowed to be missing.
 */
// Duplicated from lib/theme-boot.ts rather than imported: importing that module would run its side
// effect (and drag it into every bundle that touches the theme), which is exactly what it is built
// to avoid. test/theme.test.ts asserts the two strings stay equal.
const MIRROR_KEY = 'usermods.theme';

function writeMirror(choice: ThemeChoice): void {
  try {
    localStorage.setItem(MIRROR_KEY, choice);
  } catch {
    // A missing mirror only costs a frame, so this is never worth failing over.
  }
}

export function applyTheme(choice: ThemeChoice, doc: Document = document): void {
  if (choice === 'system') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', choice);
  // Native widgets (scrollbars, the checkbox, the select's popup, date pickers) follow this, not
  // our tokens. 'light dark' on System hands the same decision to the OS that the CSS is making.
  doc.documentElement.style.colorScheme = choice === 'system' ? 'light dark' : choice;
  writeMirror(choice);
}

/**
 * What this document is wearing right now, read off the element itself.
 *
 * No attribute means System, which is exactly what the CSS falls back to. Lets a control render the
 * correct state on its very first render, with no async read and so no extra render of whatever
 * surrounds it.
 */
export function currentTheme(doc: Document = document): ThemeChoice {
  const v = doc.documentElement.getAttribute('data-theme');
  return v === 'dark' || v === 'light' ? v : 'system';
}

/** Read the saved choice, applying the same old-profile rule loadSettings uses. */
export async function storedTheme(): Promise<ThemeChoice> {
  try {
    const r = await chrome.storage.local.get('settings');
    return resolveTheme(r.settings as Record<string, unknown> | undefined);
  } catch {
    // No storage (or it failed): the default theme is a fine answer.
    return DEFAULT_SETTINGS.theme;
  }
}

/**
 * Read the saved choice and apply it. Every extension page calls this before React renders, so the
 * panel never paints one palette and then flips to the other.
 */
export async function applyStoredTheme(doc: Document = document): Promise<void> {
  applyTheme(await storedTheme(), doc);
}
