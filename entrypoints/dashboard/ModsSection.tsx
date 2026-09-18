import { useEffect, useMemo, useState } from 'react';
import {
  bulkTargets,
  exportFilename,
  exportFilenames,
  filterMods,
  formatSize,
  modSiteOptions,
  modSize,
  modSource,
  timeLabel,
  toggleSelectAll,
  type ModFilter,
} from '@/lib/dashboard';
import { modFromSource, parseHeader, previewFromSource } from '@/lib/mods';
import { rpc } from '@/lib/rpc';
import type { Mod } from '@/lib/types';
import { InstallPanel } from './InstallPanel';

export function ModsSection({ mods, loaded, onChanged }: { mods: Mod[]; loaded: boolean; onChanged: () => void }) {
  const [filter, setFilter] = useState<ModFilter>({ site: '', enabled: 'all', query: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const visible = useMemo(() => filterMods(mods, filter), [mods, filter]);
  const sites = useMemo(() => modSiteOptions(mods), [mods]);
  const selection = bulkTargets(selected, visible);
  const open = openId ? mods.find((m) => m.id === openId) : undefined;

  // A mod deleted from elsewhere (the side panel, or a bulk action here) must close its editor.
  useEffect(() => {
    if (openId && !mods.some((m) => m.id === openId)) setOpenId(null);
  }, [mods, openId]);

  const fail = (e: unknown) => {
    setStatus('');
    setError(e instanceof Error ? e.message : String(e));
  };
  const say = (s: string) => {
    setError('');
    setStatus(s);
  };

  async function toggle(m: Mod) {
    try {
      await rpc({ type: 'mods.toggle', id: m.id, enabled: !m.enabled });
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function remove(m: Mod) {
    if (!confirm(`Delete "${m.name}"? This cannot be undone.`)) return;
    try {
      await rpc({ type: 'mods.delete', id: m.id });
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function update(m: Mod) {
    try {
      const r = await rpc({ type: 'mods.update', id: m.id });
      say(r.updated ? `“${m.name}” updated to ${r.version}.` : `“${m.name}” is up to date.`);
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  async function bulk(action: 'enable' | 'disable' | 'delete') {
    const ids = selection;
    if (!ids.length) return;
    if (action === 'delete' && !confirm(`Delete ${ids.length} mod${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
    try {
      await rpc({ type: 'mods.bulk', ids, action });
      setSelected(new Set());
      onChanged();
    } catch (e) {
      fail(e);
    }
  }

  /** Bulk export: one zip, built with fflate, which the extension already depends on. */
  async function bulkExport() {
    const chosen = mods.filter((m) => selection.includes(m.id));
    if (!chosen.length) return;
    try {
      const { zipSync, strToU8 } = await import('fflate');
      const names = exportFilenames(chosen);
      const entries: Record<string, Uint8Array> = {};
      chosen.forEach((m, i) => {
        entries[names[i]!] = strToU8(m.source);
      });
      download(new Blob([zipSync(entries) as unknown as BlobPart], { type: 'application/zip' }), 'usermods-export.zip');
      say(`Exported ${chosen.length} mod${chosen.length === 1 ? '' : 's'}.`);
    } catch (e) {
      fail(e);
    }
  }

  function exportOne(m: Mod) {
    download(new Blob([m.source], { type: 'text/javascript' }), exportFilename(m.name));
  }

  return (
    <>
      <div className="dash-toolbar">
        <input
          type="search"
          placeholder="Search mods by name, description or match pattern"
          value={filter.query ?? ''}
          onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
          data-testid="mod-search"
        />
        <select value={filter.site ?? ''} onChange={(e) => setFilter((f) => ({ ...f, site: e.target.value }))} data-testid="mod-site">
          <option value="">All sites</option>
          {sites.map((s) => (
            <option key={s.host} value={s.host}>
              {s.host} ({s.count})
            </option>
          ))}
        </select>
        <select
          value={filter.enabled ?? 'all'}
          onChange={(e) => setFilter((f) => ({ ...f, enabled: e.target.value as ModFilter['enabled'] }))}
          data-testid="mod-enabled"
        >
          <option value="all">Enabled and disabled</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
        </select>
        <span className="muted" data-testid="mod-count">
          {visible.length} of {mods.length} mod{mods.length === 1 ? '' : 's'}
        </span>
        <span className="row" style={{ flex: 1 }} />
        <button className="pill" onClick={() => setSelected(toggleSelectAll(selected, visible))} disabled={!visible.length}>
          {visible.length > 0 && visible.every((m) => selected.has(m.id)) ? 'Clear selection' : 'Select all'}
        </button>
      </div>

      {selection.length > 0 && (
        <div className="bulkbar" data-testid="mod-bulkbar">
          <span>{selection.length} selected</span>
          <span className="sep">·</span>
          <button className="pill" onClick={() => void bulk('enable')}>Enable</button>
          <button className="pill" onClick={() => void bulk('disable')}>Disable</button>
          <button className="pill" onClick={() => void bulkExport()}>Export zip</button>
          <button className="pill danger" onClick={() => void bulk('delete')}>Delete</button>
          <span className="row" style={{ flex: 1 }} />
          <button className="pill" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}

      {error && <div className="error" style={{ marginBottom: 10 }}>{error}</div>}
      {status && <div className="ok" style={{ marginBottom: 10 }}>{status}</div>}

      <div className="panes">
        <div>
          {!loaded && <div className="dash-empty">Loading…</div>}
          {loaded && !mods.length && <div className="dash-empty">No mods yet. Build one in the side panel's chat, or install one below.</div>}
          {loaded && mods.length > 0 && !visible.length && <div className="dash-empty">No mods match those filters.</div>}
          <div className="rows">
            {visible.map((m) => (
              <ModRow
                key={m.id}
                mod={m}
                open={openId === m.id}
                selected={selected.has(m.id)}
                onOpen={() => setOpenId((prev) => (prev === m.id ? null : m.id))}
                onToggleSelect={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(m.id)) next.delete(m.id);
                    else next.add(m.id);
                    return next;
                  })
                }
                onToggle={() => void toggle(m)}
                onExport={() => exportOne(m)}
                onUpdate={() => void update(m)}
                onDelete={() => void remove(m)}
              />
            ))}
          </div>

          <div style={{ marginTop: 22 }}>
            <div className="dash-label">Add mods</div>
            <div className="install-col">
              <InstallPanel onChanged={onChanged} onStatus={say} onError={fail} />
            </div>
          </div>
        </div>

        <div className="pane-detail">
          {open ? (
            <ModEditor key={open.id} mod={open} onSaved={onChanged} onStatus={say} onError={fail} />
          ) : (
            <div className="dash-empty">Select a mod to see and edit its source.</div>
          )}
        </div>
      </div>
    </>
  );
}

function ModRow({
  mod,
  open,
  selected,
  onOpen,
  onToggleSelect,
  onToggle,
  onExport,
  onUpdate,
  onDelete,
}: {
  mod: Mod;
  open: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggle: () => void;
  onExport: () => void;
  onUpdate: () => void;
  onDelete: () => void;
}) {
  const targets = [...mod.matches, ...mod.includeGlobs];
  const t = timeLabel(mod.updatedAt);
  return (
    <div
      className={`rowcard${open ? ' selected' : ''}${mod.enabled ? '' : ' dimmed'}`}
      data-testid="mod-row"
      data-mod-id={mod.id}
      data-enabled={mod.enabled ? 'true' : 'false'}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, a, label')) return;
        onOpen();
      }}
    >
      <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${mod.name}`} data-testid="mod-select" />
      <div className="body">
        <div className="title" data-testid="mod-name" title={mod.name}>
          {mod.name}
          {mod.version && <span className="badge" style={{ marginLeft: 6 }}>v{mod.version}</span>}
          {mod.world === 'MAIN' && (
            <span className="badge warn" style={{ marginLeft: 6 }} title="Runs in the page's own JavaScript context (@grant none or unsafeWindow).">
              page world
            </span>
          )}
        </div>
        <div className="meta">
          <span>{modSource(mod)}</span>
          <span>·</span>
          <span title={t.absolute}>{t.relative}</span>
          <span>·</span>
          <span>{formatSize(modSize(mod))}</span>
          {mod.grants.length > 0 && (
            <>
              <span>·</span>
              <span>{mod.grants.length === 1 ? mod.grants[0] : `${mod.grants.length} grants`}</span>
            </>
          )}
        </div>
        <div className="row" style={{ marginTop: 5 }}>
          {targets.slice(0, 4).map((x) => (
            <span key={x} className="chip">
              {x}
            </span>
          ))}
          {targets.length > 4 && <span className="muted" style={{ fontSize: 11 }}>+{targets.length - 4} more</span>}
          {!targets.length && <span className="muted" style={{ fontSize: 11 }}>no match patterns — this mod never runs</span>}
        </div>
      </div>
      <div className="actions">
        <label className="muted" style={{ display: 'flex', gap: 4, alignItems: 'center', fontSize: 11 }}>
          <input type="checkbox" checked={mod.enabled} onChange={onToggle} data-testid="mod-toggle" /> on
        </label>
        <button className="pill" onClick={onExport} data-testid="mod-export">
          Export
        </button>
        {mod.downloadUrl && (
          <button className="pill" onClick={onUpdate} data-testid="mod-update">
            Update
          </button>
        )}
        <button className="pill danger" onClick={onDelete} data-testid="mod-delete">
          Delete
        </button>
      </div>
    </div>
  );
}

/**
 * View and edit a mod's source. A plain <textarea> in a monospace face, not a code editor
 * component: this page is for reading a script and making a small change, and a CodeMirror would
 * be a megabyte of bundle for that. Tab inserts two spaces rather than leaving the field, which is
 * the one thing a textarea gets wrong for code.
 *
 * Saving re-parses the header through the same modFromSource path the install flow uses, so the
 * name, matches, grants and world all follow the edited header, and the background re-registers the
 * script. Parse warnings (previewFromSource's, the same ones the install screen shows) are surfaced
 * before the save rather than after.
 */
function ModEditor({
  mod,
  onSaved,
  onStatus,
  onError,
}: {
  mod: Mod;
  onSaved: () => void;
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [source, setSource] = useState(mod.source);
  const [busy, setBusy] = useState(false);

  // A mod changed elsewhere (an Update, a side-panel save) should show its new source, but not at
  // the cost of throwing away an edit in progress.
  const dirty = source !== mod.source;
  useEffect(() => {
    if (!dirty) setSource(mod.source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mod.source]);

  const preview = useMemo(() => previewFromSource(source), [source]);

  async function save() {
    setBusy(true);
    try {
      // mods.install with the mod's own id kept: it re-parses the header, refetches @require and
      // @resource if the edit changed them, and re-registers. Going through mods.save with a
      // hand-built Mod would skip the dependency resolution.
      await rpc({ type: 'mods.save', mod: reparse(mod, source) });
      onStatus(`Saved “${preview.name}”.`);
      onSaved();
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  }

  const t = timeLabel(mod.updatedAt);
  return (
    <div className="detail" data-testid="mod-editor">
      <h3 data-testid="mod-editor-name">{preview.name}</h3>
      <div className="detail-meta">
        {modSource(mod)} · {t.absolute} · {formatSize(modSize(mod))}
      </div>

      <dl className="kv">
        <dt>Runs on</dt>
        <dd>{[...preview.matches, ...preview.includeGlobs].join(' · ') || 'nothing'}</dd>
        <dt>World</dt>
        <dd>{preview.world === 'MAIN' ? 'page world (@grant none / unsafeWindow)' : 'isolated user-script world'}</dd>
        <dt>Run at</dt>
        <dd>{preview.runAt.replace('_', '-')}</dd>
        {preview.grants.length > 0 && (
          <>
            <dt>Grants</dt>
            <dd>{preview.grants.join(' · ')}</dd>
          </>
        )}
        {mod.downloadUrl && (
          <>
            <dt>Source</dt>
            <dd className="break">{mod.downloadUrl}</dd>
          </>
        )}
      </dl>

      {preview.warnings.map((w) => (
        <div key={w} className="error" data-testid="mod-editor-warning">
          {w}
        </div>
      ))}

      <textarea
        className="editor"
        value={source}
        spellCheck={false}
        data-testid="mod-editor-source"
        onChange={(e) => setSource(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          const ta = e.currentTarget;
          const { selectionStart: start, selectionEnd: end, value } = ta;
          const next = `${value.slice(0, start)}  ${value.slice(end)}`;
          setSource(next);
          requestAnimationFrame(() => ta.setSelectionRange(start + 2, start + 2));
        }}
      />

      <div className="editor-bar">
        <button className="pill primary" onClick={() => void save()} disabled={busy || !dirty} data-testid="mod-editor-save">
          {busy ? 'Saving…' : dirty ? 'Save and re-register' : 'Saved'}
        </button>
        <button className="pill" onClick={() => setSource(mod.source)} disabled={busy || !dirty}>
          Revert
        </button>
        <span className="muted">{formatSize(source.length)}</span>
      </div>
    </div>
  );
}

/**
 * The edited source as a Mod, keeping this mod's identity, enabled state and already-fetched
 * dependencies, and taking everything the header decides from the new text.
 *
 * modFromSource(source, mod) is the shared parse, but its `matches` line falls back to the existing
 * mod's patterns when the new header has none — right for an install (where a missing @match is an
 * error the caller rejects) and wrong here, where deleting a @match line must actually delete it.
 * So the parse is reused and that one field is overridden with what the header really said.
 */
function reparse(mod: Mod, source: string): Mod {
  const fresh = modFromSource(source, mod);
  return { ...fresh, matches: parseHeader(source).matches, id: mod.id, enabled: mod.enabled, createdAt: mod.createdAt };
}

function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
