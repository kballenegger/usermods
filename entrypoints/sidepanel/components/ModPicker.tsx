import { useMemo, useState } from 'react';
import { modsForUrl } from '@/lib/modmatch';
import type { Mod } from '@/lib/types';

/**
 * Pick an installed mod to edit in chat.
 *
 * It is a panel in the chat column rather than a modal, for the reason every other surface here is:
 * a 420px side panel has no room for a dialog that dims what it covers, and the thing being picked
 * from is a list the user already knows. It closes on Escape and on Cancel.
 *
 * The mods that run on the page in front of the user come FIRST, under their own heading, because
 * that is what "edit a mod" nearly always means — the one that is doing something to the page they
 * are looking at. Everything else is below it, so editing a mod for another site is still one
 * click and never the default. The search box appears only once there are enough mods to need it;
 * below that it is a field that adds a step to a list you can already read.
 *
 * A disabled mod is offered exactly like an enabled one, with a quiet marker. Editing a mod you
 * have switched off is ordinary — it is often WHY it is switched off — and saving keeps it off.
 */
export function ModPicker({ mods, pageUrl, onPick, onCancel }: { mods: Mod[]; pageUrl: string; onPick: (m: Mod) => void; onCancel: () => void }) {
  const [q, setQ] = useState('');

  const { here, elsewhere } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const match = (m: Mod) =>
      !query ||
      m.name.toLowerCase().includes(query) ||
      m.description.toLowerCase().includes(query) ||
      [...m.matches, ...m.includeGlobs].some((p) => p.toLowerCase().includes(query));
    // modsForUrl is the same function the model's prompt block is built from, so "on this page"
    // means exactly one thing across the product rather than two implementations of nearly it.
    const onPage = new Set(modsForUrl(mods, pageUrl).map((m) => m.id));
    const visible = mods.filter(match);
    return {
      here: visible.filter((m) => onPage.has(m.id)),
      elsewhere: visible.filter((m) => !onPage.has(m.id)),
    };
  }, [mods, pageUrl, q]);

  const SEARCH_AT = 6;

  return (
    <div
      className="modpicker"
      data-testid="mod-picker"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="row">
        <span className="label grow">Edit a mod</span>
        <button className="linklike" onClick={onCancel} data-testid="mod-picker-cancel">
          Cancel
        </button>
      </div>
      {mods.length >= SEARCH_AT && (
        <input
          autoFocus
          type="search"
          placeholder="Search mods"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search mods"
          data-testid="mod-picker-search"
        />
      )}
      {!mods.length && <div className="empty muted">no mods yet · build one in chat, or install one on the Mods tab</div>}
      {mods.length > 0 && !here.length && !elsewhere.length && <div className="empty muted">no mods match that</div>}
      {here.length > 0 && <div className="label modpicker-group">On this page · {here.length}</div>}
      {here.map((m) => (
        <ModPickerRow key={m.id} mod={m} onPick={onPick} />
      ))}
      {elsewhere.length > 0 && <div className="label modpicker-group">Other sites · {elsewhere.length}</div>}
      {elsewhere.map((m) => (
        <ModPickerRow key={m.id} mod={m} onPick={onPick} />
      ))}
    </div>
  );
}

function ModPickerRow({ mod, onPick }: { mod: Mod; onPick: (m: Mod) => void }) {
  const targets = [...mod.matches, ...mod.includeGlobs];
  return (
    <button
      className={`modpicker-row${mod.enabled ? '' : ' off'}`}
      onClick={() => onPick(mod)}
      title={`Edit “${mod.name}” in chat`}
      data-testid="mod-picker-row"
      data-mod-id={mod.id}
    >
      <span className="modpicker-name">{mod.name}</span>
      {!mod.enabled && <span className="modpicker-off">off</span>}
      <span className="modpicker-where">{targets[0] ?? 'no match patterns'}</span>
    </button>
  );
}
