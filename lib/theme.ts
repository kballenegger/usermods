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
const MIRROR_KEY = 'usermods.theme';

function readMirror(): ThemeChoice | null {
  try {
    const v = localStorage.getItem(MIRROR_KEY);
    return v === 'system' || v === 'dark' || v === 'light' ? v : null;
  } catch {
    return null; // storage partitioned or disabled: fall back to the async read
  }
}

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
 * Put the last known theme on the document immediately, with no await.
 *
 * Called at the top of every extension page's entry module, which still runs before the first
 * paint. If the mirror is empty (a fresh profile, or cleared storage) nothing is written and the
 * document stays on the CSS default — which is System, the right guess for a profile with no
 * choice saved.
 */
export function applyMirroredTheme(doc: Document = document): void {
  const choice = readMirror();
  if (choice) applyTheme(choice, doc);
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
