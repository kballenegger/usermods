import { useEffect, useRef, useState } from 'react';
import { STORE_BUILD, migrateSettingsForBuild } from '@/lib/buildflags';
import { rpc, type OAuthKind, type OAuthLoginState } from '@/lib/rpc';
import { loadSettings, saveSettings } from '@/lib/settings';
import { resolveScope } from '@/lib/sidepanel';
import { applyTheme } from '@/lib/theme';
import { DEFAULT_CONTEXT_BUDGET, DEFAULT_SETTINGS, type Settings, type SidePanelScope, type ThemeChoice } from '@/lib/types';

const THEMES: Array<{ value: ThemeChoice; label: string }> = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
];

type Preset = { label: string; apply: Partial<Settings> };

const KEY_PRESETS: Preset[] = [
  { label: 'Anthropic', apply: { provider: 'anthropic', baseUrl: '', model: 'claude-opus-5' } },
  { label: 'OpenAI', apply: { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' } },
  { label: 'xAI Grok', apply: { provider: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' } },
  { label: 'OpenRouter', apply: { provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5' } },
  { label: 'Ollama', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: '' } },
  { label: 'LM Studio', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: '' } },
];

const CUSTOM_PRESETS: Preset[] = [
  { label: 'Custom Anthropic API', apply: { provider: 'anthropic', baseUrl: 'http://localhost:', model: '' } },
  { label: 'Custom OpenAI API', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:', model: '' } },
];

/**
 * The subscription presets, kept in a separate array spread in behind the compile-time flag so the
 * store bundle carries neither the entries nor their labels — a filter at runtime would leave both.
 */
const SUBSCRIPTION_PRESETS: Preset[] = STORE_BUILD
  ? []
  : [
      { label: 'ChatGPT subscription', apply: { provider: 'chatgpt', baseUrl: '', apiKey: '', model: '' } },
      { label: 'SuperGrok subscription', apply: { provider: 'xai', baseUrl: '', apiKey: '', model: 'grok-4.6' } },
    ];

const PRESETS: Preset[] = [...KEY_PRESETS, ...SUBSCRIPTION_PRESETS, ...CUSTOM_PRESETS];

export function SettingsView({ onReviewNotice }: { onReviewNotice?: () => void } = {}) {
  const [s, setS] = useState<Settings | null>(null);
  const [saved, setSaved] = useState(true);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState('');
  /** Set when this build dropped a provider the stored settings were using. */
  const [migrated, setMigrated] = useState(false);

  useEffect(() => {
    // A profile saved by a build that had subscription sign-in would otherwise leave this build
    // on a provider it cannot create. Fall back to the default and say so, rather than render a
    // provider select with no matching option and fail on the first message.
    void loadSettings().then((loaded) => {
      const fallback = migrateSettingsForBuild(loaded);
      if (!fallback) return setS(loaded);
      setS(fallback);
      setMigrated(true);
      void saveSettings(fallback);
    });
  }, []);

  // Autosave: every change is persisted after a short pause, so nothing depends on a Save button.
  useEffect(() => {
    if (!s || saved) return;
    const t = window.setTimeout(() => {
      void saveSettings(s).then(() => setSaved(true));
    }, 300);
    return () => window.clearTimeout(t);
  }, [s, saved]);

  function update(patch: Partial<Settings>) {
    setS((prev) => ({ ...(prev ?? DEFAULT_SETTINGS), ...patch }));
    setSaved(false);
  }
  async function fetchModels() {
    if (!s) return;
    setModelsError('');
    await saveSettings(s); // the background reads settings to know which backend to ask
    setSaved(true);
    try {
      const list = await rpc({ type: 'models.list' });
      setModels(list);
      if (!list.length) setModelsError('The backend returned no models.');
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
    }
  }

  if (!s) return <div className="view muted">loading…</div>;
  // Constant-folded in a store build, where migrateSettingsForBuild has already ruled these out.
  const subscription = !STORE_BUILD && (s.provider === 'chatgpt' || s.provider === 'xai');

  return (
    <div className="view view-form">
      {migrated && (
        <p className="error" style={{ marginTop: 0 }}>
          ▲ This build of usermods does not include subscription sign-in, so your ChatGPT / SuperGrok
          provider was switched back to the default. Add an API key below, or install the GitHub
          build to sign in with a subscription again.
        </p>
      )}
      <div className="label">Presets</div>
      <div className="row" style={{ marginBottom: 'var(--sp-4)' }}>
        {PRESETS.map((p) => (
          <button key={p.label} className="btn" onClick={() => update(p.apply)}>{p.label}</button>
        ))}
      </div>
      <label className="field">
        Provider
        <select value={s.provider} onChange={(e) => update({ provider: e.target.value as Settings['provider'] })}>
          <option value="anthropic">Anthropic (Messages API)</option>
          <option value="openai-compatible">OpenAI-compatible (chat/completions)</option>
          {!STORE_BUILD && <option value="chatgpt">ChatGPT subscription (Sign in with ChatGPT)</option>}
          {!STORE_BUILD && <option value="xai">xAI subscription (SuperGrok / X Premium+)</option>}
        </select>
      </label>

      {subscription ? (
        <SubscriptionLogin kind={s.provider as OAuthKind} />
      ) : (
        <>
          <label className="field">
            Base URL
            <input value={s.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} placeholder={s.provider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'} />
            <span>
              Any endpoint that speaks the {s.provider === 'anthropic' ? 'Anthropic Messages' : 'OpenAI chat completions'} API works here, including a local proxy in front of a subscription.
            </span>
          </label>
          <label className="field">
            API key
            <input type="password" value={s.apiKey} onChange={(e) => update({ apiKey: e.target.value })} autoComplete="off" />
            <span>Leave empty for local servers and proxies that do not need one.</span>
          </label>
        </>
      )}

      <label className="field">
        Model
        <div className="row">
          <input className="grow" list="usermods-models" value={s.model} onChange={(e) => update({ model: e.target.value })} placeholder={s.provider === 'chatgpt' ? 'click Fetch models' : 'claude-opus-5'} />
          <button className="btn" onClick={() => void fetchModels()}>Fetch models</button>
        </div>
        <datalist id="usermods-models">{models.map((m) => <option key={m} value={m} />)}</datalist>
        {modelsError && <span className="error">{modelsError}</span>}
        {models.length > 0 && <span>{models.length} models available. Start typing to filter.</span>}
      </label>

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
          After the first reply, usermods asks the model above for a short name for the chat — one
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
          cheaper and faster; higher keeps more of the chat in front of the model.
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
        <span className="label" style={{ marginBottom: 0 }}>{saved ? 'all changes saved' : 'saving…'}</span>
      </div>
      <p className="muted" style={{ marginTop: 'var(--sp-5)', fontSize: 'var(--fs-meta)' }}>
        {subscription
          ? "Sign-in tokens are stored in this extension's local storage on this device and sent only to the vendor. Usage counts against your plan limits."
          : "Keys are stored in this extension's local storage on this device and sent only to the endpoint above."}
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

function SubscriptionLogin({ kind }: { kind: OAuthKind }) {
  const [status, setStatus] = useState<{ signedIn: boolean; label?: string } | null>(null);
  const [login, setLogin] = useState<OAuthLoginState>({ status: 'idle' });
  const timer = useRef<number | null>(null);
  const vendor = kind === 'chatgpt' ? 'ChatGPT' : 'xAI';

  const refresh = () => rpc({ type: 'oauth.status', kind }).then(setStatus).catch(() => setStatus({ signedIn: false }));
  useEffect(() => {
    setLogin({ status: 'idle' });
    void refresh();
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  function stopPolling() {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
  }
  function startPolling() {
    stopPolling();
    timer.current = window.setInterval(async () => {
      const st = await rpc({ type: 'oauth.poll', kind }).catch((e) => ({ status: 'error', message: String(e) }) as OAuthLoginState);
      setLogin(st);
      if (st.status === 'done' || st.status === 'error' || st.status === 'idle') {
        stopPolling();
        if (st.status === 'idle') setLogin({ status: 'error', message: 'Sign-in was interrupted. Start again.' });
        void refresh();
      }
    }, 2000);
  }
  async function start() {
    setLogin({ status: 'idle' });
    const st = await rpc({ type: 'oauth.start', kind }).catch((e) => ({ status: 'error', message: String(e) }) as OAuthLoginState);
    setLogin(st);
    if (st.status === 'pending') {
      chrome.tabs.create({ url: st.verificationUri }).catch(() => {});
      startPolling();
    }
  }
  async function cancel() {
    stopPolling();
    await rpc({ type: 'oauth.cancel', kind });
    setLogin({ status: 'idle' });
  }
  async function signOut() {
    stopPolling();
    await rpc({ type: 'oauth.signout', kind });
    setLogin({ status: 'idle' });
    void refresh();
  }

  return (
    <div className="card" style={{ marginBottom: 'var(--sp-3)' }}>
      {status?.signedIn ? (
        <div className="row">
          <span className="dot" aria-hidden="true" />
          <span className="grow">Signed in to {vendor}{status.label ? ` as ${status.label}` : ''}</span>
          <button className="btn" onClick={() => void signOut()}>Sign out</button>
        </div>
      ) : login.status === 'pending' ? (
        <>
          <div className="label">Enter this code on the {vendor} page</div>
          <div className="mono" style={{ fontSize: 'var(--fs-stat)', letterSpacing: 2, textAlign: 'center', padding: 'var(--sp-2) 0', color: 'var(--accent-text)' }}>{login.userCode}</div>
          <div className="row">
            <button className="btn" onClick={() => chrome.tabs.create({ url: login.verificationUri })}>Open sign-in page</button>
            <button className="btn" onClick={() => navigator.clipboard.writeText(login.userCode).catch(() => {})}>Copy code</button>
            <span className="grow" />
            <button className="btn" onClick={() => void cancel()}>Cancel</button>
          </div>
          <div className="row">
            <span className="dot running" aria-hidden="true" />
            <span className="label" style={{ marginBottom: 0 }}>waiting for approval</span>
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <span className="dot off" aria-hidden="true" />
            <span className="grow">Not signed in to {vendor}</span>
            <button className="btn primary" onClick={() => void start()}>Sign in with {vendor}</button>
          </div>
          {login.status === 'error' && <div className="error">▲ {login.message}</div>}
          {login.status === 'done' && <div className="ok">● Signed in</div>}
          <div className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
            {kind === 'chatgpt'
              ? 'Works with ChatGPT Plus, Pro and Team plans.'
              : 'Requires SuperGrok, or X Premium+ on the X account you sign in with. Some standard-tier accounts are rejected by xAI with a 403.'}
          </div>
        </>
      )}
    </div>
  );
}
