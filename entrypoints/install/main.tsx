// The page a .user.js link lands on: a dynamic declarativeNetRequest rule redirects userscript
// navigations here as install.html#<the script URL>, the way Tampermonkey intercepts them.
//
// The URL arrives in the fragment and everything after the first '#' is taken verbatim, so a script
// URL carrying its own `url=` parameter cannot decide what this page previews. Whatever it turns
// out to be is shown in full below, and only http(s) is fetched.
import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { isInstallableUrl, scriptUrlFromLocation } from '@/lib/installurl';
import { rpc } from '@/lib/rpc';
import { applyStoredTheme } from '@/lib/theme';
import type { ScriptPreview } from '@/lib/types';
import { InstallPreview } from '../sidepanel/components/InstallPreview';
import { ThemeToggle } from '../sidepanel/components/ThemeToggle';
import '../sidepanel/styles.css';

function InstallPage() {
  const [preview, setPreview] = useState<ScriptPreview | null>(null);
  const [error, setError] = useState('');
  const [installError, setInstallError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const url = scriptUrlFromLocation(location);

  useEffect(() => {
    if (!url) {
      setError('No script URL. Open a .user.js link, or install from the usermods side panel.');
      return;
    }
    if (!isInstallableUrl(url)) {
      setError(`Only http and https userscripts can be installed. This link was: ${url}`);
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
      <div className="page-head">
        <div>
          <div className="wordmark">usermods</div>
          <h2>Install userscript</h2>
        </div>
        <ThemeToggle />
      </div>
      {url && (
        <div className="card">
          <div className="label">Fetching from</div>
          <div className="break mono">{url}</div>
        </div>
      )}
      {error && <div className="card"><div className="error">▲ {error}</div></div>}
      {done && preview && (
        <div className="card hero">
          <div className="row">
            <span className="dot" aria-hidden="true" />
            <h4 className="grow">Installed</h4>
          </div>
          <div className="desc">
            “{preview.name}” is installed and enabled. It will run the next time you load a page it matches. Manage it from the usermods side panel.
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => void closeTab()}>Close tab</button>
          </div>
        </div>
      )}
      {!done && !error && !preview && <div className="empty">fetching {url}…</div>}
      {!done && preview && (
        <InstallPreview preview={preview} busy={busy} error={installError} onInstall={() => void install()} onCancel={() => void closeTab()} />
      )}
    </div>
  );
}

// The authoritative read, correcting the mirror the import above already applied. Not awaited: see
// the note in sidepanel/main.tsx.
void applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <InstallPage />
  </React.StrictMode>,
);
