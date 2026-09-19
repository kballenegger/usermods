import { useEffect, useState } from 'react';
import { summarizeImport } from '@/lib/importreport';
import { rpc } from '@/lib/rpc';
import type { Mod, ScriptPreview } from '@/lib/types';
import { HANDOFF_KEY, type ChatHandoff } from '@/lib/dashboard';
import { urlMatches } from '@/lib/mods';
import { EditModIcon } from './components/icons';
import { InstallPreview } from './components/InstallPreview';
import { TampermonkeyCard } from './components/TampermonkeyCard';

/** A script waiting on the user's confirmation, plus where it came from. */
interface Pending {
  preview: ScriptPreview;
  downloadUrl?: string;
}

export function ModsView({ tabId, pageUrl, host, onEditInChat }: { tabId: number | null; pageUrl: string; host: string; onEditInChat: () => void }) {
  const [mods, setMods] = useState<Mod[]>([]);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [installError, setInstallError] = useState('');

  useEffect(() => {
    rpc({ type: 'mods.list' }).then(setMods).catch((e: unknown) => setError(String(e)));
  }, []);

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  async function toggle(m: Mod) {
    setMods(await rpc({ type: 'mods.toggle', id: m.id, enabled: !m.enabled }));
  }
  async function remove(m: Mod) {
    if (!confirm(`Delete "${m.name}"?`)) return;
    setMods(await rpc({ type: 'mods.delete', id: m.id }));
  }
  async function tryNow(m: Mod) {
    if (tabId == null) return;
    const r = await rpc({ type: 'mods.try', tabId, modId: m.id });
    if (!r.ok) alert(r.error);
  }
  /**
   * Open a mod in a chat and go there — the Mods tab's half of "Edit in chat".
   *
   * The decision of WHICH chat is the background's (rpc 'mods.edit'), the same one the dashboard's
   * row, the empty state's shortcuts, the composer's picker and the open_mod tool all go through:
   * reuse the chat already editing this mod, seed the current chat if it is empty, otherwise make a
   * new one. All this view does is ask, and then hand over to the Chat tab, which reads the handoff
   * and lands on the chat the background chose.
   */
  async function editInChat(m: Mod) {
    setError('');
    setStatus('');
    try {
      const r = await rpc({ type: 'mods.edit', modId: m.id, host });
      // The same session-storage handoff the dashboard's Open uses, so the Chat tab opens the chat
      // the background chose rather than whichever one this host last used.
      const handoff: ChatHandoff = { chatId: r.chatId, host: r.host, at: Date.now() };
      await chrome.storage.session.set({ [HANDOFF_KEY]: handoff }).catch(() => {});
      // A mod for another site lands its chat under THAT host, and the Chat tab only shows the host
      // the current page is on — so switching tabs would show the wrong chat and silently drop the
      // handoff. Saying so beats a tab switch that appears to have done nothing.
      if (r.host && r.host !== host) {
        setStatus(`“${m.name}” is for ${r.host}. Its chat is ready — open ${r.likelyUrl || r.host} and the panel will land on it.`);
        return;
      }
      onEditInChat();
    } catch (e) {
      fail(e);
    }
  }

  function exportMod(m: Mod) {
    const blob = new Blob([m.source], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${m.name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'mod'}.user.js`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /** Preview a URL or a file's text, then wait for the user to confirm. */
  async function preview(req: { url: string } | { source: string; downloadUrl?: string }) {
    setError('');
    setStatus('');
    setInstallError('');
    setBusy(true);
    try {
      const p = 'url' in req ? await rpc({ type: 'mods.preview', url: req.url }) : await rpc({ type: 'mods.preview', source: req.source });
      setPending({ preview: p, downloadUrl: 'url' in req ? req.url : req.downloadUrl });
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  }

  async function confirmInstall() {
    if (!pending) return;
    setBusy(true);
    setInstallError('');
    try {
      const next = await rpc({
        type: 'mods.install',
        source: pending.preview.source,
        downloadUrl: pending.downloadUrl ?? pending.preview.downloadUrl,
        enabled: true,
      });
      setMods(next);
      setStatus(`Installed “${pending.preview.name}”.`);
      setPending(null);
      setUrl('');
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

  async function update(m: Mod) {
    setError('');
    setStatus('');
    try {
      const r = await rpc({ type: 'mods.update', id: m.id });
      setStatus(r.updated ? `“${m.name}” updated to ${r.version}.` : `“${m.name}” is up to date.`);
      if (r.updated) setMods(await rpc({ type: 'mods.list' }));
    } catch (e) {
      fail(e);
    }
  }

  const here = mods.filter((m) => pageUrl && urlMatches(pageUrl, [...m.matches, ...m.includeGlobs]));
  const elsewhere = mods.filter((m) => !here.includes(m));
  const cardProps = { onToggle: toggle, onRemove: remove, onTry: tryNow, onExport: exportMod, onUpdate: update, onEdit: (m: Mod) => void editInChat(m) };

  return (
    <div className="view stack">
      {error && <div className="error">▲ {error}</div>}
      {status && <div className="ok">● {status}</div>}

      <TampermonkeyCard
        onImported={(r) => {
          setMods(r.mods);
          setStatus(summarizeImport(r));
        }}
        onError={fail}
      />

      <div className="card">
        <div className="label">Install from URL</div>
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
          <span className="muted grow" style={{ fontSize: 'var(--fs-meta)' }}>or import a .user.js file from disk</span>
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

      {mods.length === 0 && <div className="empty">no mods yet · build one in Chat, or install one above</div>}
      {here.length > 0 && (
        <div className="label" style={{ marginBottom: 0 }}>On this site · {here.length}</div>
      )}
      {here.length > 0 && <div className="list">{here.map((m) => <ModCard key={m.id} m={m} {...cardProps} />)}</div>}
      {elsewhere.length > 0 && (
        <div className="label" style={{ marginBottom: 0 }}>Other sites · {elsewhere.length}</div>
      )}
      {elsewhere.length > 0 && <div className="list">{elsewhere.map((m) => <ModCard key={m.id} m={m} {...cardProps} />)}</div>}
    </div>
  );
}

function ModCard({
  m,
  onToggle,
  onRemove,
  onTry,
  onExport,
  onUpdate,
  onEdit,
}: {
  m: Mod;
  onToggle: (m: Mod) => void;
  onRemove: (m: Mod) => void;
  onTry: (m: Mod) => void;
  onExport: (m: Mod) => void;
  onUpdate: (m: Mod) => void;
  onEdit: (m: Mod) => void;
}) {
  // An enabled mod is alive: the toggle at the foot of the card carries the volt. A disabled one
  // recedes rather than being decorated with an "off" marker. How it recedes is the theme's
  // business (styles.css): dark can simply dim it, light has to keep the text legible.
  return (
    <div className={m.enabled ? 'card' : 'card disabled'}>
      <div className="row">
        <h4 className="grow">{m.name}</h4>
        {m.version && <span className="chip">v{m.version}</span>}
        {m.world === 'MAIN' && (
          <span className="chip warn" title="Runs in the page's own JavaScript context (@grant none or unsafeWindow).">▲ page world</span>
        )}
      </div>
      {m.description && <div className="desc">{m.description}</div>}
      <div className="row">{[...m.matches, ...m.includeGlobs].map((x) => <span key={x} className="chip">{x}</span>)}</div>
      {m.grants.length > 0 && (
        <div className="row">
          {m.grants.slice(0, 6).map((g) => <span key={g} className="chip">{g}</span>)}
          {m.grants.length > 6 && <span className="muted" style={{ fontSize: 'var(--fs-label)' }}>+{m.grants.length - 6} more</span>}
        </div>
      )}
      <details>
        <summary>▼ code</summary>
        <pre>{m.source}</pre>
      </details>
      <div className="row">
        <label className="toggle">
          <input type="checkbox" checked={m.enabled} onChange={() => onToggle(m)} /> {m.enabled ? 'on' : 'off'}
        </label>
        <span className="grow" />
        {/* First of the verbs, and the only one carrying an icon: it is the thing this row is for
            now, and it leaves the panel for the Chat tab, which the mark says before the word is
            read. Its accessible name is the full sentence, not "Edit". */}
        <button
          className="btn action"
          onClick={() => onEdit(m)}
          aria-label={`Edit “${m.name}” in chat`}
          title={`Open “${m.name}” in a chat and keep building on it`}
          data-testid="mod-edit-in-chat"
          data-mod-id={m.id}
        >
          <EditModIcon />
          <span className="action-label">Edit in chat</span>
        </button>
        <button className="btn" onClick={() => onTry(m)}>Run once</button>
        <button className="btn" onClick={() => onExport(m)}>Export</button>
        {m.downloadUrl && <button className="btn" onClick={() => onUpdate(m)}>Update</button>}
        <button className="btn danger" onClick={() => onRemove(m)}>Delete</button>
      </div>
    </div>
  );
}
