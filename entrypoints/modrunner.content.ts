/**
 * The mod runner: Safari's replacement for `chrome.userScripts`.
 *
 * Safari has no API that takes a code string plus a match pattern and runs it on matching pages,
 * so the extension declares ONE content script on every page and that script does the work the
 * browser does on Chrome. At document_start it asks the background which mods belong to this
 * document, and the background answers with code already built and already bound to this frame
 * (lib/exec/adapter.ts). The runner then holds each mod back to its own `@run-at` and evaluates it.
 *
 * `scripting.executeScript` is not the mechanism here, and the distinction matters. It cannot
 * register anything ahead of time, it cannot express a match pattern, and on Safari it cannot put a
 * code string into an isolated world at all. It is used for exactly one thing, from the background:
 * injecting THIS file, by path, into tabs that were already open when the extension was enabled.
 *
 * What this file is careful about:
 *
 *  - **Running once.** A document that gets both the declared script and a manual injection must not
 *    run its mods twice. A flag on the isolated world's own `window` stops the second copy, and the
 *    background's ledger (lib/exec/plan.ts) covers the other direction, where a suspended worker
 *    makes the runner retry a claim it already made.
 *  - **Surviving suspension.** Safari stops the background aggressively. The claim is retried, the
 *    port is reconnected lazily, and a claim answered after the page has finished loading still runs
 *    its mods rather than waiting for events that already fired.
 *  - **Holding no authority.** The runner is an ordinary content script on the same message channel
 *    as everything else, so it is given none. Every privileged call carries the opaque token the
 *    background minted for that one mod in that one frame, and the background derives the mod from
 *    its own table. Nothing here can name a mod it was not handed.
 */

import { evalAllowed, evaluateIsolated, injectIntoPage } from '@/lib/exec/evaluate';
import { phaseFor, phasesElapsed, type RunPhase } from '@/lib/exec/plan';
import { EXEC_PORT, EXEC_TAG, type ClaimResponse, type ScriptToRun } from '@/lib/exec/protocol';

/** How long to keep retrying a claim the background never answered, and how fast to back off. */
const CLAIM_ATTEMPTS = 5;
const CLAIM_BACKOFF_MS = 250;

interface RunOnce {
  [EXEC_TAG]: 'run-once';
  code: string;
  world: 'USER_SCRIPT' | 'MAIN';
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  allFrames: true,
  // Chrome and Firefox have chrome.userScripts, which does all of this properly. Shipping this file
  // to them would mean two engines racing for the same mods.
  include: ['safari'],
  main() {
    const world = globalThis as unknown as { __usermodsRunner?: boolean };
    if (world.__usermodsRunner) return;
    world.__usermodsRunner = true;
    start();
  },
});

function start(): void {
  const docKey = newDocKey();
  /**
   * Value-change subscribers, kept per mod.
   *
   * One document has one port and many mods on it, so a change has to be delivered to the mod it
   * belongs to and to nobody else. Fanning every change to every mod let mod A's write land in mod
   * B's value snapshot and fire mod B's listeners, which is a write into another mod's storage by
   * the back door.
   */
  const subscribers = new Map<string, Set<(msg: unknown) => void>>();
  let port: chrome.runtime.Port | null = null;

  /**
   * The port the background pushes GM value changes down, opened on first use.
   *
   * Lazy and re-openable because Safari suspends the background whenever it feels like it, which
   * disconnects the port. A mod that registers a value-change listener an hour into a page's life
   * still gets one, and a port dropped by a suspension is replaced on the next write rather than
   * leaving the document deaf for as long as it stays open.
   */
  function ensurePort(): void {
    if (port) return;
    try {
      port = chrome.runtime.connect({ name: EXEC_PORT });
      port.onMessage.addListener((m: unknown) => {
        // The mod a change belongs to is named by the background, which derived it from its own
        // grant table rather than from anything a mod said. A message that names no mod is not
        // deliverable to one, so it is dropped: this port carries value changes and nothing else.
        const modId = (m as { modId?: unknown } | null)?.modId;
        if (typeof modId !== 'string') return;
        for (const fn of subscribers.get(modId) ?? []) {
          try {
            fn(m);
          } catch {
            /* one mod's listener throwing must not stop the others hearing about it */
          }
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
      });
    } catch {
      port = null;
    }
  }

  /**
   * The GM transport handed to one mod (lib/gm.ts, transport 'bridge').
   *
   * The translation into the wire shape happens here, not in the mod's code, so the message the
   * background validates has exactly the fields lib/exec/protocol.ts allows. The token comes from
   * the mod's own baked-in copy; the runner neither reads it nor keeps a table of them, so one mod
   * cannot borrow another's by asking the runner nicely.
   *
   * Each mod gets its own transport, bound here to the mod the background said this code is, so
   * which mod a subscription belongs to is not something the subscribing code gets to say.
   * `modId` is null for a one-off Try, which the engine interface injects by code alone: it has no
   * mod to be delivered changes for, so it hears its own writes and no remote ones.
   */
  function bridgeFor(modId: string | null) {
    return {
      send(msg: Record<string, unknown>): Promise<unknown> {
        return new Promise((resolve, reject) => {
          const wire: Record<string, unknown> = {
            [EXEC_TAG]: 'gm',
            call: msg.type,
            token: msg.token,
          };
          for (const field of ['key', 'value', 'url', 'active', 'details', 'args']) {
            if (field in msg) wire[field] = msg[field];
          }
          try {
            chrome.runtime.sendMessage(wire, (r: { result?: unknown; error?: string } | undefined) => {
              const err = chrome.runtime.lastError;
              if (err) reject(new Error(err.message));
              else if (r && r.error) reject(new Error(r.error));
              else resolve(r?.result);
            });
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
      },
      subscribe(fn: (msg: unknown) => void): void {
        if (modId === null) return;
        let forMod = subscribers.get(modId);
        if (!forMod) subscribers.set(modId, (forMod = new Set()));
        forMod.add(fn);
        ensurePort();
      },
    };
  }

  /** Where a one-off run's result goes, standing in for the `chrome` the mod cannot see. */
  const report = (out: unknown): void => {
    try {
      void chrome.runtime.sendMessage(out);
    } catch {
      /* the background is gone; the Try that started this has already timed out */
    }
  };

  // The Try button and the agent's run_script tool. The background wraps the code and sends it here
  // because Safari cannot inject a code string into an isolated world on its own.
  chrome.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
    if (!isRunOnce(msg)) return false;
    try {
      if (msg.world === 'MAIN') {
        const nonce = newNonce();
        const ran = injectIntoPage(msg.code, nonce, document);
        sendResponse(ran ? { ok: true } : { ok: false, error: pageBlockedMessage() });
      } else {
        void evaluateIsolated(msg.code, { bridge: bridgeFor(null), report });
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
    return false;
  });

  void claim(docKey).then((response) => {
    if (!response || response.replayed) return;
    for (const script of response.scripts) schedule(script, bridgeFor(script.modId), report);
  });
}

/** Ask the background which mods run here. Null when it never answered. */
async function claim(docKey: string): Promise<ClaimResponse | null> {
  const request = {
    [EXEC_TAG]: 'claim',
    docKey,
    url: location.href,
    topFrame: isTopFrame(),
    readyState: document.readyState,
  };
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    try {
      const response = (await chrome.runtime.sendMessage(request)) as ClaimResponse | undefined;
      if (response && Array.isArray(response.scripts)) return response;
    } catch {
      // Safari's background was asleep, or is still waking. Retrying is safe: the claim is keyed by
      // docKey, so a retry that reaches a worker which already answered replays rather than re-runs.
    }
    await sleep(CLAIM_BACKOFF_MS * (attempt + 1));
  }
  return null;
}

/** Run one mod when its phase arrives. */
function schedule(script: ScriptToRun, bridge: unknown, report: (out: unknown) => void): void {
  void whenPhase(phaseFor(script.runAt)).then(() => run(script, bridge, report));
}

function run(script: ScriptToRun, bridge: unknown, report: (out: unknown) => void): void {
  if (script.world === 'MAIN') {
    // A page-world mod asked for the page's own globals, so it goes in as an inline <script>. The
    // page's CSP may refuse that, and usermods does not rewrite a site's CSP to get its way; what it
    // does is notice and say so (lib/exec/evaluate.ts).
    const ran = injectIntoPage(script.code, newNonce(), document);
    if (!ran) reportBlocked(script, pageBlockedMessage());
    return;
  }
  if (!evalAllowed()) {
    reportBlocked(script, `This page's Content-Security-Policy stops usermods evaluating scripts here.`);
    return;
  }
  try {
    evaluateIsolated(script.code, { bridge, report });
  } catch (e) {
    console.error(`[usermods] ${script.name} failed to start`, e);
    reportBlocked(script, e instanceof Error ? e.message : String(e));
  }
}

function reportBlocked(script: ScriptToRun, reason: string): void {
  try {
    void chrome.runtime.sendMessage({ [EXEC_TAG]: 'blocked', modId: script.modId, world: script.world, reason });
  } catch {
    /* nothing left to report to */
  }
}

function pageBlockedMessage(): string {
  return `This page's Content-Security-Policy blocked a page-world script. Set this mod's world to the isolated world if it does not need the page's own variables.`;
}

/**
 * Resolve when a phase has arrived, or immediately when it is already past.
 *
 * The second half is what makes a late claim work. A runner injected into a tab that was already
 * open, or answered after Safari woke the background back up, would otherwise wait forever for a
 * DOMContentLoaded that fired before it existed.
 */
function whenPhase(phase: RunPhase): Promise<void> {
  if (phasesElapsed(document.readyState).includes(phase)) return Promise.resolve();
  if (phase === 'end') {
    return new Promise((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  }
  // 'idle' is load plus a turn, which is what Chrome means by it.
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, 0);
    if (document.readyState === 'complete') done();
    else window.addEventListener('load', done, { once: true });
  });
}

function isRunOnce(msg: unknown): msg is RunOnce {
  return typeof msg === 'object' && msg !== null && (msg as Record<string, unknown>)[EXEC_TAG] === 'run-once';
}

function isTopFrame(): boolean {
  try {
    return window.top === window.self;
  } catch {
    // A cross-origin parent makes window.top unreadable, which only happens inside a frame.
    return false;
  }
}

/**
 * A fresh identity per document.
 *
 * It exists so a retried claim can be recognised as the same one; it is NOT a secret and the
 * background treats it as untrusted input (it is page-side generated, so a claim's tab and frame are
 * checked alongside it before any grant is replayed).
 */
function newDocKey(): string {
  return newNonce();
}

function newNonce(): string {
  try {
    return crypto.randomUUID();
  } catch {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
