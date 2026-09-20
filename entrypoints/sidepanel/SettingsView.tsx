import { useEffect, useRef, useState } from 'react';
import { SUBSCRIPTIONS_OFF } from '@/lib/buildflags';
import { loadSettings, savePrefs } from '@/lib/settings';
import { resolveScope } from '@/lib/sidepanel';
import { applyTheme } from '@/lib/theme';
import { DEFAULT_CONTEXT_BUDGET, type Prefs, type Settings, type SidePanelScope, type ThemeChoice } from '@/lib/types';
import { ProvidersSection } from './ProvidersSection';
import { useConnections } from './useConnections';

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

/**
 * Settings: the providers you have connected, then the preferences that are about usermods rather
 * than about any one of them.
 *
 * Which MODEL to use is not here. It is chosen in the chat, under the message box, per conversation
 * (ModelPicker.tsx) — so this screen has no model field and nothing on it decides what the next
 * message is sent to.
 */
export function SettingsView({ onReviewNotice }: { onReviewNotice?: () => void } = {}) {
  const [s, setS] = useState<Settings | null>(null);
  /** Preference changes waiting for the debounce, and provider edits in flight, as one indicator. */
  const [prefsSaved, setPrefsSaved] = useState(true);
  const [providersSaving, setProvidersSaving] = useState(false);
  const pending = useRef<Partial<Prefs>>({});
  const providers = useConnections();

  useEffect(() => {
    void loadSettings().then(setS);
  }, []);

  // Autosave: every change is persisted after a short pause, so nothing depends on a Save button.
  // Only the fields that changed are written (savePrefs merges into what is stored), so this screen
  // can never write back a stale copy of something another view changed meanwhile.
  useEffect(() => {
    if (prefsSaved) return;
    const t = window.setTimeout(() => {
      const patch = pending.current;
      pending.current = {};
      void savePrefs(patch).then(() => setPrefsSaved(true));
    }, 300);
    return () => window.clearTimeout(t);
  }, [s, prefsSaved]);

  function update(patch: Partial<Prefs>) {
    pending.current = { ...pending.current, ...patch };
    setS((prev) => (prev ? { ...prev, ...patch } : prev));
    setPrefsSaved(false);
  }

  if (!s) return <div className="view muted">loading…</div>;
  const saved = prefsSaved && !providersSaving;

  return (
    <div className="view view-form">
      <ProvidersSection view={providers} onSaving={setProvidersSaving} />

      <div className="label">Preferences</div>

      {/* Their toggle, wearing the volt switch rather than a native checkbox. */}
      <label className="field">
        <span className="toggle" style={{ marginBottom: 'var(--sp-1)' }}>
          <input
            type="checkbox"
            checked={s.autoNameChats !== false}
            onChange={(e) => update({ autoNameChats: e.target.checked })}
          />
          Name chats automatically
        </span>
        <span>
          After the first reply, usermods asks the model that chat is using for a short name — one
          extra, small request per chat. Off, a chat keeps the first thing you typed as its name.
          Renaming a chat yourself always sticks either way.
        </span>
      </label>

      <label className="field">
        Context budget (tokens)
        <input
          type="number"
          min={10000}
          step={10000}
          value={s.contextBudget ?? DEFAULT_CONTEXT_BUDGET}
          onChange={(e) => update({ contextBudget: Math.max(10_000, Number(e.target.value) || DEFAULT_CONTEXT_BUDGET) })}
        />
        <span>
          How much conversation to send the model before usermods compacts it: first by trimming old
          page snapshots and tool output, then by summarising the earlier part of the chat. Lower is
          cheaper and faster; higher keeps more of the chat in front of the model. One budget for
          every provider: set it for the smallest context window you use.
        </span>
      </label>

      {/*
        Where the panel opens. The background worker watches chrome.storage for this and reconfigures
        Chrome's window-level panel the moment it lands, so the next toolbar click already obeys it —
        no reload, and nothing to do here beyond saving it (see lib/sidepanel.ts).
      */}
      <label className="field">
        Side panel opens
        <select
          data-testid="settings-panel-scope"
          value={resolveScope(s)}
          onChange={(e) => update({ sidePanelScope: e.target.value as SidePanelScope })}
        >
          <option value="tab">On this tab only</option>
          <option value="window">On every tab</option>
        </select>
        <span>
          On this tab only is the default: the panel stays on the tab you opened it from and is
          hidden on the others, coming back when you return. On every tab is Chrome's window-wide
          panel, which follows you until you close it. Either way, closing is the ✕ in the panel's
          own header — the toolbar icon opens it and cannot close it again.
        </span>
      </label>

      {/*
        The theme is applied the moment it is picked, so the choice is visible while you make it;
        the autosave effect above persists it like every other setting.
      */}
      <label className="field">
        Theme
        <select
          value={s.theme}
          onChange={(e) => {
            const theme = e.target.value as ThemeChoice;
            applyTheme(theme);
            update({ theme });
          }}
        >
          {THEMES.map((t) => (
            <option key={t.value} value={t.value}>{t.label}</option>
          ))}
        </select>
        <span>System follows this device, and is the default. The ◐ in the tab bar cycles the same setting.</span>
      </label>

      <div className="row" style={{ marginTop: 'var(--sp-4)' }}>
        <span className="dot" aria-hidden="true" style={saved ? undefined : { background: 'var(--warn)', boxShadow: 'none' }} />
        <span className="label" style={{ marginBottom: 0 }} data-testid="settings-saved">{saved ? 'all changes saved' : 'saving…'}</span>
      </div>
      <p className="muted" style={{ marginTop: 'var(--sp-5)', fontSize: 'var(--fs-meta)' }}>
        API keys{SUBSCRIPTIONS_OFF ? '' : ' and sign-in tokens'} are stored in this extension's local storage on this device, and
        each is sent only to the provider it belongs to.{SUBSCRIPTIONS_OFF ? '' : ' Subscription usage counts against your plan limits.'}
        {onReviewNotice && (
          <>
            {' '}
            <button className="linklike" onClick={onReviewNotice}>Review data notice</button>
          </>
        )}
      </p>
    </div>
  );
}
