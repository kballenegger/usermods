import { DEFAULT_SETTINGS, resolveTheme, type Settings, type ThemeChoice } from './types';

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY);
  const stored = r[KEY] as Partial<Settings> | undefined;
  // resolveTheme, not the plain default: an existing profile keeps the theme it has been wearing.
  return { ...DEFAULT_SETTINGS, ...(stored ?? {}), theme: resolveTheme(stored) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}

/**
 * Persist just the theme, leaving every other field exactly as stored.
 *
 * The compact toggle must not do a read-modify-write of the whole settings object: it can be
 * clicked at any moment, including while a chat run or the Settings screen is writing, and a full
 * rewrite from a stale read would silently undo whatever landed in between. Re-reading immediately
 * before the write keeps the window as small as chrome.storage allows.
 */
export async function saveThemeChoice(theme: ThemeChoice): Promise<void> {
  const r = await chrome.storage.local.get(KEY);
  const stored = (r[KEY] as Partial<Settings> | undefined) ?? {};
  await chrome.storage.local.set({ [KEY]: { ...stored, theme } });
}
