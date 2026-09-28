// The background's half of sharing: open the site's editor in a tab, fill it when it is ready,
// point at the save button, and remember what the site saved.
//
// Stateless across worker restarts by design. The in-flight share lives in chrome.storage.session
// keyed by tab, and every step is a reaction to the tab finishing a load (lib/share.ts shareStep
// decides which), so a service worker that slept while the user was signing in picks up exactly
// where it was: the next page load wakes it, it reads the record, and it carries on.
//
// Nothing here makes a network request. Every byte that leaves goes out when the user presses the
// site's own button, from the site's own page.
import { SAFARI_BUILD } from './buildflags';
import { reheaderFields } from './artifact';
import { reparseEditedSource } from './install';
import { HINTS, SHARE_SESSION_TTL_MS, gistRawUrl, pickGistFile, recordGist, recordGreasyFork, shareStep, type ShareSession, type ShareTarget } from './share';
import { setEditorInPage, type FillRequest, type FillResult } from './sharefill';
import type { ContentRequest, Mod, ShareHintSpec } from './types';

const SESSIONS_KEY = 'share:sessions';

/** What the panel hears about, over runtime messaging. */
export type ShareEvent =
  | { type: 'usermods:share-event'; kind: 'filled' | 'fallback' | 'signin'; modId: string; target: ShareTarget }
  | { type: 'usermods:share-event'; kind: 'recorded'; modId: string; target: ShareTarget; url: string; rawUrl?: string }
  | { type: 'usermods:share-event'; kind: 'gist-missing'; modId: string; target: 'gist' };

export interface ShareDeps {
  loadMods(): Promise<Mod[]>;
  /** Persist a changed mod (upsert + re-register). */
  saveMod(mod: Mod): Promise<void>;
  sendToContent<T>(tabId: number, req: ContentRequest): Promise<T>;
}

export interface StartShare {
  modId: string;
  target: ShareTarget;
  mode: 'new' | 'update';
  source: string;
  fileName: string;
  description: string;
  version: string;
  previousVersion: string;
  openUrl: string;
  /** Reuse this tab instead of opening a new one ("Share as a new gist" from a dead gist's page). */
  tabId?: number;
}

type SessionMap = Record<string, ShareSession>;

/** chrome.storage.session where it exists, a plain object where it does not. */
const memory: SessionMap = {};
async function readSessions(): Promise<SessionMap> {
  try {
    const r = await chrome.storage.session.get(SESSIONS_KEY);
    return (r[SESSIONS_KEY] as SessionMap | undefined) ?? {};
  } catch {
    return memory;
  }
}
async function writeSessions(map: SessionMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [SESSIONS_KEY]: map });
  } catch {
    Object.keys(memory).forEach((k) => delete memory[k]);
    Object.assign(memory, map);
  }
}

export function createShareController(deps: ShareDeps) {
  /** Loads in flight per tab, so two 'complete' events for one load do not fill twice. */
  const busy = new Set<number>();

  function notify(e: ShareEvent): void {
    void Promise.resolve(chrome.runtime.sendMessage(e)).catch(() => {
      /* no panel open: the mod's own record is what the panel reads next time */
    });
  }

  async function update(tabId: number, fn: (s: ShareSession | undefined) => ShareSession | undefined): Promise<ShareSession | undefined> {
    const map = await readSessions();
    const now = Date.now();
    for (const [k, s] of Object.entries(map)) if (now - s.startedAt > SHARE_SESSION_TTL_MS) delete map[k];
    const next = fn(map[String(tabId)]);
    if (next) map[String(tabId)] = next;
    else delete map[String(tabId)];
    await writeSessions(map);
    return next;
  }

  async function get(tabId: number): Promise<ShareSession | undefined> {
    const s = (await readSessions())[String(tabId)];
    if (s && Date.now() - s.startedAt > SHARE_SESSION_TTL_MS) {
      await update(tabId, () => undefined);
      return undefined;
    }
    return s;
  }

  async function start(req: StartShare): Promise<{ tabId: number }> {
    const mods = await deps.loadMods();
    const mod = mods.find((m) => m.id === req.modId);
    if (!mod) throw new Error('That mod no longer exists.');
    // What goes on the site is what the mod now is: the bumped version, the header lines the user
    // agreed to add. Saved first, so the gist and the installed mod never disagree.
    if (req.source !== mod.source) {
      await deps.saveMod(reparseEditedSource(mod, req.source));
    }
    let tabId = req.tabId;
    if (tabId == null) {
      const tab = await chrome.tabs.create({ url: req.openUrl, active: true });
      if (tab.id == null) throw new Error('Could not open a tab.');
      tabId = tab.id;
    } else {
      await chrome.tabs.update(tabId, { url: req.openUrl, active: true });
    }
    const gist = req.target === 'gist' && req.mode === 'update' && mod.share?.gist ? { user: mod.share.gist.user, id: mod.share.gist.id } : undefined;
    const session: ShareSession = {
      tabId,
      modId: req.modId,
      target: req.target,
      mode: req.mode,
      source: req.source,
      fileName: req.fileName,
      description: req.description,
      version: req.version,
      previousVersion: req.previousVersion,
      ...(gist ? { gist } : {}),
      phase: 'opening',
      startedAt: Date.now(),
    };
    await update(tabId, () => session);
    // A fast page can finish loading before the record above landed; catch it up.
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.status === 'complete' && tab.url && tab.url !== 'about:blank') void onLoaded(tabId, tab.url);
    return { tabId };
  }

  /**
   * Hints that could not be shown yet, by tab. A 'complete' can arrive for a document that cannot
   * take a message (an interstitial or error page between a form post and its redirect); the hint
   * is shown on the next load of that tab instead of being lost.
   */
  const pendingHints = new Map<number, ShareHintSpec>();

  function hint(tabId: number, spec: ShareHintSpec): Promise<unknown> {
    return deps.sendToContent(tabId, { type: 'share-hint', hint: spec }).catch(() => {
      pendingHints.set(tabId, spec);
      return undefined;
    });
  }

  function filledHint(s: ShareSession, mod: Mod | undefined): ShareHintSpec {
    if (s.target === 'gist') {
      return { text: s.mode === 'update' ? HINTS.gistUpdate(s.version) : HINTS.gistNew, anchor: 'gist-submit', testId: 'usermods-hint-filled' };
    }
    const raw = mod?.share?.gist?.rawUrl;
    return {
      text: s.mode === 'update' ? HINTS.greasyForkUpdate(s.version) : HINTS.greasyForkNew,
      ...(raw ? { extra: HINTS.greasyForkSync(raw) } : {}),
      anchor: 'greasyfork-submit',
      testId: 'usermods-hint-filled',
    };
  }

  function fallbackHint(s: ShareSession): ShareHintSpec {
    return s.target === 'gist'
      ? { text: HINTS.fallback(s.fileName, true), textNotCopied: HINTS.fallback(s.fileName, false), copy: s.source, anchor: 'none', testId: 'usermods-hint-fallback' }
      : { text: HINTS.fallbackGreasyFork(true), textNotCopied: HINTS.fallbackGreasyFork(false), copy: s.source, anchor: 'none', testId: 'usermods-hint-fallback' };
  }

  /** Put the script in the editor. Chrome first tries the editor's own API from the page world. */
  async function fill(tabId: number, s: ShareSession): Promise<FillResult> {
    const req: FillRequest = { target: s.target, mode: s.mode, fileName: s.fileName, description: s.description, source: s.source, version: s.version, previousVersion: s.previousVersion };
    if (s.target === 'greasyfork' || SAFARI_BUILD) {
      // Safari: scripting.executeScript is for the bundled content script only (docs/safari.md), so
      // the whole fill happens in the isolated world.
      return deps.sendToContent<FillResult>(tabId, { type: 'share-fill', req });
    }
    const fields = await deps.sendToContent<FillResult>(tabId, { type: 'share-fill', req: { ...req, fieldsOnly: true } });
    if (fields.state !== 'fields') return fields;
    const viaApi = await inPage(tabId, s.fileName, s.source, true);
    if (viaApi === 'set' || viaApi === 'same') return { state: 'filled', method: 'editor-api' };
    const iso = await deps.sendToContent<FillResult>(tabId, { type: 'share-fill', req });
    if (iso.state !== 'filled') return iso;
    // The isolated methods can only check what is rendered; the page world can check it exactly.
    const check = await inPage(tabId, s.fileName, s.source, false);
    if (check === 'mismatch') return { state: 'missing', reason: 'the editor did not take the text' };
    return iso;
  }

  async function inPage(tabId: number, fileName: string, text: string, write: boolean): Promise<string> {
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: setEditorInPage, args: [fileName, text, write] });
      return String(r?.result ?? 'no-editor');
    } catch {
      return 'no-editor';
    }
  }

  async function onLoaded(tabId: number, url: string): Promise<void> {
    if (busy.has(tabId)) return;
    const owed = pendingHints.get(tabId);
    if (owed) {
      pendingHints.delete(tabId);
      await hint(tabId, owed);
    }
    const s = await get(tabId);
    if (!s) return;
    busy.add(tabId);
    try {
      const step = shareStep(s, url);
      const mods = await deps.loadMods();
      const mod = mods.find((m) => m.id === s.modId);
      if (!mod) {
        await update(tabId, () => undefined);
        return;
      }
      switch (step.kind) {
        case 'abandon':
          await update(tabId, () => undefined);
          return;
        case 'wait':
          return;
        case 'signin':
          await update(tabId, (x) => (x ? { ...x, phase: 'signin' } : x));
          await hint(tabId, { text: s.target === 'gist' ? HINTS.signInGitHub : HINTS.signInGreasyFork, anchor: 'none', testId: 'usermods-hint-signin' });
          notify({ type: 'usermods:share-event', kind: 'signin', modId: s.modId, target: s.target });
          return;
        case 'fill': {
          const r = await fill(tabId, s).catch((e: unknown): FillResult => ({ state: 'missing', reason: e instanceof Error ? e.message : String(e) }));
          if (r.state === 'signin') {
            await update(tabId, (x) => (x ? { ...x, phase: 'signin' } : x));
            await hint(tabId, { text: s.target === 'gist' ? HINTS.signInGitHub : HINTS.signInGreasyFork, anchor: 'none', testId: 'usermods-hint-signin' });
            notify({ type: 'usermods:share-event', kind: 'signin', modId: s.modId, target: s.target });
            return;
          }
          if (r.state === 'notfound' && s.target === 'gist' && s.mode === 'update') {
            await update(tabId, (x) => (x ? { ...x, phase: 'notfound' } : x));
            await hint(tabId, { text: HINTS.gistMissing, anchor: 'none', offerNewGist: true, testId: 'usermods-hint-missing' });
            notify({ type: 'usermods:share-event', kind: 'gist-missing', modId: s.modId, target: 'gist' });
            return;
          }
          if (r.state === 'filled') {
            await update(tabId, (x) => (x ? { ...x, phase: 'filled' } : x));
            await hint(tabId, filledHint(s, mod));
            notify({ type: 'usermods:share-event', kind: 'filled', modId: s.modId, target: s.target });
            return;
          }
          await update(tabId, (x) => (x ? { ...x, phase: 'fallback' } : x));
          await hint(tabId, fallbackHint(s));
          notify({ type: 'usermods:share-event', kind: 'fallback', modId: s.modId, target: s.target });
          return;
        }
        case 'record-gist': {
          const listed = await deps.sendToContent<{ files: string[] }>(tabId, { type: 'share-files' }).catch(() => ({ files: [] as string[] }));
          const fileName = pickGistFile(listed.files, s.fileName) ?? s.fileName;
          const next = recordGist(mod, { user: step.user, id: step.id, fileName });
          await deps.saveMod(next);
          await update(tabId, () => undefined);
          await hint(tabId, { text: HINTS.savedGist, anchor: 'none', testId: 'usermods-hint-saved' });
          notify({ type: 'usermods:share-event', kind: 'recorded', modId: s.modId, target: 'gist', url: next.share!.gist!.url, rawUrl: gistRawUrl(step.user, step.id, fileName) });
          return;
        }
        case 'record-greasyfork': {
          const next = recordGreasyFork(mod, step.url);
          await deps.saveMod(next);
          await update(tabId, () => undefined);
          await hint(tabId, { text: HINTS.savedGreasyFork, anchor: 'none', testId: 'usermods-hint-saved' });
          notify({ type: 'usermods:share-event', kind: 'recorded', modId: s.modId, target: 'greasyfork', url: next.share?.greasyFork?.url ?? step.url });
          return;
        }
      }
    } finally {
      busy.delete(tabId);
    }
  }

  /** "Share as a new gist", from the hint on a deleted gist's edit page: same tab, fresh share. */
  async function restartAsNewGist(tabId: number): Promise<void> {
    const s = await get(tabId);
    if (!s || s.target !== 'gist') return;
    const mods = await deps.loadMods();
    const mod = mods.find((m) => m.id === s.modId);
    if (!mod) return;
    // Forget the dead gist, and its URLs in the header: they point at nothing now.
    const { gist: _dead, ...rest } = mod.share ?? {};
    const source = reheaderFields(mod.source, { updateURL: null, downloadURL: null });
    const cleared: Mod = { ...mod, source, downloadUrl: undefined, share: Object.keys(rest).length ? rest : undefined, updatedAt: Date.now() };
    await deps.saveMod(cleared);
    await update(tabId, () => undefined);
    await start({
      modId: s.modId,
      target: 'gist',
      mode: 'new',
      source: cleared.source,
      fileName: s.fileName,
      description: s.description,
      version: s.version,
      previousVersion: s.previousVersion,
      openUrl: 'https://gist.github.com/',
      tabId,
    });
  }

  return {
    start,
    restartAsNewGist,
    /** Is a share driving this tab? The banner stays quiet there. */
    async active(tabId: number): Promise<boolean> {
      return !!(await get(tabId));
    },
    listen(): void {
      chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
        if (change.status !== 'complete') return;
        void onLoaded(tabId, tab?.url ?? change.url ?? '').catch((e: unknown) => console.warn('[usermods] share', e));
      });
      chrome.tabs.onRemoved.addListener((tabId) => {
        pendingHints.delete(tabId);
        void update(tabId, () => undefined).catch(() => {});
      });
    },
  };
}
