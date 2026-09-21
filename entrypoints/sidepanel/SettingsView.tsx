import { useEffect, useRef, useState } from 'react';
import { SUBSCRIPTIONS_OFF } from '@/lib/buildflags';
import { commitContextBudget, loadSettings, MIN_CONTEXT_BUDGET, savePrefs } from '@/lib/settings';
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
  /**
   * The context budget AS TYPED, or null when the field is not being edited.
   *
   * A number input reports every keystroke, and "5" on the way to "50000" is not a number the user
   * means. Holding the text here and committing it once (blur, Enter) is what stops the floor being
   * applied to a half-typed number — the whole of the user's third report.
   */
  const [budget, setBudget] = useState<string | null>(null);

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

  /**
   * Turn the typed context budget into a stored one and stop editing.
   *
   * Idempotent and safe to call when nothing is being edited (blur fires on a field the user never
   * touched), and it writes nothing when the committed number matches what is stored — so tabbing
   * through the form does not mark the screen unsaved.
   */
  function commitBudget() {
    if (budget === null) return;
    const next = commitContextBudget(budget, s?.contextBudget ?? DEFAULT_CONTEXT_BUDGET);
    setBudget(null);
    if (next !== (s?.contextBudget ?? DEFAULT_CONTEXT_BUDGET)) update({ contextBudget: next });
  }

  /**
   * A draft the user typed and then closed the panel on still counts. The side panel is closed
   * constantly, and a number typed but not blurred would otherwise be dropped silently — which is
   * the same class of complaint as the clamping was.
   *
   * The ref pair is what lets one unmount-only effect read the LATEST draft rather than the empty
   * one it closed over on mount.
   */
  const budgetRef = useRef<string | null>(null);
  budgetRef.current = budget;
  const storedBudgetRef = useRef<number>(DEFAULT_CONTEXT_BUDGET);
  storedBudgetRef.current = s?.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
  useEffect(() => {
    return () => {
      const draft = budgetRef.current;
      if (draft === null) return;
      const next = commitContextBudget(draft, storedBudgetRef.current);
      if (next !== storedBudgetRef.current) void savePrefs({ contextBudget: next }).catch(() => {});
    };
  }, []);

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

      {/*
        The one field on this screen you TYPE a number into, which is why it is the one that needs
        a draft. Everything else here is a toggle or a select, where the value the control reports
        is always a value worth storing; a number field reports every keystroke, and half-typed
        numbers are not values. See commitContextBudget in lib/settings.ts for the bug this shape
        fixes — clamping each keystroke made the field fight the user.

        `budget` holds the text while it is being edited and is null the rest of the time, so the
        input shows the stored number whenever the user is not typing into it, including after
        another view changes it.
      */}
      <label className="field">
        Context budget (tokens)
        <input
          type="number"
          min={MIN_CONTEXT_BUDGET}
          step={10000}
          data-testid="settings-context-budget"
          value={budget ?? String(s.contextBudget ?? DEFAULT_CONTEXT_BUDGET)}
          onChange={(e) => setBudget(e.target.value)}
          onBlur={commitBudget}
          onKeyDown={(e) => {
            // Enter commits without waiting for focus to leave, so the keyboard alone is enough.
            // Escape abandons the draft and puts the stored number back.
            if (e.key === 'Enter') {
              e.preventDefault();
              commitBudget();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              setBudget(null);
            }
          }}
        />
        <span>
          How much conversation to send the model before usermods compacts it: first by trimming old
          page snapshots and tool output, then by summarising the earlier part of the chat. Lower is
          cheaper and faster; higher keeps more of the chat in front of the model. One budget for
          every provider: set it for the smallest context window you use. The smallest allowed is{' '}
          {MIN_CONTEXT_BUDGET.toLocaleString('en-US')}, applied when you finish editing; leave it
          empty for the default of {DEFAULT_CONTEXT_BUDGET.toLocaleString('en-US')}.
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
