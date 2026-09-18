// The page a .user.js link lands on: a dynamic declarativeNetRequest rule redirects userscript
// navigations here with ?url=<the script>, the way Tampermonkey intercepts them.
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { rpc } from '@/lib/rpc';
import type { ScriptPreview } from '@/lib/types';
import { InstallPreview } from '../sidepanel/components/InstallPreview';
import '../sidepanel/styles.css';

function InstallPage() {
  const [preview, setPreview] = useState<ScriptPreview | null>(null);
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const url = new URLSearchParams(location.search).get('url') ?? '';

  useEffect(() => {
    if (!url) {
      setError('No script URL. Open a .user.js link, or install from the usermods side panel.');
      return;
    }
    rpc({ type: 'mods.preview', url })
      .then(setPreview)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [url]);

  async function install() {
    if (!preview) return;
    setBusy(true);
    setInstallError('');
    try {
      await rpc({ type: 'mods.install', source: preview.source, downloadUrl: preview.downloadUrl ?? url, enabled: true });
      setDone(true);
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function closeTab() {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) await chrome.tabs.remove(tab.id);
  }

  return (
    <div className="page">
      <h2>Install userscript</h2>
      {error && <div className="card"><div className="error">{error}</div></div>}
      {done && preview && (
        <div className="card">
          <h4>Installed</h4>
          <div className="desc">
            “{preview.name}” is installed and enabled. It will run the next time you load a page it matches. Manage it from the usermods side panel.
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void closeTab()}>Close tab</button>
          </div>
        </div>
      )}
      {!done && !error && !preview && <div className="empty">Fetching {url}…</div>}
      {!done && preview && (
        <InstallPreview preview={preview} busy={busy} error={installError} onInstall={() => void install()} onCancel={() => void closeTab()} />
      )}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <InstallPage />
  </React.StrictMode>,
);
