// The compact theme control.
//
// Settings owns the explicit three-way choice; this is the same setting reachable in one click from
// wherever you already are — the panel's tab bar, and the install page's header. It cycles
// Dark → Light → System and says which one it is in its tooltip, because ◐ is a mode marker, not a
// label: the design system's iconography is geometric glyphs, and it has no icon set to borrow a
// sun or a moon from.
//
// It writes through the same settings object the Settings control writes, so the two can never
// disagree, and applies the choice to this document immediately — the panel restyles under the
// cursor rather than after a round trip.

import { useEffect, useState } from 'react';
import { saveThemeChoice } from '@/lib/settings';
import { THEME_LABEL, applyTheme, currentTheme, nextTheme, storedTheme } from '@/lib/theme';
import type { ThemeChoice } from '@/lib/types';

export function ThemeToggle() {
  /**
   * Seeded from the document rather than from storage.
   *
   * The theme is already on <html> before React runs (lib/theme.ts applies the synchronous mirror
   * in the entry module), so the right glyph is known at first render. Starting from null and
   * filling it in after an async read would mount this control one render late, and that extra
   * render of the tab bar lands in the middle of the panel's chat restore.
   */
  const [theme, setTheme] = useState<ThemeChoice>(() => currentTheme());

  // The mirror can be stale — another page may have changed the theme since this one last ran — so
  // the authoritative value is still read, and applied only if it actually differs.
  useEffect(() => {
    void storedTheme().then((saved) => {
      setTheme((current) => {
        if (current === saved) return current;
        applyTheme(saved);
        return saved;
      });
    });
  }, []);

  // Another page (the Settings control, or a second extension page) changing the theme moves this
  // control too.
  //
  // The guard matters more than it looks. chrome.storage.onChanged fires in every extension page
  // for every key, and `settings` is rewritten in full by saveSettings, so this runs on writes that
  // did not touch the theme at all. Re-rendering unconditionally from here put a render of the tab
  // bar into the middle of a live chat's transcript restore, and the panel lost the chat.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.settings) return;
      const next = (changes.settings.newValue as { theme?: ThemeChoice } | undefined)?.theme;
      if (next !== 'system' && next !== 'dark' && next !== 'light') return;
      setTheme((current) => {
        if (current === next) return current; // no change: do not touch the document or re-render
        applyTheme(next);
        return next;
      });
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  const cycle = async () => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next); // instant: the panel restyles under the cursor
    await saveThemeChoice(next);
  };

  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={() => void cycle()}
      title={`Theme: ${THEME_LABEL[theme]} — click for ${THEME_LABEL[nextTheme(theme)]}`}
      aria-label={`Theme: ${THEME_LABEL[theme]}. Click for ${THEME_LABEL[nextTheme(theme)]}.`}
      data-theme-choice={theme}
    >
      <span aria-hidden="true">◐</span>
    </button>
  );
}
