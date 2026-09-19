// The model picker: a compact control under the composer that says which model this chat talks
// to, and changes it.
//
// It is the ARIA combobox-with-listbox pattern, opened from a button. Closed, it is one button
// whose label is the model (and, where there is room, the provider). Open, focus sits in a single
// text field that does two jobs — it filters the list, and whatever is typed into it can be used as
// a model id on any connected provider, which is the only way to pick a model on an endpoint that
// cannot list them. The options themselves never take focus: the field points at the active one
// with aria-activedescendant, so typing and arrowing never fight over where the caret is.
//
//   ↑ / ↓        move through the options, across providers      Home / End   first / last
//   Enter        pick the active option                          Escape       close, focus returns
//   Tab          on to Refresh and Manage providers, then out, which closes it
//
// It opens UPWARD, because the composer is the last thing in the panel, and it is as wide as the
// composer rather than as wide as its button, so a long model id has the whole 320px to be read in.
//
// Everything it shows comes in as props, and everything it changes goes out through callbacks: it
// reads no storage and sends no messages, apart from asking the background to refresh a listing.
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  modelsStale,
  pickerGroups,
  sameSelection,
  type ConnectionsState,
  type ModelSelection,
  type ResolvedSelection,
  type SignedIn,
} from '@/lib/connections';
import { rpc } from '@/lib/rpc';
import './modelpicker.css';

/** What the closed button says when the chat has no usable model. Exported for the smoke flow's docs. */
export const PICK_A_MODEL = 'Pick a model';
export const NO_PROVIDER = 'No provider connected';
export const NEXT_TURN_NOTE = 'Applies from the next turn. The reply in progress stays on the model it started with.';

interface Option {
  key: string;
  connectionId: string;
  label: string;
  model: string;
  /** True for the "use what I typed" row, which also remembers the id on the connection. */
  typed: boolean;
}

export function ModelPicker({
  state,
  signedIn,
  selection,
  resolved,
  note,
  disabled,
  onSelect,
  onManage,
}: {
  state: ConnectionsState;
  signedIn: SignedIn;
  /** The chat's selection as stored, usable or not. */
  selection: ModelSelection | null;
  /** That selection, resolved: either a connection and a model, or the reason there is none. */
  resolved: ResolvedSelection;
  /** A line shown beside the button: that a swap waits for the next turn. */
  note?: string;
  disabled?: boolean;
  onSelect: (selection: ModelSelection, typed: boolean) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(0);
  const [refreshing, setRefreshing] = useState<ReadonlySet<string>>(() => new Set());
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const groups = useMemo(() => pickerGroups(state, signedIn, filter), [state, signedIn, filter]);
  const typed = filter.trim();

  /**
   * The options in the order they are drawn, flat, so ↑/↓ can walk across the groups: every listed
   * model that matches, provider by provider, and AFTER all of them what was typed, offered as an id
   * on each provider that does not already list exactly that. After, so that typing "son" and
   * pressing Enter picks claude-sonnet, not a model called "son".
   */
  const options = useMemo(() => {
    const out: Option[] = [];
    for (const g of groups) {
      for (const model of g.models) out.push({ key: `${g.connection.id}\n${model}`, connectionId: g.connection.id, label: g.connection.label, model, typed: false });
    }
    if (typed && !/\s/.test(typed)) {
      for (const g of groups) {
        if (!g.models.includes(typed)) out.push({ key: `${g.connection.id}\n\n${typed}`, connectionId: g.connection.id, label: g.connection.label, model: typed, typed: true });
      }
    }
    return out;
  }, [groups, typed]);

  const current: ModelSelection | null = resolved.ok ? resolved.selection : null;

  function close(returnFocus: boolean) {
    setOpen(false);
    setFilter('');
    if (returnFocus) buttonRef.current?.focus();
  }

  /** Ask the background to list these connections again. The result arrives through storage. */
  async function refresh(ids: string[]) {
    if (!ids.length) return;
    setRefreshing((prev) => new Set([...prev, ...ids]));
    await Promise.all(ids.map((connectionId) => rpc({ type: 'models.list', connectionId }).catch(() => null)));
    setRefreshing((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.delete(id);
      return next;
    });
  }

  function openPicker() {
    if (disabled) return;
    setOpen(true);
    setFilter('');
    // Start on the model in use, so Enter straight away changes nothing and ↓ moves from where you are.
    const all = pickerGroups(state, signedIn, '').flatMap((g) => g.models.map((m) => ({ connectionId: g.connection.id, model: m })));
    setActive(Math.max(0, current ? all.findIndex((o) => sameSelection(o, current)) : 0));
    // A listing that was never fetched, failed, fell back, or is a day old is fetched again now.
    void refresh(state.list.filter((c) => groupsHas(state, signedIn, c.id) && modelsStale(c)).map((c) => c.id));
  }

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Keep the active option inside the list as the filter narrows it, and in view as it moves.
  useEffect(() => {
    if (!open) return;
    if (active > options.length - 1) setActive(Math.max(0, options.length - 1));
    document.getElementById(`${listId}-o${Math.min(active, options.length - 1)}`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active, options.length, listId]);

  // A click anywhere else, or focus leaving, closes it. Focus moving WITHIN it (field → Refresh)
  // does not.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function pick(o: Option) {
    onSelect({ connectionId: o.connectionId, model: o.model, label: o.label }, o.typed);
    close(true);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const last = options.length - 1;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActive((i) => (last < 0 ? 0 : i >= last ? 0 : i + 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActive((i) => (last < 0 ? 0 : i <= 0 ? last : i - 1));
        break;
      case 'Home':
        if (!filter) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (!filter) {
          e.preventDefault();
          setActive(Math.max(0, last));
        }
        break;
      case 'Enter': {
        e.preventDefault();
        const o = options[active];
        if (o) pick(o);
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
    }
  }

  const connected = pickerGroups(state, signedIn, '');
  // "No provider connected" only when that is the whole story. A chat whose own provider was
  // removed still says "Pick a model", with the reason beside it, even if nothing else is connected.
  const buttonText = current ? current.model : !resolved.ok && resolved.problem === 'no-providers' ? NO_PROVIDER : PICK_A_MODEL;
  const problem = resolved.ok ? '' : resolved.message;
  let index = -1;
  const typedOptions = options.filter((o) => o.typed);

  const renderOption = (o: Option) => {
    index += 1;
    const i = index;
    const selected = !o.typed && sameSelection(o, current);
    return (
      <div
        key={o.key}
        id={`${listId}-o${i}`}
        role="option"
        aria-selected={selected}
        className={`model-option${i === active ? ' active' : ''}${selected ? ' selected' : ''}${o.typed ? ' typed' : ''}`}
        data-testid="model-option"
        data-model={o.model}
        data-connection={o.connectionId}
        // mousedown, not click: the field's blur would close the list before a click landed.
        onMouseDown={(e) => {
          e.preventDefault();
          pick(o);
        }}
        onMouseMove={() => setActive(i)}
      >
        <span className="model-check" aria-hidden="true">{selected ? '●' : ''}</span>
        <span className="model-option-name">{o.typed ? `Use “${o.model}” on ${o.label}` : o.model}</span>
      </div>
    );
  };

  return (
    <div
      className="model-line"
      ref={rootRef}
      data-testid="model-line"
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={`model-button${current ? '' : ' unset'}`}
        data-testid="model-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={current ? `Model: ${current.model}, on ${current.label ?? 'a provider'}. Change model` : `${buttonText}. Choose a model`}
        title={current ? `${current.model} · ${current.label ?? ''}` : buttonText}
        disabled={disabled}
        onClick={() => (open ? close(true) : openPicker())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            openPicker();
          }
        }}
      >
        <span className="model-name">{buttonText}</span>
        {current?.label && <span className="model-provider">{current.label}</span>}
        <span className="model-caret" aria-hidden="true">▾</span>
      </button>
      {(problem || note) && (
        <span className={`model-note${problem ? ' problem' : ''}`} data-testid="model-note" role={problem ? 'alert' : 'status'}>
          {problem || note}
        </span>
      )}

      {open && (
        <div className="model-pop" data-testid="model-pop">
          <input
            ref={inputRef}
            className="model-filter"
            data-testid="model-filter"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options[active] ? `${listId}-o${active}` : undefined}
            aria-label="Filter models, or type a model id"
            placeholder="filter, or type a model id"
            value={filter}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setFilter(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <div className="model-list" id={listId} role="listbox" aria-label="Models from connected providers">
            {connected.length === 0 && (
              <div className="model-empty" data-testid="model-empty">
                No provider is connected yet. Add an API key, a local server or a subscription sign-in in Settings, and its
                models appear here.
              </div>
            )}
            {groups.map((g) => {
              const cache = g.connection.models;
              const mine = options.filter((o) => !o.typed && o.connectionId === g.connection.id);
              // While filtering, a provider with nothing that matches steps aside; what was typed can
              // still be used on it, from the group at the end.
              if (typed && mine.length === 0) return null;
              return (
                <div key={g.connection.id} role="group" aria-label={g.connection.label} className="model-group" data-testid="model-group" data-connection={g.connection.id}>
                  <div className="model-group-head">
                    <span className="model-group-name">{g.connection.label}</span>
                    {refreshing.has(g.connection.id) ? (
                      <span className="model-group-meta">refreshing…</span>
                    ) : cache?.fallback ? (
                      <span className="model-group-meta" title={cache.error}>built-in list</span>
                    ) : cache?.error ? (
                      <span className="model-group-meta" title={cache.error}>could not list</span>
                    ) : null}
                  </div>
                  {mine.map(renderOption)}
                  {mine.length === 0 && (
                    <div className="model-group-none">
                      {cache?.error && !cache.fallback
                        ? 'Could not list this provider’s models. Type a model id above to use it.'
                        : 'No models listed yet. Type a model id above to use it.'}
                    </div>
                  )}
                </div>
              );
            })}
            {typedOptions.length > 0 && (
              <div role="group" aria-label="Use what you typed as a model id" className="model-group" data-testid="model-typed-group">
                <div className="model-group-head">
                  <span className="model-group-name">Use as a model id</span>
                </div>
                {typedOptions.map(renderOption)}
              </div>
            )}
            {typed && options.length === 0 && connected.length > 0 && <div className="model-group-none">No match. A model id cannot contain spaces.</div>}
          </div>
          <div className="model-foot">
            <button
              type="button"
              className="linklike"
              data-testid="model-refresh"
              disabled={!connected.length || refreshing.size > 0}
              onClick={() => void refresh(connected.map((g) => g.connection.id))}
            >
              {refreshing.size > 0 ? 'Refreshing…' : 'Refresh models'}
            </button>
            <span className="grow" />
            <button
              type="button"
              className="linklike"
              data-testid="model-manage"
              onClick={() => {
                close(false);
                onManage();
              }}
            >
              Manage providers…
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function groupsHas(state: ConnectionsState, signedIn: SignedIn, id: string): boolean {
  return pickerGroups(state, signedIn, '').some((g) => g.connection.id === id);
}
