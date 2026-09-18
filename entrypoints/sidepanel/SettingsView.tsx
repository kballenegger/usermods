import { useEffect, useRef, useState } from 'react';
import { rpc, type OAuthKind, type OAuthLoginState } from '@/lib/rpc';
import { loadSettings, saveSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';

const PRESETS: Array<{ label: string; apply: Partial<Settings> }> = [
  { label: 'Anthropic', apply: { provider: 'anthropic', baseUrl: '', model: 'claude-opus-5' } },
  { label: 'OpenAI', apply: { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' } },
  { label: 'xAI Grok', apply: { provider: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', model: 'grok-4' } },
  { label: 'OpenRouter', apply: { provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5' } },
  { label: 'Ollama', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: '' } },
  { label: 'LM Studio', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: '' } },
  { label: 'ChatGPT subscription', apply: { provider: 'chatgpt', baseUrl: '', apiKey: '', model: '' } },
  { label: 'SuperGrok subscription', apply: { provider: 'xai', baseUrl: '', apiKey: '', model: 'grok-4.6' } },
  { label: 'Custom Anthropic API', apply: { provider: 'anthropic', baseUrl: 'http://localhost:', model: '' } },
  { label: 'Custom OpenAI API', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:', model: '' } },
];

export function SettingsView() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState('');

  useEffect(() => {
    loadSettings().then(setS);
  }, []);

  function update(patch: Partial<Settings>) {
    setS((prev) => ({ ...prev, ...patch }));
    setSaved(false);
  }
  async function save() {
    await saveSettings(s);
    setSaved(true);
  }
  async function fetchModels() {
    setModelsError('');
    await saveSettings(s); // the background reads settings to know which backend to ask
    try {
      const list = await rpc({ type: 'models.list' });
      setModels(list);
      if (!list.length) setModelsError('The backend returned no models.');
    } catch (e) {
      setModelsError(e instanceof Error ? e.message : String(e));
    }
  }

  const subscription = s.provider === 'chatgpt' || s.provider === 'xai';

  return (
    <div className="view">
      <div className="row" style={{ marginBottom: 12 }}>
        {PRESETS.map((p) => (
          <button key={p.label} className="btn" onClick={() => update(p.apply)}>{p.label}</button>
        ))}
      </div>
      <label className="field">
        Provider
        <select value={s.provider} onChange={(e) => update({ provider: e.target.value as Settings['provider'] })}>
          <option value="anthropic">Anthropic (Messages API)</option>
          <option value="openai-compatible">OpenAI-compatible (chat/completions)</option>
          <option value="chatgpt">ChatGPT subscription (Sign in with ChatGPT)</option>
          <option value="xai">xAI subscription (SuperGrok / X Premium+)</option>
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
            API key (leave empty for local servers and proxies that do not need one)
            <input type="password" value={s.apiKey} onChange={(e) => update({ apiKey: e.target.value })} autoComplete="off" />
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

      <div className="row">
        <button className="btn primary" onClick={() => void save()}>Save</button>
        {saved && <span className="muted">Saved.</span>}
      </div>
      <p className="muted" style={{ marginTop: 20 }}>
        {subscription
          ? "Sign-in tokens are stored in this extension's local storage on this device and sent only to the vendor. Usage counts against your plan limits."
          : "Keys are stored in this extension's local storage on this device and sent only to the endpoint above."}
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
    <div className="card" style={{ marginBottom: 10 }}>
      {status?.signedIn ? (
        <div className="row">
          <span className="grow">Signed in to {vendor}{status.label ? ` as ${status.label}` : ''}</span>
          <button className="btn" onClick={() => void signOut()}>Sign out</button>
        </div>
      ) : login.status === 'pending' ? (
        <>
          <div>Enter this code on the {vendor} page that just opened:</div>
          <div style={{ fontSize: 22, fontFamily: 'ui-monospace, monospace', letterSpacing: 2, textAlign: 'center', padding: '6px 0' }}>{login.userCode}</div>
          <div className="row">
            <button className="btn" onClick={() => chrome.tabs.create({ url: login.verificationUri })}>Open sign-in page</button>
            <button className="btn" onClick={() => navigator.clipboard.writeText(login.userCode).catch(() => {})}>Copy code</button>
            <span className="grow" />
            <button className="btn" onClick={() => void cancel()}>Cancel</button>
          </div>
          <div className="muted">Waiting for approval…</div>
        </>
      ) : (
        <>
          <div className="row">
            <span className="grow">Not signed in to {vendor}.</span>
            <button className="btn primary" onClick={() => void start()}>Sign in with {vendor}</button>
          </div>
          {login.status === 'error' && <div className="error">{login.message}</div>}
          {login.status === 'done' && <div className="muted">Signed in.</div>}
          <div className="muted">
            {kind === 'chatgpt'
              ? 'Works with ChatGPT Plus, Pro and Team plans.'
              : 'Requires SuperGrok, or X Premium+ on the X account you sign in with. Some standard-tier accounts are rejected by xAI with a 403.'}
          </div>
        </>
      )}
    </div>
  );
}
