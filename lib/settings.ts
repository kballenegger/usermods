import { DEFAULT_SETTINGS, resolveTheme, type Settings } from './types';

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
