/**
 * The two execution engines, behind one interface the background talks to.
 *
 * `createExecAdapter()` picks by what the runtime exposes (lib/exec/engine.ts). Everything the
 * background used to do inline against `chrome.userScripts` now goes through here, so the Chrome
 * path is the same calls in the same order and the Safari path is a genuinely different
 * implementation rather than a shim pretending to be one.
 *
 *   register a saved mod    userScripts.register()        ·  served per document, on demand
 *   run a draft once        userScripts.execute()         ·  a message to the document's runner
 *   GM messages in          runtime.onUserScriptMessage   ·  runtime.onMessage + a capability token
 *   GM value changes out    a port per mod                ·  one port per document, fanned out
 *   report a run's result   the USER_SCRIPT world's chrome·  a closure the runner passes in
 *
 * The asymmetry worth knowing: Chrome registers ahead of time and the browser does the matching;
 * Safari matches at claim time, because there is no API that takes a code string and a match pattern.
 * A mod is therefore built (and its GM values snapshotted) at the moment a page asks for it, which is
 * strictly fresher than Chrome's snapshot-at-registration, and is why `refresh()` has nothing to do
 * there.
 */

import { buildRegisteredCode, type GmMessage } from '../gm.ts';
import { execStatus, pickEngine, type ExecEngine, type ExecStatus, type RuntimeProbe } from './engine.ts';
import { GrantTable } from './grants.ts';
import { modsToRun, RunLedger } from './plan.ts';
import {
  EXEC_PORT,
  execKind,
  gmMessageFor,
  parseBlocked,
  parseClaim,
  parseGm,
  type ClaimResponse,
  type ScriptToRun,
} from './protocol.ts';
import type { ReportTransport } from './wrap.ts';
import type { Mod } from '../types';

/** Where a mod's code is going, so the adapter can bind a capability to that exact frame. */
export interface RunContext {
  tabId?: number;
  frameId?: number;
}

export interface RunResultMessage {
  type: 'usermods:run-result';
  runId: string;
  [key: string]: unknown;
}

export interface ExecAdapter {
  readonly engine: ExecEngine;
  /** What wrapForExecution should emit for reporting a one-off run's result. */
  readonly reportTransport: ReportTransport;
  status(): ExecStatus;
  /**
   * Register every listener the engine needs, synchronously.
   *
   * Called at the top of the background's own body rather than from an async startup path, because
   * MV3 only wakes a sleeping worker for listeners that were registered before the first await.
   * Registering after one means a mod's GM call, or a document's claim, arrives at a worker that
   * was never woken for it.
   */
  install(): void;
  /** Async startup that can wait: configuring the userScripts world. */
  configure(): Promise<void>;
  /** Every enabled mod, re-registered. Called after any change to the mod list. */
  sync(mods: Mod[], values: (modId: string) => Promise<Record<string, unknown>>): Promise<void>;
  /** One mod's GM value snapshot moved. */
  refresh(mod: Mod, values: Record<string, unknown>): Promise<void>;
  /** The code to inject for a mod: the GM shim plus the mod, bound to where it is going. */
  buildModCode(mod: Mod, values: Record<string, unknown>, ctx: RunContext): Promise<string>;
  /** Inject one wrapped code string. Rejects when the injection itself never started. */
  injectOnce(tabId: number, wrapped: string, world: Mod['world']): Promise<void>;
  addResultListener(fn: (msg: RunResultMessage) => void): void;
  removeResultListener(fn: (msg: RunResultMessage) => void): void;
  /** Tell a mod's other live frames that one of its stored values changed. */
  broadcast(modId: string, key: string, oldValue: unknown, newValue: unknown, from: chrome.runtime.MessageSender): void;
  /** A mod was disabled, deleted or rewritten: drop any capability its running copies still hold. */
  revokeMod(modId: string): void;
}

/** Everything the adapters need from the background, injected so neither imports it. */
export interface AdapterEnv {
  handleGm(msg: GmMessage, sender: chrome.runtime.MessageSender): Promise<unknown>;
  loadMods(): Promise<Mod[]>;
  loadGmValues(modId: string): Promise<Record<string, unknown>>;
  /** Reported when a page refuses to evaluate a mod, so it is logged rather than lost. */
  onBlocked?(report: { modId: string; world: Mod['world']; reason: string; url: string }): void;
}

function probeRuntime(): RuntimeProbe {
  const api = typeof chrome !== 'undefined' && typeof (chrome as { userScripts?: unknown }).userScripts !== 'undefined';
  let permitted = false;
  if (api) {
    try {
      // Throws when Chrome's per-extension permission toggle is off.
      chrome.userScripts.getScripts();
      permitted = true;
    } catch {
      permitted = false;
    }
  }
  return {
    api,
    permitted,
    sidePanel: typeof chrome !== 'undefined' && typeof (chrome as { sidePanel?: unknown }).sidePanel !== 'undefined',
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  };
}

export function createExecAdapter(env: AdapterEnv): ExecAdapter {
  return pickEngine(probeRuntime()) === 'user-scripts' ? new UserScriptsAdapter(env) : new ContentScriptAdapter(env);
}

// ---------- Chrome / Firefox: chrome.userScripts ----------

/**
 * What shipped, moved behind the interface. Every call and its ordering is unchanged; the only new
 * thing is that `status()` reads its probe through lib/exec/engine.ts instead of inlining the
 * version check.
 */
class UserScriptsAdapter implements ExecAdapter {
  readonly engine = 'user-scripts' as const;
  readonly reportTransport = 'chrome' as const;

  /** A registered mod's GM shim connects as "gm:<modId>" to hear about writes in other frames. */
  private readonly gmPorts = new Map<string, Set<chrome.runtime.Port>>();
  private installed = false;

  constructor(private readonly env: AdapterEnv) {}

  status(): ExecStatus {
    return execStatus(probeRuntime());
  }

  private available(): boolean {
    return probeRuntime().permitted;
  }

  install(): void {
    if (this.installed) return;
    this.installed = true;
    // Registered mods call back here for GM_setValue, GM_xmlhttpRequest and friends. The USER_SCRIPT
    // world has a channel of its own, so a message arriving on it can only have come from mod code
    // and the modId it carries is as trustworthy as the world it came from.
    chrome.runtime.onUserScriptMessage.addListener(
      (msg: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r?: unknown) => void) => {
        const m = msg as Partial<GmMessage> | null;
        if (!m || m.__usermods !== true || typeof m.modId !== 'string' || typeof m.type !== 'string') return false;
        this.env
          .handleGm(m as GmMessage, sender)
          .then((result) => sendResponse({ result }))
          .catch((e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
        return true;
      },
    );
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name.startsWith('gm:')) this.registerGmPort(port);
    });
  }

  async configure(): Promise<void> {
    if (!this.available()) return;
    await chrome.userScripts.configureWorld({ messaging: true });
  }

  async sync(mods: Mod[], values: (modId: string) => Promise<Record<string, unknown>>): Promise<void> {
    if (!this.available()) return;
    const existing = await chrome.userScripts.getScripts();
    if (existing.length) await chrome.userScripts.unregister({ ids: existing.map((s) => s.id) });
    // register() rejects a script with neither matches nor includeGlobs, which would take the whole
    // batch down with it, so those are dropped here.
    const enabled = mods.filter((m) => m.enabled && (m.matches.length || m.includeGlobs.length));
    if (!enabled.length) return;
    const scripts = await Promise.all(
      enabled.map(async (m) => ({
        id: m.id,
        js: [{ code: buildRegisteredCode(m, await values(m.id)) }],
        ...(m.matches.length ? { matches: m.matches } : {}),
        ...(m.excludeMatches.length ? { excludeMatches: m.excludeMatches } : {}),
        ...(m.includeGlobs.length ? { includeGlobs: m.includeGlobs } : {}),
        ...(m.excludeGlobs.length ? { excludeGlobs: m.excludeGlobs } : {}),
        runAt: m.runAt,
        world: m.world,
        allFrames: m.allFrames,
      })),
    );
    await chrome.userScripts.register(scripts);
  }

  async refresh(mod: Mod, values: Record<string, unknown>): Promise<void> {
    if (!this.available()) return;
    const registered = (await chrome.userScripts.getScripts({ ids: [mod.id] })).length > 0;
    if (!registered) return;
    await chrome.userScripts.update([{ id: mod.id, js: [{ code: buildRegisteredCode(mod, values) }] }]);
  }

  async buildModCode(mod: Mod, values: Record<string, unknown>): Promise<string> {
    return buildRegisteredCode(mod, values);
  }

  async injectOnce(tabId: number, wrapped: string, world: Mod['world']): Promise<void> {
    await chrome.userScripts.execute({ target: { tabId }, js: [{ code: wrapped }], world });
  }

  addResultListener(fn: (msg: RunResultMessage) => void): void {
    chrome.runtime.onUserScriptMessage.addListener(fn as (m: unknown) => void);
  }

  removeResultListener(fn: (msg: RunResultMessage) => void): void {
    chrome.runtime.onUserScriptMessage.removeListener(fn as (m: unknown) => void);
  }

  broadcast(modId: string, key: string, oldValue: unknown, newValue: unknown, from: chrome.runtime.MessageSender): void {
    const own = this.portForSender(modId, from);
    for (const port of this.gmPorts.get(modId) ?? []) {
      if (port === own) continue;
      try {
        port.postMessage({ type: 'gm.valueChanged', key, oldValue, newValue, remote: true });
      } catch {
        /* the frame went away; onDisconnect will clean it up */
      }
    }
  }

  revokeMod(): void {
    // Nothing to revoke: a registered mod's authority is the USER_SCRIPT world itself, which the
    // browser tears down with the document. Unregistering (done by sync) is the whole story.
  }

  private registerGmPort(port: chrome.runtime.Port): void {
    const modId = port.name.slice('gm:'.length);
    if (!modId) return;
    let set = this.gmPorts.get(modId);
    if (!set) this.gmPorts.set(modId, (set = new Set()));
    set.add(port);
    port.onDisconnect.addListener(() => {
      const current = this.gmPorts.get(modId);
      if (!current) return;
      current.delete(port);
      if (!current.size) this.gmPorts.delete(modId);
    });
  }

  /** The port belonging to the frame this message came from, so it is not told about its own write. */
  private portForSender(modId: string, sender: chrome.runtime.MessageSender): chrome.runtime.Port | null {
    for (const port of this.gmPorts.get(modId) ?? []) {
      if (port.sender?.tab?.id === sender.tab?.id && port.sender?.frameId === sender.frameId) return port;
    }
    return null;
  }
}

// ---------- Safari: a declared content script ----------

/** 32 bytes of CSPRNG as hex. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SAFARI_MOD_RUNNER = 'content-scripts/modrunner.js';

class ContentScriptAdapter implements ExecAdapter {
  readonly engine = 'content-script' as const;
  readonly reportTransport = 'bridge' as const;

  private readonly grants = new GrantTable(randomToken);
  private readonly ledger = new RunLedger<ClaimResponse>();
  /** One port per live document, so a value change can be pushed into the frames that hold a grant. */
  private readonly ports = new Set<chrome.runtime.Port>();
  private readonly resultListeners = new Set<(msg: RunResultMessage) => void>();
  /** Mods a grant has ever been minted for, so sync() knows whose capability to take back. */
  private readonly issuedModIds = new Set<string>();
  private wired = false;

  constructor(private readonly env: AdapterEnv) {}

  status(): ExecStatus {
    return execStatus(probeRuntime());
  }

  install(): void {
    if (this.wired) return;
    this.wired = true;

    chrome.runtime.onMessage.addListener((msg: unknown, sender, sendResponse) => {
      // A run result is not privileged. It only resolves a Try the background itself started, and
      // it is addressed by a runId the background generated, so it is handled before the token
      // checks rather than through them.
      if (isRunResult(msg)) {
        for (const fn of this.resultListeners) fn(msg);
        return false;
      }
      const kind = execKind(msg);
      if (!kind) return false;
      if (kind === 'claim') {
        void this.claim(msg, sender).then(sendResponse, (e: unknown) =>
          sendResponse({ scripts: [], replayed: false, error: e instanceof Error ? e.message : String(e) }),
        );
        return true;
      }
      if (kind === 'blocked') {
        const report = parseBlocked(msg);
        if (report) this.env.onBlocked?.({ ...report, url: sender.url ?? '' });
        sendResponse({ ok: true });
        return false;
      }
      // kind === 'gm'
      const req = parseGm(msg);
      const grant = req ? this.grants.resolve(req.token, senderFrame(sender), Date.now()) : null;
      if (!req || !grant) {
        // Deliberately the same answer for a malformed call, an unknown token and a token presented
        // from the wrong frame: none of them should tell the sender which one it was.
        sendResponse({ error: 'usermods: this script is not allowed to make that call.' });
        return false;
      }
      this.env
        .handleGm(gmMessageFor(req, grant), sender)
        .then((result) => sendResponse({ result }))
        .catch((e: unknown) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
      return true;
    });

    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== EXEC_PORT) return;
      this.ports.add(port);
      port.onDisconnect.addListener(() => this.ports.delete(port));
    });

    // A document being replaced takes its capabilities with it. Without this a grant would outlive
    // the page it was minted for, which is the one thing a per-document capability must not do.
    chrome.tabs.onUpdated.addListener((tabId, change) => {
      if (change.status === 'loading') {
        this.grants.revokeTab(tabId);
        this.ledger.forgetTab(tabId);
      }
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      this.grants.revokeTab(tabId);
      this.ledger.forgetTab(tabId);
    });
  }

  async configure(): Promise<void> {
    // There is no world to configure: the runner is a declared content script the manifest already
    // carries, and everything it needs was registered by install().
  }

  async sync(mods: Mod[]): Promise<void> {
    // Nothing is registered ahead of time: a document asks, and claim() answers from storage. What
    // sync still owes is revocation. A mod that has just been disabled, deleted or rewritten must
    // not keep the capability its already-running copies hold, even though that code cannot be
    // unrun. Without this, disabling a mod would stop it starting on the next page while leaving it
    // able to call gm.xhr from every page it is already on.
    const live = new Set(mods.filter((m) => m.enabled).map((m) => m.id));
    for (const modId of [...this.issuedModIds]) {
      if (!live.has(modId)) {
        this.grants.revokeMod(modId);
        this.issuedModIds.delete(modId);
      }
    }
    const now = Date.now();
    this.grants.prune(now);
    this.ledger.prune(now);
  }

  async refresh(): Promise<void> {
    // A mod's code and its GM value snapshot are built at claim time, so there is no registered copy
    // to update. The next document to ask gets the current values by construction.
  }

  async buildModCode(mod: Mod, values: Record<string, unknown>, ctx: RunContext): Promise<string> {
    const grant =
      ctx.tabId == null
        ? null
        : this.grants.issue(
            { modId: mod.id, world: mod.world, tabId: ctx.tabId, frameId: ctx.frameId ?? 0 },
            Date.now(),
          );
    if (grant) this.issuedModIds.add(mod.id);
    return buildRegisteredCode(mod, values, { transport: 'bridge', token: grant?.token });
  }

  async injectOnce(tabId: number, wrapped: string, world: Mod['world']): Promise<void> {
    const message = { __usermodsExec: 'run-once' as const, code: wrapped, world };
    try {
      await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch {
      // The runner is not in this document yet: the tab predates the extension being enabled, or
      // Safari dropped it. Inject the runner by file path (the one thing scripting.executeScript is
      // good for) and try once more, so a Try never fails just because of when the tab was opened.
      await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [SAFARI_MOD_RUNNER] });
      await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    }
  }

  addResultListener(fn: (msg: RunResultMessage) => void): void {
    this.resultListeners.add(fn);
  }

  removeResultListener(fn: (msg: RunResultMessage) => void): void {
    this.resultListeners.delete(fn);
  }

  broadcast(modId: string, key: string, oldValue: unknown, newValue: unknown, from: chrome.runtime.MessageSender): void {
    const frames = this.grants.forMod(modId);
    if (!frames.length) return;
    const payload = { type: 'gm.valueChanged' as const, modId, key, oldValue, newValue, remote: true as const };
    for (const port of this.ports) {
      const frame = senderFrame(port.sender);
      // Only a frame that actually holds a grant for this mod hears about it: one port carries every
      // mod in its document, so without this check a document would learn about writes by mods that
      // are not running in it.
      if (!frames.some((g) => g.tabId === frame.tabId && g.frameId === frame.frameId)) continue;
      // The frame that made the write already fired its own listeners locally.
      if (frame.tabId === from.tab?.id && frame.frameId === from.frameId) continue;
      try {
        port.postMessage(payload);
      } catch {
        /* the frame went away; onDisconnect will clean it up */
      }
    }
  }

  revokeMod(modId: string): void {
    this.grants.revokeMod(modId);
  }

  /**
   * Answer a document's claim: which mods run here, built and bound to this frame.
   *
   * Idempotent by document key, so a claim the background was suspended before answering can be
   * retried without the mods running twice (lib/exec/plan.ts explains why that is the failure this
   * has to prevent).
   */
  private async claim(msg: unknown, sender: chrome.runtime.MessageSender): Promise<ClaimResponse> {
    const req = parseClaim(msg);
    const frame = senderFrame(sender);
    if (!req || frame.tabId < 0) return { scripts: [], replayed: false };
    const now = Date.now();
    this.grants.prune(now);
    this.ledger.prune(now);

    const previous = this.ledger.replay(req.docKey, frame, now);
    if (previous) return { ...previous, replayed: true };

    // The sender's own URL, not the one the message claimed: a content script can be told to lie
    // about its URL, and which mods run somewhere is exactly the decision not to take on trust.
    const url = sender.url || req.url;
    const mods = modsToRun(await this.env.loadMods(), { url, topFrame: frame.frameId === 0 });
    const scripts: ScriptToRun[] = [];
    for (const mod of mods) {
      const values = await this.env.loadGmValues(mod.id);
      const grant = this.grants.issue(
        { modId: mod.id, world: mod.world, documentId: req.docKey, tabId: frame.tabId, frameId: frame.frameId },
        now,
      );
      this.issuedModIds.add(mod.id);
      scripts.push({
        modId: mod.id,
        name: mod.name,
        code: buildRegisteredCode(mod, values, { transport: 'bridge', token: grant?.token }),
        runAt: mod.runAt,
        world: mod.world,
        token: grant?.token,
      });
    }
    const response: ClaimResponse = { scripts, replayed: false };
    this.ledger.record(req.docKey, frame, response, now);
    return response;
  }
}

function senderFrame(sender: chrome.runtime.MessageSender | undefined): { tabId: number; frameId: number } {
  return { tabId: sender?.tab?.id ?? -1, frameId: sender?.frameId ?? -1 };
}

function isRunResult(msg: unknown): msg is RunResultMessage {
  return typeof msg === 'object' && msg !== null && (msg as { type?: unknown }).type === 'usermods:run-result';
}
