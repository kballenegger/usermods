import { DEFAULT_SETTINGS, type Settings } from './types';

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY);
  return { ...DEFAULT_SETTINGS, ...((r[KEY] as Partial<Settings> | undefined) ?? {}) };
}

export async function saveSettings(s: Settings): Promise<void> {
  await chrome.storage.local.set({ [KEY]: s });
}
