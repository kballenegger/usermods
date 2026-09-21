// Settings → Providers: the list of connections, and the presets that add one.
//
// Each connection is a card with a one-line summary (a status dot, its name, and in words whether it
// is connected) that opens into its form: name, endpoint, key or sign-in, Images, and its model
// list. Which model a chat uses is NOT chosen here any more — that is the picker under the composer
// — so there is no model field, only "Fetch models" and what the last fetch found.
//
// Every edit autosaves, and saves as a PATCH to the one connection it belongs to
// (mutateConnections re-reads the list before writing), because the background writes model
// listings into the same list while a key is being typed.
import { useEffect, useRef, useState } from 'react';
import { SAFARI_BUILD, SUBSCRIPTIONS_OFF, isSubscriptionProvider } from '@/lib/buildflags';
import { isLocalBaseUrl, localBaseUrlNote } from '@/lib/mobile';
import { useShell } from './shell';
import { usePointerEnvironment } from './usePointer';
import { relativeTime } from '@/lib/chats';
import {
  addConnection,
  canAdd,
  connectionFromPreset,
  connectionStatus,
  mutateConnections,
  offeredModels,
  presetsFor,
  removeConnection,
  statusText,
  updateConnection,
  type Connection,
  type ConnectionPatch,
  type ProviderPreset,
} from '@/lib/connections';
import { FALLBACK_NOTE } from '@/lib/modellist';
import { resolveImagesSetting } from '@/lib/providers/vision';
import { CUSTOM_FIELDS_MAX, parseCustomFields, resolveReasoningField, type ReasoningField } from '@/lib/thinking';
import { rpc, type OAuthKind, type OAuthLoginState } from '@/lib/rpc';
import type { ImagesSetting } from '@/lib/types';
import type { ConnectionsView } from './useConnections';
import './providers.css';

const SAVE_DEBOUNCE_MS = 300;

/** What each kind speaks, for the line under a card's name. */
function kindText(c: Connection): string {
  switch (c.kind) {
    case 'anthropic':
      return 'Anthropic Messages API';
    case 'openai-compatible':
      return 'OpenAI-compatible (chat/completions)';
    case 'chatgpt':
      return 'Sign in with ChatGPT';
    case 'xai':
      return 'SuperGrok / X Premium+ sign-in';
  }
}

export function ProvidersSection({ view, onSaving }: { view: ConnectionsView; onSaving: (saving: boolean) => void }) {
  const { state, signedIn } = view;
  /** The one card that is open. A provider you just added opens itself, because it needs a key. */
  const [openId, setOpenId] = useState<string | null>(null);
  const opened = useRef(false);

  // With a single provider there is nothing to choose between, so its form is simply shown.
  useEffect(() => {
    if (opened.current || !view.ready) return;
    opened.current = true;
    if (state.list.length === 1) setOpenId(state.list[0]?.id ?? null);
  }, [view.ready, state.list]);

  async function add(preset: ProviderPreset) {
    const id = crypto.randomUUID();
    onSaving(true);
    await mutateConnections((s) => (canAdd(preset.kind, s.list) ? addConnection(s, connectionFromPreset(preset, s.list, id)) : s)).catch(() => {});
    onSaving(false);
    setOpenId(id);
  }

  const unavailable = state.list.filter((c) => connectionStatus(c, signedIn) === 'unavailable');

  // Where the chat keeps its model control: under the message box in the panel and the Mac popover,
  // a chip in the top bar of the compact (iPhone, iPad) shell.
  const modelWhere = useShell().compact ? 'from the model name at the top' : 'under the message box';
  return (
    <section className="providers" data-testid="providers">
      <div className="label">Providers</div>
      <p className="providers-intro">
        Connect as many as you like. The model is chosen in the chat itself, {modelWhere}, from every provider
        that is connected — and can be changed at any point in a conversation.
      </p>

      {unavailable.length > 0 && (
        <p className="error providers-unavailable">
          ▲ This build of usermods does not include subscription sign-in, so {unavailable.map((c) => c.label).join(' and ')}{' '}
          cannot be used here. {unavailable.length === 1 ? 'It is' : 'They are'} kept as {unavailable.length === 1 ? 'it was' : 'they were'}: add a
          provider with an API key below, or install the GitHub build to use {unavailable.length === 1 ? 'it' : 'them'} again.
        </p>
      )}

      {view.ready && state.list.length === 0 && (
        <p className="providers-none" data-testid="providers-none">
          No provider yet. Pick one below: an API key, a server on your own machine{SUBSCRIPTIONS_OFF ? '' : ', or a ChatGPT or SuperGrok subscription'}.
        </p>
      )}

      <div className="provider-list">
        {state.list.map((c) => (
          <ConnectionCard
            key={c.id}
            conn={c}
            status={connectionStatus(c, signedIn)}
            open={openId === c.id}
            onToggle={() => setOpenId((cur) => (cur === c.id ? null : c.id))}
            onSaving={onSaving}
          />
        ))}
      </div>

      <div className="label providers-add-label">Add provider</div>
      <div className="row providers-add">
        {presetsFor().map((p) => (
          <button
            key={p.label}
            type="button"
            className="btn"
            data-testid="add-provider"
            data-preset={p.label}
            disabled={!canAdd(p.kind, state.list)}
            title={canAdd(p.kind, state.list) ? `Add ${p.label}` : `${p.label} is already in the list: one sign-in per vendor`}
            onClick={() => void add(p)}
          >
            {p.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function ConnectionCard({
  conn,
  status,
  open,
  onToggle,
  onSaving,
}: {
  conn: Connection;
  status: ReturnType<typeof connectionStatus>;
  open: boolean;
  onToggle: () => void;
  onSaving: (saving: boolean) => void;
}) {
  // The inputs are local state, seeded once: the stored connection changes underneath them (the
  // background caches a listing, another view renames it) and none of that may move a caret.
  const [label, setLabel] = useState(conn.label);
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl);
  const [apiKey, setApiKey] = useState(conn.apiKey);
  const [images, setImages] = useState<ImagesSetting>(resolveImagesSetting(conn.images));
  const [reasoningField, setReasoningField] = useState<ReasoningField>(resolveReasoningField(conn.reasoningField));
  // Kept as TEXT, not as parsed JSON: a half-typed object has to survive a keystroke and be shown
  // back with its error, which a parsed value cannot do.
  const [customFields, setCustomFields] = useState(conn.customFields ?? '');
  /** Shown under the box instead of the help line while the JSON does not parse. */
  const customFieldsError = parseCustomFields(customFields).error;
  const [confirming, setConfirming] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState('');
  const pending = useRef<ConnectionPatch>({});
  const timer = useRef<number | null>(null);
  // Which localhost note to show. Settings is reachable from the popup and from the dashboard, and
  // on iOS both of those are the phone, so this is asked of the device rather than of the surface.
  const { coarsePointer } = usePointerEnvironment();
  const subscription = !SUBSCRIPTIONS_OFF && isSubscriptionProvider(conn.kind);
  const formId = `provider-${conn.id}`;

  /** Write whatever is waiting, now. Returns the stored connection, which may have a de-duplicated label. */
  async function flush(): Promise<Connection | undefined> {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return undefined;
    try {
      const next = await mutateConnections((s) => updateConnection(s, conn.id, patch));
      return next.list.find((c) => c.id === conn.id);
    } finally {
      if (timer.current == null) onSaving(false);
    }
  }

  function save(patch: ConnectionPatch) {
    pending.current = { ...pending.current, ...patch };
    onSaving(true);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }

  // Leaving Settings with a key half-saved would lose it.
  useEffect(() => () => void flush(), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchModels() {
    setFetchError('');
    setFetching(true);
    try {
      await flush(); // the background reads the stored connection to know what to ask
      await rpc({ type: 'models.list', connectionId: conn.id });
    } catch (e) {
      setFetchError(e instanceof Error ? e.message : String(e));
    } finally {
      setFetching(false);
    }
  }

  async function remove() {
    pending.current = {};
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    onSaving(true);
    await mutateConnections((s) => removeConnection(s, conn.id)).catch(() => {});
    onSaving(false);
  }

  const cache = conn.models;
  const count = offeredModels(conn).length;
  const modelsLine = fetching
    ? 'Fetching…'
    : fetchError && !cache?.fallback
      ? fetchError
      : cache?.fallback
        ? `${cache.error ?? 'Could not list models.'} ${FALLBACK_NOTE}`
        : cache?.error
          ? cache.error
          : cache
            ? `${cache.ids.length} model${cache.ids.length === 1 ? '' : 's'} listed · updated ${relativeTime(cache.fetchedAt)} ago`.replace('now ago', 'just now')
            : count
              ? `${count} model${count === 1 ? '' : 's'} to pick from. Fetch to see everything this provider offers.`
              : 'No model list yet. Fetch it here, or type a model id in the chat’s model picker.';
  const modelsBad = !fetching && (!!fetchError || !!cache?.error);

  return (
    <div className={`card provider${open ? ' open' : ''}`} data-testid="provider-card" data-connection={conn.id} data-kind={conn.kind} data-status={status}>
      <div className="provider-head">
        <button type="button" className="provider-toggle" aria-expanded={open} aria-controls={formId} onClick={onToggle} data-testid="provider-toggle">
          <span className={`dot${status === 'connected' ? '' : status === 'unavailable' ? ' error' : ' off'}`} aria-hidden="true" />
          <span className="provider-title">
            <span className="provider-name">{conn.label}</span>
            <span className="provider-status" data-testid="provider-status">{statusText(status)}</span>
          </span>
          <span className="provider-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
        </button>
      </div>

      {open && (
        <div className="provider-form" id={formId}>
          <div className="provider-kind">{kindText(conn)}</div>
          <label className="field">
            Name
            <input
              data-testid="provider-name"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                save({ label: e.target.value });
              }}
              onBlur={() => void flush().then((stored) => stored && setLabel(stored.label))}
            />
          </label>

          {subscription ? (
            <SubscriptionLogin kind={conn.kind as OAuthKind} />
          ) : status === 'unavailable' ? null : (
            <>
              <label className="field">
                Base URL
                <input
                  data-testid="provider-base-url"
                  value={baseUrl}
                  onChange={(e) => {
                    setBaseUrl(e.target.value);
                    save({ baseUrl: e.target.value });
                  }}
                  placeholder={conn.kind === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'}
                  spellCheck={false}
                />
                <span>
                  Any endpoint that speaks the {conn.kind === 'anthropic' ? 'Anthropic Messages' : 'OpenAI chat completions'} API works here,
                  including a local proxy in front of a subscription.
                </span>
                {/*
                  On iPhone and iPad, "localhost" is the phone. Typing the address off a desktop
                  setup is the obvious thing to do and it fails in a way that looks like the server
                  is down rather than like the address is wrong, so the correction is shown at the
                  moment the address is typed, and only then, since a working URL needs no note. On
                  a Mac the same address is right, and the note says so in one line instead of
                  warning about a problem that platform does not have.
                */}
                {SAFARI_BUILD && isLocalBaseUrl(baseUrl) && (
                  <span className={coarsePointer ? 'warn' : 'muted'}>{localBaseUrlNote(coarsePointer)}</span>
                )}
              </label>
              <label className="field">
                API key
                <input
                  data-testid="provider-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => {
                    setApiKey(e.target.value);
                    save({ apiKey: e.target.value });
                  }}
                  autoComplete="off"
                />
                <span>Leave empty for local servers and proxies that do not need one.</span>
              </label>
            </>
          )}

          {/*
            Whether a picture is actually sent, which only the OpenAI-compatible adapter has to ask:
            "OpenAI-compatible" is whatever endpoint was typed in, and half of what speaks that
            protocol is a text-only model that answers an image with a 400. It is per provider
            because it is a fact about an endpoint, and two of them can need different answers.
          */}
          {conn.kind === 'openai-compatible' && (
            <label className="field">
              Images
              <select
                data-testid="settings-images"
                value={images}
                onChange={(e) => {
                  const next = e.target.value as ImagesSetting;
                  setImages(next);
                  save({ images: next });
                }}
              >
                <option value="auto">Auto — send, and stop if the model refuses</option>
                <option value="send">Always send</option>
                <option value="never">Never send</option>
              </select>
              <span>
                Whether screenshots and your attachments are sent to this endpoint as pictures. Auto is the default: it sends
                them, and if the model answers that it cannot accept images, usermods sends that request again without them
                and leaves them out for this endpoint from then on. Choose Never for a text-only model to skip the first
                refusal.
              </span>
            </label>
          )}

          {/*
            Which reasoning field this endpoint takes (lib/thinking.ts). Per connection for the same
            reason Images is: "OpenAI-compatible" is whatever URL was typed in, and the protocol has
            no way to ask. Auto guesses from the model id and sends nothing when it cannot; the
            explicit choices are for the servers the guess gets wrong, and the JSON box below is for
            the ones nothing can guess at all.
          */}
          {conn.kind === 'openai-compatible' && (
            <>
              <label className="field">
                Reasoning field
                <select
                  data-testid="settings-reasoning-field"
                  value={reasoningField}
                  onChange={(e) => {
                    const next = e.target.value as ReasoningField;
                    setReasoningField(next);
                    save({ reasoningField: next });
                  }}
                >
                  <option value="auto">Auto — guess from the model name</option>
                  <option value="reasoning_effort">reasoning_effort</option>
                  <option value="enable_thinking">chat_template_kwargs: enable_thinking</option>
                  <option value="none">None — this model has no reasoning setting</option>
                </select>
                <span>
                  How the Thinking level in the composer is sent to this endpoint. Auto uses reasoning_effort for OpenAI’s
                  o-series and GPT-5 models, enable_thinking for Qwen 3, and sends nothing for anything it does not
                  recognise. If a server answers 400 to the field, usermods sends that request again without it and leaves
                  it out for that model from then on.
                </span>
              </label>
              <label className="field">
                Custom request fields
                <textarea
                  data-testid="settings-custom-fields"
                  rows={2}
                  spellCheck={false}
                  placeholder={'{"reasoning_effort": "low"}'}
                  value={customFields}
                  maxLength={CUSTOM_FIELDS_MAX}
                  onChange={(e) => {
                    setCustomFields(e.target.value);
                    save({ customFields: e.target.value });
                  }}
                />
                <span data-testid="settings-custom-fields-note" className={customFieldsError ? 'problem' : undefined}>
                  {customFieldsError
                    ? customFieldsError
                    : 'Extra JSON merged into every request to this endpoint, for a server whose reasoning knob is none of the above. Invalid JSON is not sent.'}
                </span>
              </label>
            </>
          )}

          {status !== 'unavailable' && (
            <div className="provider-models">
              <div className="row">
                <button type="button" className="btn" data-testid="provider-fetch" onClick={() => void fetchModels()} disabled={fetching}>
                  Fetch models
                </button>
                <span className="grow" />
                {confirming ? null : (
                  <button type="button" className="btn danger" data-testid="provider-remove" aria-label={`Remove ${conn.label}`} onClick={() => setConfirming(true)}>
                    Remove
                  </button>
                )}
              </div>
              <span className={`provider-models-status${modelsBad ? ' error' : ''}`} data-testid="provider-models-status" role="status">
                {modelsLine}
              </span>
            </div>
          )}
          {status === 'unavailable' && !confirming && (
            <div className="row">
              <span className="grow" />
              <button type="button" className="btn danger" data-testid="provider-remove" aria-label={`Remove ${conn.label}`} onClick={() => setConfirming(true)}>
                Remove
              </button>
            </div>
          )}

          {confirming && (
            <div className="provider-confirm" role="alertdialog" aria-label={`Remove ${conn.label}?`}>
              <span>
                Remove {conn.label}? {subscription ? 'You stay signed in until you sign out above.' : 'Its API key is deleted from this device.'}{' '}
                Chats that use it will ask you to pick another model.
              </span>
              <div className="row">
                <button type="button" className="btn danger" data-testid="provider-remove-confirm" onClick={() => void remove()}>
                  Remove provider
                </button>
                <button type="button" className="btn" onClick={() => setConfirming(false)}>
                  Keep
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Put the user code on the clipboard, and say whether it worked.
 *
 * `navigator.clipboard.writeText` is not something to assume in a Safari extension popup. WebKit
 * gates it on a transient user activation AND on a secure context, and an extension page's
 * `safari-web-extension://` origin has been treated inconsistently across versions; on iOS the
 * whole Clipboard API has a history of resolving without writing anything. So the promise is
 * awaited rather than fire-and-forgotten, and a rejection is a real answer rather than a shrug.
 *
 * The fallback is not another API: it is selecting the code, which is what a person does anyway,
 * and which works in every engine with no permission at all. The caller shows the code in a
 * read-only <input> for exactly this reason — `select()` on an input is reliable where
 * `getSelection().addRange()` over a <div> is not.
 */
async function copyUserCode(code: string, field: HTMLInputElement | null): Promise<'copied' | 'selected'> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      return 'copied';
    }
  } catch {
    // Fall through: below is the version that needs nothing.
  }
  if (field) {
    field.focus();
    field.select();
    field.setSelectionRange(0, code.length);
  }
  return 'selected';
}

function SubscriptionLogin({ kind }: { kind: OAuthKind }) {
  const [status, setStatus] = useState<{ signedIn: boolean; label?: string } | null>(null);
  const [login, setLogin] = useState<OAuthLoginState>({ status: 'idle' });
  const [copied, setCopied] = useState<'copied' | 'selected' | null>(null);
  const timer = useRef<number | null>(null);
  const codeField = useRef<HTMLInputElement | null>(null);
  const vendor = kind === 'chatgpt' ? 'ChatGPT' : 'SuperGrok';

  const refresh = () => rpc({ type: 'oauth.status', kind }).then(setStatus).catch(() => setStatus({ signedIn: false }));

  /**
   * On mount, ask what is already in flight.
   *
   * This is the fix for the iOS case that made the whole flow unusable: opening the verification
   * tab dismisses the popup, so this component unmounts the moment the user needs the code, and
   * the next time they open usermods it mounts fresh. It used to `setLogin({status:'idle'})` and
   * draw "Sign in with ChatGPT" while a live, approvable code was sitting on the vendor's page.
   * `oauth.restore` reads the persisted record instead, so the code comes back.
   */
  useEffect(() => {
    let live = true;
    setCopied(null);
    void refresh();
    void rpc({ type: 'oauth.restore', kind })
      .then((st) => {
        if (!live) return;
        setLogin(st);
        if (st.status === 'pending') startPolling();
      })
      .catch(() => live && setLogin({ status: 'idle' }));
    return () => {
      live = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  function stopPolling() {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
  }
  /**
   * Drive the background's poll while this page is open.
   *
   * The background does not run its own timer: on Safari it is an event page that gets suspended,
   * so a timer there is a promise the system does not keep. Each tick is an `oauth.poll`, which
   * wakes the worker if it is asleep and does at most one vendor request — lib/pendinglogin.ts
   * enforces the vendor's own interval from the stored record, so ticking at 2s here never polls
   * the vendor faster than it asked.
   */
  function startPolling() {
    stopPolling();
    timer.current = window.setInterval(async () => {
      const st = await rpc({ type: 'oauth.poll', kind }).catch((e) => ({ status: 'error', message: String(e) }) as OAuthLoginState);
      setLogin(st);
      if (st.status === 'done' || st.status === 'error' || st.status === 'idle') {
        stopPolling();
        void refresh();
      }
    }, 2000);
  }

  /**
   * Start a sign-in, then send the user to the vendor.
   *
   * The order matters and is the second half of the iOS fix. `oauth.start` does not resolve until
   * the background has WRITTEN the pending record to storage, so by the time `tabs.create` runs —
   * which on iOS closes this popup immediately — the code is recoverable and `oauth.restore` will
   * hand it back. The code is also rendered before the tab opens, so it is on screen for the
   * fraction of a second the user has, and is the first thing they see when they come back.
   */
  async function start() {
    setCopied(null);
    setLogin({ status: 'idle' });
    const st = await rpc({ type: 'oauth.start', kind }).catch((e) => ({ status: 'error', message: String(e) }) as OAuthLoginState);
    setLogin(st);
    if (st.status === 'pending') {
      startPolling();
      // A paint before the popup can be dismissed, so the code is not merely "in state".
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      chrome.tabs.create({ url: st.verificationUri }).catch(() => {});
    }
  }
  async function copy(code: string) {
    setCopied(await copyUserCode(code, codeField.current));
  }
  async function cancel() {
    stopPolling();
    await rpc({ type: 'oauth.cancel', kind });
    setCopied(null);
    setLogin({ status: 'idle' });
  }
  async function signOut() {
    stopPolling();
    await rpc({ type: 'oauth.signout', kind });
    setLogin({ status: 'idle' });
    void refresh();
  }

  return (
    <div className="card subscription-login" data-testid="subscription-login" data-kind={kind} data-login={login.status}>
      {status?.signedIn ? (
        <div className="row">
          <span className="dot" aria-hidden="true" />
          <span className="grow">Signed in to {vendor}{status.label ? ` as ${status.label}` : ''}</span>
          <button className="btn" onClick={() => void signOut()}>Sign out</button>
        </div>
      ) : login.status === 'pending' ? (
        <>
          <div className="label">Enter this code on the {vendor} page</div>
          {/*
            A read-only input rather than a <div>, so "Copy code" has something to fall back to
            when the Clipboard API is unavailable or silently refuses, which in a Safari extension
            popup is a real possibility rather than a theoretical one. It is also why the code can
            be selected by hand on a phone at all: a long-press on a <div> in a popup sheet is not
            a dependable way to get a selection.
          */}
          <input
            ref={codeField}
            className="mono user-code"
            data-testid="user-code"
            readOnly
            value={login.userCode}
            aria-label={`Your ${vendor} sign-in code`}
            onFocus={(e) => e.currentTarget.select()}
          />
          <div className="row subscription-actions">
            <button className="btn primary" data-testid="open-verification" onClick={() => chrome.tabs.create({ url: login.verificationUri })}>
              Open {vendor} page
            </button>
            <button className="btn" data-testid="copy-code" onClick={() => void copy(login.userCode)}>
              {copied === 'copied' ? 'Copied' : copied === 'selected' ? 'Selected — hold to copy' : 'Copy code'}
            </button>
            <button className="btn" data-testid="cancel-signin" onClick={() => void cancel()}>Cancel</button>
          </div>
          <div className="row">
            <span className="dot running" aria-hidden="true" />
            <span className="label" style={{ marginBottom: 0 }}>waiting for approval</span>
          </div>
          {/*
            Said explicitly because on iPhone the popup is a sheet and opening the page dismisses
            it, which looks exactly like the sign-in being cancelled. It is not: the flow is in
            storage and this card comes back to this state.
          */}
          <div className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
            Opening the page closes this panel. The code stays valid — reopen usermods and this card
            comes back with it, and finishes as soon as you approve.
          </div>
        </>
      ) : (
        <>
          <div className="row">
            <span className="dot off" aria-hidden="true" />
            <span className="grow">Not signed in to {vendor}</span>
            <button className="btn primary" data-testid="start-signin" onClick={() => void start()}>Sign in with {vendor}</button>
          </div>
          {login.status === 'error' && <div className="error" data-testid="signin-error">▲ {login.message}</div>}
          {login.status === 'done' && <div className="ok">● Signed in</div>}
          <div className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
            {kind === 'chatgpt'
              ? 'Works with ChatGPT Plus, Pro and Team plans.'
              : 'Requires SuperGrok, or X Premium+ on the X account you sign in with. Some standard-tier accounts are rejected by xAI with a 403.'}
          </div>
        </>
      )}
    </div>
  );
}
