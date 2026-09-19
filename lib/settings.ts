import { DEFAULT_SETTINGS, resolveTheme, type Prefs, type Settings, type ThemeChoice } from './types';

const KEY = 'settings';

/**
 * The global preferences, as a `Settings` with the provider fields at their inert defaults.
 *
 * 'settings' used to hold the one configured provider as well. It no longer does: providers are
 * connections (lib/connections.ts), the model is chosen per chat, and the provider fields a
 * `Settings` still has are filled in by effectiveSettings() for one resolved selection. What this
 * returns is the base that function builds on — theme, auto-naming, context budget, panel scope —
 * so nothing may read `.provider`, `.apiKey` or `.model` off it directly.
 *
 * A profile that still holds the old shape is migrated by loadConnections(), not here; until that
 * has run, the legacy fields are deliberately NOT passed through, so a half-migrated read can never
 * hand a caller an API key outside a connection.
 */
export async function loadSettings(): Promise<Settings> {
  const r = await chrome.storage.local.get(KEY);
  const stored = r[KEY] as Partial<Settings> | undefined;
  const prefs: Prefs = {
    autoNameChats: stored?.autoNameChats ?? DEFAULT_SETTINGS.autoNameChats,
    // resolveTheme, not the plain default: an existing profile keeps the theme it has been wearing.
    theme: resolveTheme(stored),
    contextBudget: stored?.contextBudget ?? DEFAULT_SETTINGS.contextBudget,
    sidePanelScope: stored?.sidePanelScope ?? DEFAULT_SETTINGS.sidePanelScope,
  };
  return { ...DEFAULT_SETTINGS, ...prefs };
}

/**
 * Persist some preferences, leaving every other stored field exactly as it is.
 *
 * Never a whole-object write from a view's copy: the theme toggle, the Settings screen and (during
 * a migration) loadConnections all write this key, and a full rewrite from a stale read would undo
 * whichever landed in between. Re-reading immediately before the write keeps the window as small as
 * chrome.storage allows.
 */
export async function savePrefs(patch: Partial<Prefs>): Promise<void> {
  const r = await chrome.storage.local.get(KEY);
  const stored = (r[KEY] as Record<string, unknown> | undefined) ?? {};
  await chrome.storage.local.set({ [KEY]: { ...stored, ...patch } });
}

/** Persist just the theme. The compact toggle can be clicked at any moment; see savePrefs. */
export async function saveThemeChoice(theme: ThemeChoice): Promise<void> {
  await savePrefs({ theme });
}
