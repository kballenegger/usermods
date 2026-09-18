import { useState } from 'react';
import { summarizeImport } from '@/lib/importreport';
import { rpc } from '@/lib/rpc';
import type { ScriptPreview } from '@/lib/types';
import { InstallPreview } from '../sidepanel/components/InstallPreview';
import { TampermonkeyCard } from '../sidepanel/components/TampermonkeyCard';

/**
 * Install from URL, import a file, migrate from Tampermonkey — the same three routes the side
 * panel's Mods tab offers, on the dashboard.
 *
 * The two components that carry the actual content (the preview of what a script will do, and the
 * migration instructions) are imported from sidepanel/components, not copied: they are the parts
 * that must not drift. What is here is the small amount of wiring around them, which differs
 * because this page owns no mod list of its own — it tells the dashboard to refetch instead.
 */
export function InstallPanel({
  onChanged,
  onStatus,
  onError,
}: {
  onChanged: () => void;
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ preview: ScriptPreview; downloadUrl?: string } | null>(null);
  const [installError, setInstallError] = useState('');

  async function preview(req: { url: string } | { source: string }) {
    setInstallError('');
    setBusy(true);
    try {
      const p = 'url' in req ? await rpc({ type: 'mods.preview', url: req.url }) : await rpc({ type: 'mods.preview', source: req.source });
      setPending({ preview: p, downloadUrl: 'url' in req ? req.url : undefined });
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  }

  async function confirmInstall() {
    if (!pending) return;
    setBusy(true);
    setInstallError('');
    try {
      await rpc({
        type: 'mods.install',
        source: pending.preview.source,
        downloadUrl: pending.downloadUrl ?? pending.preview.downloadUrl,
        enabled: true,
      });
      onStatus(`Installed “${pending.preview.name}”.`);
      setPending(null);
      setUrl('');
      onChanged();
    } catch (e) {
      setInstallError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  function importFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.user.js,text/javascript';
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) void f.text().then((source) => preview({ source }));
    };
    input.click();
  }

  return (
    <>
      <div className="card">
        <div className="muted label">Install from URL</div>
        <div className="field-row">
          <input
            value={url}
            placeholder="https://example.com/script.user.js"
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && url.trim()) void preview({ url: url.trim() });
            }}
          />
          <button className="btn" disabled={busy || !url.trim()} onClick={() => void preview({ url: url.trim() })}>
            {busy ? '…' : 'Fetch'}
          </button>
        </div>
        <div className="row">
          <span className="muted grow">Or import a .user.js file from disk.</span>
          <button className="btn" onClick={importFile}>Import file</button>
        </div>
      </div>

      {pending && (
        <InstallPreview
          preview={pending.preview}
          busy={busy}
          error={installError}
          onInstall={() => void confirmInstall()}
          onCancel={() => setPending(null)}
        />
      )}

      <TampermonkeyCard
        onImported={(r) => {
          onStatus(summarizeImport(r));
          onChanged();
        }}
        onError={onError}
      />
    </>
  );
}
