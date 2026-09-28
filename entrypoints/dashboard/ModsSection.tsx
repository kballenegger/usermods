import { useEffect, useMemo, useRef, useState } from 'react';
import {
  bulkTargets,
  editorSync,
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
import type { Chat } from '@/lib/chats';
import { previewFromSource } from '@/lib/mods';
import { rpc } from '@/lib/rpc';
import type { Mod } from '@/lib/types';
import { InstallPanel } from './InstallPanel';
import { useModShare } from '../sidepanel/components/ExportMenu';
import { openUpdateReview, useUpdates } from '../sidepanel/useUpdates';
import { MenuButton, type MenuItem } from '../sidepanel/components/Menu';

export function ModsSection({
  mods,
  loaded,
  onChanged,
  origins = new Map(),
  onOpenChat,
  onEditMod,
}: {
  mods: Mod[];
  loaded: boolean;
  onChanged: () => void;
  /** Which chat each mod came from, by mod id (lib/dashboard modOrigins). */
  origins?: Map<string, { chat: Chat; versions: number }>;
  onOpenChat?: (chat: Chat) => void;
  /** Open this mod in a chat on its own page, with the side panel pointed at it. */
  onEditMod?: (mod: Mod) => void;
}) {
  const [filter, setFilter] = useState<ModFilter>({ site: '', enabled: 'all', query: '' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const visible = useMemo(() => filterMods(mods, filter), [mods, filter]);
  const sites = useMemo(() => modSiteOptions(mods), [mods]);
  const selection = bulkTargets(selected, visible);
  /**
   * The mod whose editor is open, derived from the current list rather than mirrored in state. Same
   * rule as the chats pane: a mod deleted elsewhere closes its editor by not being found, on the
   * render the deletion arrives in. The effect that used to do this as well ran a render later and
   * could only ever agree with the derivation, so it is gone.
   *
   * `mods`, not `visible`: a mod the filter is hiding is still open and still editable, which is a
   * different thing from a mod that no longer exists.
   */
  const open = openId ? mods.find((m) => m.id === openId) : undefined;

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
      // A check, never an install: a newer version opens the review screen, where the user decides.
      const r = await rpc({ type: 'mods.update', id: m.id });
      if (r.available) {
        say(`“${m.name}” v${r.available} is available. Review it in the tab that opened; nothing changes until you install it.`);
        openUpdateReview(m.id);
      } else say(`“${m.name}” is up to date.`);
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

  // Export: download, copy, and sharing to a gist or Greasy Fork (sidepanel/components/ExportMenu).
  const share = useModShare({ onStatus: say, onError: fail, onChanged });
  const updates = useUpdates();

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
      {(share.prompt || share.notices) && <div className="dash-share">{share.prompt}{share.notices}</div>}

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
                origin={origins.get(m.id)}
                onOpenChat={onOpenChat}
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
                onEdit={onEditMod ? () => onEditMod(m) : undefined}
                exportItems={share.items(m)}
                update={updates.summary[m.id]}
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
  origin,
  onOpenChat,
  open,
  selected,
  onOpen,
  onToggleSelect,
  onToggle,
  onEdit,
  exportItems,
  update,
  onUpdate,
  onDelete,
}: {
  mod: Mod;
  /** The chat whose draft this mod is, when it has one. */
  origin?: { chat: Chat; versions: number };
  onOpenChat?: (chat: Chat) => void;
  open: boolean;
  selected: boolean;
  onOpen: () => void;
  onToggleSelect: () => void;
  onToggle: () => void;
  /** Open this mod in a chat. Absent when the page cannot do the handoff. */
  onEdit?: () => void;
  /** Download, copy, share as a gist, publish on Greasy Fork. */
  exportItems: MenuItem[];
  /** A waiting update or a quiet check error (useUpdates). */
  update?: { available?: string; error?: string };
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
          {/* A mod that is a chat's saved draft says so, and says which version it is at. It is the
              inverse of the draft panel's "saved · updates in place": from here you can get back to
              the conversation that wrote it and ask for the next change, rather than editing the
              source by hand and losing the thread. */}
          {origin && (
            <>
              <span>·</span>
              <span data-testid="mod-origin">
                from chat{' '}
                <button
                  className="linklike"
                  onClick={() => onOpenChat?.(origin.chat)}
                  disabled={!onOpenChat}
                  title={`Open "${origin.chat.title}" on its page with the side panel`}
                  data-testid="mod-origin-open"
                >
                  “{origin.chat.title}”
                </button>
                {origin.versions > 0 ? ` · v${origin.versions}` : ''}
              </span>
            </>
          )}
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
        {/* The primary verb on a mod row, because it is the one that leads somewhere rather than
            producing a file: it opens the mod in a chat on its own page. The others stay plain
            pills, and this one keeps the same shape so the row does not grow a hero. */}
        {onEdit && (
          <button className="pill" onClick={onEdit} aria-label={`Edit “${mod.name}” in chat`} title={`Open “${mod.name}” in a chat on its page and keep building on it`} data-testid="mod-edit-in-chat">
            Edit in chat
          </button>
        )}
        <MenuButton label={`Export “${mod.name}”`} title="Download, copy, or share this mod" className="pill" testId="mod-export" items={exportItems} placement="down">
          Export ▾
        </MenuButton>
        {update?.available ? (
          <button className="pill" onClick={() => openUpdateReview(mod.id)} data-testid="mod-update-available" title="Review the new version; nothing installs until you say so">
            Update available v{update.available}
          </button>
        ) : (
          mod.downloadUrl && (
            <button className="pill" onClick={onUpdate} data-testid="mod-update" title={update?.error ? `Last check: ${update.error}` : 'Check for a newer version now'}>
              Update
            </button>
          )
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
 * Saving goes to the background's mods.saveSource, which re-parses the header, refetches @require
 * and @resource when the edit changed them, and re-registers — not mods.save, which takes a Mod the
 * page built and resolves no dependencies, so an edit that added an @require line would re-register
 * the script with that dependency missing and it would throw at page load. Parse warnings
 * (previewFromSource's, the same ones the install screen shows) are surfaced before the save, and a
 * dependency fetch failure comes back as an error here rather than as a saved-but-broken mod.
 *
 * Dirtiness is tracked explicitly rather than derived from `source !== mod.source`. A derived flag
 * is wrong the moment mod.source changes underneath — an Update, a save from the side panel — while
 * the editor holds the same text: the comparison flips to "dirty" on its own, the editor keeps
 * showing the old text, and Save would write the pre-update source back over the update. Instead an
 * edit sets the flag, a save or a revert clears it, and a ref holds the mod.source last seen: when
 * the mod changes externally and the editor is clean, the new text is adopted silently; when it
 * changes with unsaved edits in the box, neither side is thrown away — a notice offers the choice
 * and Save is blocked until one is made.
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
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The mod.source this editor last reconciled with, so a change to it is detectable. */
  const seenRef = useRef(mod.source);
  /** Set when the mod changed elsewhere while there were unsaved edits here; cleared by a choice. */
  const [conflict, setConflict] = useState<string | null>(null);

  // A mod changed elsewhere (an Update, a save from the side panel) should show its new source, but
  // not at the cost of throwing away an edit in progress — and not at the cost of writing the old
  // text back over the new one either.
  useEffect(() => {
    const what = editorSync({ modSource: mod.source, seen: seenRef.current, dirty });
    if (what === 'none') return;
    if (what === 'adopt') {
      seenRef.current = mod.source;
      setSource(mod.source);
      setConflict(null);
      return;
    }
    // Unsaved edits here and a different source there: keep both and make the user choose.
    setConflict(mod.source);
  }, [mod.source, dirty]);

  /** Take the version saved elsewhere, dropping the edits in the box. */
  function loadIncoming() {
    const incoming = conflict ?? mod.source;
    seenRef.current = incoming;
    setSource(incoming);
    setDirty(false);
    setConflict(null);
  }

  /** Keep editing this text; the next Save writes it over whatever landed in between. */
  function keepMine() {
    seenRef.current = mod.source;
    setConflict(null);
  }

  const preview = useMemo(() => previewFromSource(source), [source]);

  async function save() {
    // A save while the mod is contested would silently pick a winner; the choice is explicit.
    if (conflict !== null) return;
    setBusy(true);
    try {
      // mods.saveSource, not mods.save: the background re-parses the header, refetches @require and
      // @resource when the edit changed them, and re-registers. mods.save takes a Mod built here and
      // resolves nothing, so an added @require would re-register with the dependency missing.
      await rpc({ type: 'mods.saveSource', id: mod.id, source });
      seenRef.current = source;
      setDirty(false);
      onStatus(`Saved “${preview.name}”.`);
      onSaved();
    } catch (e) {
      // A dependency that would not fetch, or a header with nothing to match on: nothing was
      // written, the edits stay in the box, and the reason is on screen.
      onError(e);
    }
    setBusy(false);
  }

  function edit(next: string) {
    setSource(next);
    setDirty(true);
  }

  function revert() {
    const base = conflict ?? mod.source;
    seenRef.current = base;
    setSource(base);
    setDirty(false);
    setConflict(null);
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
        {mod.share?.gist && (
          <>
            <dt>Gist</dt>
            <dd className="break" data-testid="mod-editor-gist">
              <a href={mod.share.gist.url} target="_blank" rel="noopener noreferrer">{mod.share.gist.url}</a>
              <br />
              install link: {mod.share.gist.rawUrl}
            </dd>
          </>
        )}
        {mod.share?.greasyFork && (
          <>
            <dt>Greasy Fork</dt>
            <dd className="break">
              <a href={mod.share.greasyFork.url} target="_blank" rel="noopener noreferrer">{mod.share.greasyFork.url}</a>
            </dd>
          </>
        )}
      </dl>

      {preview.warnings.map((w) => (
        <div key={w} className="error" data-testid="mod-editor-warning">
          {w}
        </div>
      ))}

      {conflict !== null && (
        <div className="notice" data-testid="mod-editor-conflict">
          This mod changed elsewhere while you were editing it. Saving now would overwrite that
          change; loading it would drop your edits. Pick one.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="pill" onClick={loadIncoming} data-testid="mod-editor-load-new">
              Load new version
            </button>
            <button className="pill" onClick={keepMine} data-testid="mod-editor-keep-mine">
              Keep my edits
            </button>
          </div>
        </div>
      )}

      <textarea
        className="editor"
        value={source}
        spellCheck={false}
        data-testid="mod-editor-source"
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Tab' || e.metaKey || e.ctrlKey || e.altKey) return;
          e.preventDefault();
          const ta = e.currentTarget;
          const { selectionStart: start, selectionEnd: end, value } = ta;
          const next = `${value.slice(0, start)}  ${value.slice(end)}`;
          edit(next);
          requestAnimationFrame(() => ta.setSelectionRange(start + 2, start + 2));
        }}
      />

      <div className="editor-bar">
        <button
          className="pill primary"
          onClick={() => void save()}
          disabled={busy || !dirty || conflict !== null}
          data-testid="mod-editor-save"
        >
          {busy ? 'Saving…' : conflict !== null ? 'Choose a version first' : dirty ? 'Save and re-register' : 'Saved'}
        </button>
        <button className="pill" onClick={revert} disabled={busy || (!dirty && conflict === null)}>
          Revert
        </button>
        <span className="muted">{formatSize(source.length)}</span>
      </div>
    </div>
  );
}

function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}
