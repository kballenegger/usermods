import { useEffect, useState } from 'react';
import { describeLeak, scanForLeaks, type Leak } from '@/lib/leakscan';
import { rpc } from '@/lib/rpc';
import { SUGGESTED_LICENSE, SUGGESTED_NAMESPACE, prepareShare, shareFileName, shareMenuLabels, type GreasyForkKey, type ShareOptions, type ShareTarget } from '@/lib/share';
import type { ShareEvent } from '@/lib/sharecontroller';
import type { Mod } from '@/lib/types';
import type { MenuItem } from './Menu';

/**
 * Export, as one control: Download .user.js (what Export always did), Copy to clipboard, and the
 * two ways to share — a GitHub gist, and Greasy Fork. Used by the side panel's Mods tab (a menu, or
 * rows in the "more" sheet on a phone) and by the dashboard's mod rows.
 *
 * Sharing never sends anything from usermods. It opens the site's own editor in a new tab of the
 * user's own browser, fills the form there, and points at the site's save button
 * (lib/sharecontroller.ts). Before it does, the script is checked for things that should not be
 * published (lib/leakscan.ts), and for Greasy Fork, for the header lines that site expects.
 */

/** What the share prompt is asking about. */
export interface PendingShare {
  mod: Mod;
  target: ShareTarget;
  leaks: Leak[];
  missing: GreasyForkKey[];
  forceNew?: boolean;
}

export function downloadMod(m: Mod): void {
  const blob = new Blob([m.source], { type: 'text/javascript' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = shareFileName(m.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function copyText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/**
 * The share flow's state and verbs, for whichever surface hosts the menu. `onStatus`/`onError` are
 * the host's own message line; `onChanged` refreshes its mod list.
 */
export function useModShare({ onStatus, onError, onChanged }: { onStatus: (s: string) => void; onError: (e: unknown) => void; onChanged?: () => void }) {
  const [pending, setPending] = useState<PendingShare | null>(null);
  /** The last install link a share produced, offered with Copy until dismissed. */
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  /** A gist that turned out to be deleted: offer to share as a new one. */
  const [missingGist, setMissingGist] = useState<Mod | null>(null);

  // What the background says about a share in flight. The panel may be closed by then (Safari's
  // popup always is), which is fine: everything that matters is also recorded on the mod.
  useEffect(() => {
    const onMessage = (msg: ShareEvent) => {
      if (msg?.type !== 'usermods:share-event') return;
      void rpc({ type: 'mods.list' }).then((mods) => {
        const m = mods.find((x) => x.id === msg.modId);
        const name = m?.name ?? 'your mod';
        if (msg.kind === 'recorded') {
          if (msg.target === 'gist' && msg.rawUrl) {
            setLink({ name, url: msg.rawUrl });
            onStatus(`Shared “${name}” as a gist. Its install link is below.`);
          } else onStatus(`Posted “${name}” on Greasy Fork.`);
          onChanged?.();
        } else if (msg.kind === 'gist-missing') {
          if (m) setMissingGist(m);
        } else if (msg.kind === 'signin') {
          onStatus(`Sign in on the ${msg.target === 'gist' ? 'GitHub' : 'Greasy Fork'} tab; usermods fills the form in when it appears.`);
        } else if (msg.kind === 'filled') {
          onStatus(`Filled in. Press the site's own ${msg.target === 'gist' ? 'Create/Update gist' : 'Post'} button to save it.`);
        } else if (msg.kind === 'fallback') {
          onStatus(`usermods could not fill that page in. Paste the script there (the page has a Copy button).`);
        }
      });
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(mod: Mod, target: ShareTarget, opts: ShareOptions = {}) {
    const p = prepareShare(mod, target, opts);
    try {
      await rpc({
        type: 'share.start',
        share: {
          modId: mod.id,
          target,
          mode: p.mode,
          source: p.source,
          fileName: p.fileName,
          description: p.description,
          version: p.version,
          previousVersion: p.previousVersion,
          openUrl: p.openUrl,
        },
      });
      onStatus(
        target === 'gist'
          ? p.mode === 'update'
            ? `Opened the gist's editor with v${p.version}.`
            : 'Opened a new gist. usermods fills it in when it loads.'
          : p.mode === 'update'
            ? `Opened Greasy Fork's new-version form with v${p.version}.`
            : "Opened Greasy Fork's post form. usermods fills it in when it loads.",
      );
      onChanged?.();
    } catch (e) {
      onError(e);
    }
  }

  /** The menu item's click: check first, and only ask when there is something to ask. */
  function begin(mod: Mod, target: ShareTarget, forceNew = false) {
    setMissingGist(null);
    const p = prepareShare(mod, target, { forceNew });
    const leaks = scanForLeaks(p.source);
    const missing = p.missing;
    if (leaks.length || missing.length) {
      setPending({ mod, target, leaks, missing, ...(forceNew ? { forceNew } : {}) });
      return;
    }
    void start(mod, target, { forceNew });
  }

  function items(m: Mod): MenuItem[] {
    const labels = shareMenuLabels(m);
    return [
      { id: 'download', label: 'Download .user.js', testId: 'export-download', onSelect: () => downloadMod(m) },
      {
        id: 'copy',
        label: 'Copy to clipboard',
        testId: 'export-copy',
        onSelect: () => {
          copyText(m.source).then(() => onStatus(`Copied “${m.name}” to the clipboard.`), onError);
        },
      },
      { id: 'gist', label: labels.gist, testId: 'export-gist', onSelect: () => begin(m, 'gist') },
      { id: 'greasyfork', label: labels.greasyFork, testId: 'export-greasyfork', onSelect: () => begin(m, 'greasyfork') },
    ];
  }

  const prompt = pending ? (
    <SharePrompt
      pending={pending}
      onCancel={() => setPending(null)}
      onConfirm={(opts) => {
        const p = pending;
        setPending(null);
        void start(p.mod, p.target, { ...opts, ...(p.forceNew ? { forceNew: true } : {}) });
      }}
    />
  ) : null;

  const notices = (
    <>
      {missingGist && (
        <div className="card" data-testid="share-gist-missing">
          <div className="desc">The gist for “{missingGist.name}” no longer exists: it may have been deleted. Share it as a new gist?</div>
          <div className="row">
            <button className="btn primary" onClick={() => begin(missingGist, 'gist', true)} data-testid="share-new-gist">
              Share as a new gist
            </button>
            <button className="btn" onClick={() => setMissingGist(null)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {link && (
        <div className="card" data-testid="share-install-link">
          <div className="label">Your install link</div>
          <div className="desc">Anyone can install “{link.name}” from this link, and gets each new version you share:</div>
          <div className="mono break">{link.url}</div>
          <div className="row">
            <button className="btn" onClick={() => copyText(link.url).then(() => onStatus('Copied the install link.'), onError)} data-testid="share-install-link-copy">
              Copy
            </button>
            <button className="btn" onClick={() => setLink(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );

  return { items, prompt, notices, begin };
}

const KEY_LABEL: Record<GreasyForkKey, string> = {
  name: '@name',
  namespace: '@namespace',
  version: '@version',
  description: '@description',
  match: '@match or @include',
  license: '@license',
};

/** Leaks found, and (for Greasy Fork) header lines it expects: shown before anything opens. */
export function SharePrompt({ pending, onConfirm, onCancel }: { pending: PendingShare; onConfirm: (opts: ShareOptions) => void; onCancel: () => void }) {
  const { mod, target, leaks, missing } = pending;
  const needsLicense = missing.includes('license');
  const needsNamespace = missing.includes('namespace');
  const [addLicense, setAddLicense] = useState(false);
  const [addNamespace, setAddNamespace] = useState(true);
  const others = missing.filter((k) => k !== 'license' && k !== 'namespace' && k !== 'version');
  const where = target === 'gist' ? 'a gist' : 'Greasy Fork';
  return (
    <div className="card share-prompt" data-testid="share-prompt" role="alertdialog" aria-label={`Before you share “${mod.name}”`}>
      <h4>Before you share “{mod.name}” on {where}</h4>
      {leaks.length > 0 && (
        <>
          <div className="error">▲ This script looks like it contains something private:</div>
          <ul className="share-leaks" data-testid="share-leaks">
            {leaks.slice(0, 8).map((l) => (
              <li key={`${l.kind}:${l.line}`} className="mono">
                {describeLeak(l)}
              </li>
            ))}
            {leaks.length > 8 && <li className="muted">and {leaks.length - 8} more</li>}
          </ul>
          <div className="desc muted">
            {target === 'gist'
              ? 'A secret gist is not listed anywhere, but anyone who has the link can read it.'
              : 'Everything on Greasy Fork is public.'}{' '}
            Remove it from the mod first unless you are sure.
          </div>
        </>
      )}
      {(needsLicense || needsNamespace || others.length > 0) && (
        <>
          <div className="label">Greasy Fork expects these header lines</div>
          {needsLicense && (
            <label className="toggle" data-testid="share-add-license">
              <input type="checkbox" checked={addLicense} onChange={(e) => setAddLicense(e.target.checked)} /> Add <span className="mono">// @license {SUGGESTED_LICENSE}</span>
              <span className="muted"> — lets anyone reuse it. Greasy Fork asks for a licence; pick another in the source if you prefer.</span>
            </label>
          )}
          {needsNamespace && (
            <label className="toggle" data-testid="share-add-namespace">
              <input type="checkbox" checked={addNamespace} onChange={(e) => setAddNamespace(e.target.checked)} /> Add <span className="mono">// @namespace {SUGGESTED_NAMESPACE}</span>
            </label>
          )}
          {others.map((k) => (
            <div key={k} className="muted">
              Missing {KEY_LABEL[k]}: Greasy Fork will ask for it.
            </div>
          ))}
        </>
      )}
      <div className="row">
        <button className={leaks.length ? 'btn danger' : 'btn primary'} onClick={() => onConfirm({ addLicense, addNamespace })} data-testid="share-anyway">
          {leaks.length ? 'Share anyway' : 'Continue'}
        </button>
        <button className="btn" onClick={onCancel} data-testid="share-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}
