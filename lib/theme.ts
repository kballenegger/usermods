// Applying the theme choice to a document.
//
// The palette lives entirely in CSS (entrypoints/sidepanel/tokens.css). All this does is put the
// choice where those rules can see it: a `data-theme` attribute on <html>. Leaving the attribute
// off is what "System" means — the prefers-color-scheme rule then decides, and its selector is
// scoped to :root:not([data-theme]) so an explicit choice always wins.

import type { ThemeChoice } from './types';
import { DEFAULT_SETTINGS } from './types';

export function applyTheme(choice: ThemeChoice, doc: Document = document): void {
  if (choice === 'system') doc.documentElement.removeAttribute('data-theme');
  else doc.documentElement.setAttribute('data-theme', choice);
  // Native widgets (scrollbars, the checkbox, the select's popup) follow this, not our tokens.
  doc.documentElement.style.colorScheme = choice === 'system' ? 'light dark' : choice;
}

/**
 * Read the saved choice and apply it. Every extension page calls this before React renders, so the
 * panel never paints one palette and then flips to the other.
 */
export async function applyStoredTheme(doc: Document = document): Promise<void> {
  let choice: ThemeChoice = DEFAULT_SETTINGS.theme;
  try {
    const r = await chrome.storage.local.get('settings');
    const saved = (r.settings as { theme?: unknown } | undefined)?.theme;
    if (saved === 'system' || saved === 'dark' || saved === 'light') choice = saved;
  } catch {
    // No storage (or it failed): the default theme is a fine answer.
  }
  applyTheme(choice, doc);
}
