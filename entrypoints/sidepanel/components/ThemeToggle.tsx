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
import { loadSettings, saveSettings } from '@/lib/settings';
import { THEME_LABEL, applyTheme, nextTheme, storedTheme } from '@/lib/theme';
import type { ThemeChoice } from '@/lib/types';

export function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeChoice | null>(null);

  useEffect(() => {
    void storedTheme().then(setTheme);
  }, []);

  // Another page (Settings, or a second extension page) changing the theme moves this control too.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes.settings) return;
      const next = (changes.settings.newValue as { theme?: ThemeChoice } | undefined)?.theme;
      if (next === 'system' || next === 'dark' || next === 'light') {
        setTheme(next);
        applyTheme(next);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  // Nothing is rendered until the saved choice is known, so the glyph never shows the wrong mode
  // for a frame and then correct itself.
  if (theme === null) return null;

  const cycle = async () => {
    const next = nextTheme(theme);
    setTheme(next);
    applyTheme(next);
    await saveSettings({ ...(await loadSettings()), theme: next });
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
