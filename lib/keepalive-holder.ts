// The page's half of the Safari keepalive: hold a port open so the background stays awake.
//
// This runs in a content script (entrypoints/content.ts). The background asks for a hold when a run
// starts on this tab and releases it when the run ends; see lib/keepalive.ts for the mechanism, the
// sources behind it and its limits, and entrypoints/background.ts for the other end of the wire.
//
// Kept out of the content script's own file for two reasons: the background must never import a
// content-script entrypoint, and the holder has a lifecycle worth reading on its own — connect,
// ping, reconnect with backoff, and stop dead when released.
//
// The impure half is deliberately thin (one port, one interval, one timer), because every rule it
// follows is a pure function in lib/keepalive.ts that node tests directly.

// .ts on the value import: this module's state machine is unit tested under
// node --experimental-strip-types, whose resolver does not guess extensions.
import { KEEPALIVE_PING_MS, KEEPALIVE_PORT, reconnectDelay } from './keepalive.ts';

/** What the background sends down a keepalive port. `release` is the only one that means anything. */
export interface KeepaliveMessage {
  type: 'release';
}

export interface Holder {
  /** Start holding, or do nothing if already holding. Safe to call repeatedly. */
  start(): void;
  /** Stop holding: disconnect, cancel the ping and the reconnect, and stay stopped. */
  stop(): void;
  /** For the tests and the debug page: is a port open right now? */
  readonly connected: boolean;
}

/**
 * A keepalive holder for this document.
 *
 * The contract is narrow on purpose:
 *
 *  - **Nothing happens until `start()`.** A page that is not hosting a run opens no port and posts
 *    no messages, so the battery cost of this feature on an idle tab is exactly zero. `start()` is
 *    only ever called because the background asked.
 *  - **A dropped port is reconnected, with backoff** (lib/keepalive.ts `reconnectDelay`). A drop is
 *    the NORMAL case, not an error: the page navigates and this document dies with its port, or
 *    Safari suspends the background out from under it. The first case is handled by the NEW
 *    document's content script being asked again; the second is handled here, by reaching for the
 *    background until it answers, which is the only thing that can wake a suspended one.
 *  - **`release` from the background is final.** The run ended. The holder stops and does not
 *    reconnect — otherwise the ping would outlive the work it exists for, which is precisely the
 *    battery drain this is bounded to avoid.
 *  - **A connect that throws is not fatal.** `chrome.runtime.connect` throws synchronously when the
 *    extension context is gone (a reload, an update). The holder treats it as a drop and retries,
 *    so a run that survives an extension reload is not held back by a holder that gave up.
 */
export function createHolder(
  // Injected so the node tests can drive this without a browser. Production passes nothing.
  deps: {
    connect?: (name: string) => chrome.runtime.Port;
    setTimeout?: (fn: () => void, ms: number) => unknown;
    clearTimeout?: (h: unknown) => void;
    setInterval?: (fn: () => void, ms: number) => unknown;
    clearInterval?: (h: unknown) => void;
  } = {},
): Holder {
  const connect = deps.connect ?? ((name: string) => chrome.runtime.connect({ name }));
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const clearI = deps.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));

  let port: chrome.runtime.Port | null = null;
  let ping: unknown = null;
  let retry: unknown = null;
  let attempt = 0;
  let wanted = false;

  function clearTimers(): void {
    if (ping !== null) {
      clearI(ping);
      ping = null;
    }
    if (retry !== null) {
      clearT(retry);
      retry = null;
    }
  }

  function open(): void {
    if (!wanted || port) return;
    let p: chrome.runtime.Port;
    try {
      p = connect(KEEPALIVE_PORT);
    } catch {
      // The extension context is gone (reload, update, disable). Keep reaching: if it comes back,
      // the run's background may still be there to be held.
      scheduleRetry();
      return;
    }
    port = p;
    // A connect that succeeded is what resets the backoff, not a connect that was merely attempted:
    // a background that accepts and immediately drops is still a background in trouble, and should
    // not have this document hammering it at 500ms forever.
    attempt = 0;
    p.onMessage.addListener((m: unknown) => {
      if ((m as KeepaliveMessage | null)?.type === 'release') stop();
    });
    p.onDisconnect.addListener(() => {
      // chrome.runtime.lastError is read and discarded: an unchecked one logs noisily in some
      // engines, and there is nothing to decide from it — a disconnect is a disconnect. Guarded
      // because the node tests drive this module with no `chrome` global at all.
      try {
        void globalThis.chrome?.runtime?.lastError;
      } catch {
        /* nothing to read */
      }
      if (port === p) port = null;
      if (wanted) scheduleRetry();
    });
    if (ping === null) {
      ping = setI(() => {
        if (!port) return;
        try {
          // The message body is irrelevant; what keeps the background up is the traffic on an open
          // port. It is named so anything reading the wire can tell what it is.
          port.postMessage({ type: 'ping' });
        } catch {
          // Posting to a port the engine has already torn down. onDisconnect may not have fired yet;
          // drop it here and let the retry path reopen.
          port = null;
          scheduleRetry();
        }
      }, KEEPALIVE_PING_MS);
    }
  }

  function scheduleRetry(): void {
    if (!wanted || retry !== null) return;
    attempt += 1;
    retry = setT(() => {
      retry = null;
      open();
    }, reconnectDelay(attempt));
  }

  function stop(): void {
    wanted = false;
    clearTimers();
    attempt = 0;
    const p = port;
    port = null;
    try {
      p?.disconnect();
    } catch {
      /* already gone */
    }
  }

  return {
    start(): void {
      if (wanted) return;
      wanted = true;
      attempt = 0;
      open();
    },
    stop,
    get connected(): boolean {
      return port !== null;
    },
  };
}
