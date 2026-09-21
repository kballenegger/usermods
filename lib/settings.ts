// The .ts extension is load-bearing, as in lib/transcript.ts and lib/agent/retry.ts: `npm test`
// runs this through node --experimental-strip-types, whose ESM resolver does not guess extensions.
// It matters here now that test/settings.test.ts imports this module directly.
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_SETTINGS, resolveTheme, type Prefs, type Settings, type ThemeChoice } from './types.ts';

const KEY = 'settings';

/**
 * The smallest context budget that is worth having. Below roughly this, compaction's own summary
 * (SUMMARY_MAX_TOKENS ≈ 1500) plus the system prompt plus the turns it promises to keep verbatim
 * is already most of the budget, and every single turn would trigger a summarisation call.
 */
export const MIN_CONTEXT_BUDGET = 10_000;

/**
 * What a typed context budget becomes when the user is finished typing it.
 *
 * THE BUG THIS EXISTS FOR. The Settings field clamped inside onChange:
 *
 *     onChange={(e) => update({ contextBudget: Math.max(10_000, Number(e.target.value) || …) })}
 *
 * which clamps every INTERMEDIATE value, not the final one. To type 50000 you must first type "5",
 * and "5" clamps to 10000 — so the field rewrites itself under the cursor and you cannot get to
 * any number whose prefixes are below the floor. The user's words: "You have a minimum default but
 * when I'm editing, it enforces it so it's a bit tricky for me to change the context window limit."
 *
 * The rule is the same; WHEN it runs is the fix. Typing is left alone, and this runs once, on blur
 * or Enter — which is also where an empty field means "I want the default back" rather than zero.
 *
 * Returns null when there is nothing to commit (the text is unchanged in meaning), so the caller
 * can leave the stored value alone rather than writing an identical one.
 */
export function commitContextBudget(text: string, current: number = DEFAULT_CONTEXT_BUDGET): number {
  const trimmed = text.trim();
  // An empty field is a request for the default, not a request for zero. Anything unparseable
  // (a stray letter, a lone minus) keeps what was already there rather than inventing a number.
  if (!trimmed) return DEFAULT_CONTEXT_BUDGET;
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return current;
  return Math.max(MIN_CONTEXT_BUDGET, Math.round(n));
}

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
