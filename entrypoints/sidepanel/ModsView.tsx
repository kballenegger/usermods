import { useEffect, useState } from 'react';
import { modFromSource, stripHeader, urlMatches } from '@/lib/mods';
import { rpc } from '@/lib/rpc';
import type { Mod } from '@/lib/types';

export function ModsView({ tabId, pageUrl }: { tabId: number | null; pageUrl: string }) {
  const [mods, setMods] = useState<Mod[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    rpc({ type: 'mods.list' }).then(setMods).catch((e) => setError(String(e)));
  }, []);

  async function toggle(m: Mod) {
    setMods(await rpc({ type: 'mods.toggle', id: m.id, enabled: !m.enabled }));
  }
  async function remove(m: Mod) {
    if (!confirm(`Delete "${m.name}"?`)) return;
    setMods(await rpc({ type: 'mods.delete', id: m.id }));
  }
  async function tryNow(m: Mod) {
    if (tabId == null) return;
    const r = await rpc({ type: 'mods.try', tabId, code: stripHeader(m.source) });
    if (!r.ok) alert(r.error);
  }
  function exportMod(m: Mod) {
    const blob = new Blob([m.source], { type: 'text/javascript' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${m.name.replace(/[^\w.-]+/g, '-').toLowerCase() || 'mod'}.user.js`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importMod() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.js,.user.js,text/javascript';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return;
      const mod = modFromSource(await f.text());
      if (!mod.matches.length) {
        alert('This script has no @match lines, so it would never run. Add one and import again.');
        return;
      }
      setMods(await rpc({ type: 'mods.save', mod }));
    };
    input.click();
  }

  const here = mods.filter((m) => pageUrl && urlMatches(pageUrl, m.matches));
  const elsewhere = mods.filter((m) => !here.includes(m));

  return (
    <div className="view">
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ marginBottom: 10 }}>
        <span className="muted grow">{mods.length} mod{mods.length === 1 ? '' : 's'}</span>
        <button className="btn" onClick={() => void importMod()}>Import .user.js</button>
      </div>
      {mods.length === 0 && <div className="empty">No mods yet. Build one in Chat.</div>}
      {here.length > 0 && <h4 className="muted" style={{ margin: '4px 0' }}>On this site</h4>}
      <div className="list">{here.map((m) => <ModCard key={m.id} m={m} onToggle={toggle} onRemove={remove} onTry={tryNow} onExport={exportMod} />)}</div>
      {elsewhere.length > 0 && <h4 className="muted" style={{ margin: '12px 0 4px' }}>Other sites</h4>}
      <div className="list">{elsewhere.map((m) => <ModCard key={m.id} m={m} onToggle={toggle} onRemove={remove} onTry={tryNow} onExport={exportMod} />)}</div>
    </div>
  );
}

function ModCard({ m, onToggle, onRemove, onTry, onExport }: { m: Mod; onToggle: (m: Mod) => void; onRemove: (m: Mod) => void; onTry: (m: Mod) => void; onExport: (m: Mod) => void }) {
  return (
    <div className="card" style={{ opacity: m.enabled ? 1 : 0.6 }}>
      <div className="row">
        <h4 className="grow">{m.name}</h4>
        <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={m.enabled} onChange={() => onToggle(m)} /> on
        </label>
      </div>
      {m.description && <div className="desc">{m.description}</div>}
      <div className="row">{m.matches.map((x) => <span key={x} className="chip">{x}</span>)}</div>
      <details>
        <summary className="muted">Show code</summary>
        <pre>{m.source}</pre>
      </details>
      <div className="row">
        <button className="btn" onClick={() => onTry(m)}>Run now</button>
        <button className="btn" onClick={() => onExport(m)}>Export</button>
        <span className="grow" />
        <button className="btn danger" onClick={() => onRemove(m)}>Delete</button>
      </div>
    </div>
  );
}
