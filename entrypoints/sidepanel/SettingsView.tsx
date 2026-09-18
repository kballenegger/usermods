import { useEffect, useState } from 'react';
import { loadSettings, saveSettings } from '@/lib/settings';
import { DEFAULT_SETTINGS, type Settings } from '@/lib/types';

const PRESETS: Array<{ label: string; apply: Partial<Settings> }> = [
  { label: 'Anthropic', apply: { provider: 'anthropic', baseUrl: '', model: 'claude-opus-5' } },
  { label: 'OpenAI', apply: { provider: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', model: 'gpt-5' } },
  { label: 'OpenRouter', apply: { provider: 'openai-compatible', baseUrl: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-opus-5' } },
  { label: 'Ollama', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:11434/v1', model: '' } },
  { label: 'LM Studio', apply: { provider: 'openai-compatible', baseUrl: 'http://localhost:1234/v1', model: '' } },
];

export function SettingsView() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);

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
        </select>
      </label>
      <label className="field">
        Base URL {s.provider === 'anthropic' ? '(optional, for proxies)' : ''}
        <input value={s.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} placeholder={s.provider === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:11434/v1'} />
      </label>
      <label className="field">
        API key {s.provider === 'openai-compatible' ? '(leave empty for local servers)' : ''}
        <input type="password" value={s.apiKey} onChange={(e) => update({ apiKey: e.target.value })} autoComplete="off" />
      </label>
      <label className="field">
        Model
        <input value={s.model} onChange={(e) => update({ model: e.target.value })} placeholder="claude-opus-5" />
      </label>
      <div className="row">
        <button className="btn primary" onClick={() => void save()}>Save</button>
        {saved && <span className="muted">Saved.</span>}
      </div>
      <p className="muted" style={{ marginTop: 20 }}>
        Keys are stored in this extension's local storage on this device and sent only to the endpoint above.
      </p>
    </div>
  );
}
