/**
 * The device-code sign-in, as state that outlives the thing polling it.
 *
 * ---------------------------------------------------------------------------
 * Why this module exists
 * ---------------------------------------------------------------------------
 *
 * A device-code grant is a poll that runs for minutes: the user is handed a short code, goes to a
 * vendor page in another tab, types it, approves, and only then does the token endpoint stop
 * answering `authorization_pending`. Until this module, all of that lived in two pieces of memory
 * that Safari does not keep:
 *
 *   1. A `Map<OAuthKind, {state, controller}>` in the background worker, plus an in-flight promise
 *      chain inside `login.poll(signal)` — an `await sleep(interval)` loop. On Chrome the MV3
 *      worker stays alive while a promise from an extension callback is outstanding and the panel
 *      keeps poking it every 2s. On Safari, and on iOS especially, the background is an event page
 *      the system suspends whenever it feels like it. A suspended worker loses the Map, loses the
 *      AbortController, and loses the timer — and `device_code`, the only thing that could resume
 *      the flow, was never written down. The sign-in cannot be recovered; it can only be restarted,
 *      which gives the user a new code that does not match the page they are looking at.
 *
 *   2. `useState` in the popup's SubscriptionLogin. On iOS the popup is a sheet over the page, and
 *      opening the verification tab dismisses it. So the component that was holding the user code
 *      unmounts at the exact moment the user needs the code. Reopening the popup ran
 *      `setLogin({status:'idle'})` and drew a fresh "Sign in with ChatGPT" button, as if nothing
 *      were in flight — while a real, approvable code was live on the vendor's page.
 *
 * So everything needed to resume — the device code, the user code, the verification URI, the
 * interval, the expiry, which vendor — is written to `chrome.storage.local` before the user is sent
 * anywhere, and the poll is a stateless function of that record plus the clock. Any surface can
 * pick it up: the background when it wakes, the popup when it reopens, either of them after the
 * other was killed.
 *
 * ---------------------------------------------------------------------------
 * Why the popup polls, and not chrome.alarms
 * ---------------------------------------------------------------------------
 *
 * `chrome.alarms` is the usual answer for "wake a suspended MV3 worker later", and it is the wrong
 * one here, for two reasons that compound:
 *
 *   - **The floor is a minute.** `chrome.alarms` rejects (Chrome) or clamps (Safari) any period
 *     under 1 minute. A device-code flow's `interval` is 5 seconds, and the vendors' codes expire
 *     in 15 minutes (ChatGPT) or as little as 10 (xAI). Polling once a minute turns "approve it and
 *     it lands" into "approve it and wait up to a minute", which reads as broken, and wastes a
 *     sixth of the window on every tick.
 *   - **It is a permission the manifest does not have,** and adding `alarms` to the Safari manifest
 *     for this would also be a new permission string in an App Store review, for a worse flow.
 *
 * What is actually reliable is simpler: **the user is present.** A device-code sign-in is not a
 * background sync — it happens because someone is looking at the screen, and the moment that
 * matters (the approval landing) is a moment they are waiting for. So the poll is driven by
 * whichever extension page is open, through the `oauth.poll` RPC, and the background does one poll
 * attempt per call using the persisted record. If the worker is suspended between two calls,
 * nothing is lost: the next call wakes it and it reads the record back. If the popup is closed
 * entirely, the flow is not lost either — it is sitting in storage, still valid, and reopening the
 * popup resumes it and shows the same code (`restore` below). The background ALSO polls on its own
 * while it happens to be alive, so an approval that lands while the popup is shut is picked up at
 * the next wake rather than waiting for the user to look.
 *
 * Everything in this file is pure except the storage accessors at the bottom, so the whole state
 * machine — resume, slow_down, expiry, cancel, success, two vendors at once — is unit tested in
 * test/pendinglogin.test.ts without a browser.
 */

// Type-only, and .ts on the value import: this module is unit tested under
// node --experimental-strip-types, whose resolver does not guess extensions.
import type { OAuthKind } from './rpc';

/** Where a vendor's in-flight sign-in is kept. One record per vendor, so both can be pending. */
export const pendingKey = (kind: OAuthKind) => `oauth:pending:${kind}`;

/**
 * Everything needed to resume a device-code poll from cold.
 *
 * `deviceCode` is the credential the token endpoint wants and the one piece that could not be
 * reconstructed; `userCode` and `verificationUri` are what the user needs shown back to them.
 * ChatGPT's token call needs the user code as well as the device auth id, which is why both are
 * stored rather than only the one the RFC names.
 */
export interface PendingLogin {
  kind: OAuthKind;
  /** The vendor's device-code credential: `device_code` (xAI) or `device_auth_id` (ChatGPT). */
  deviceCode: string;
  /** The short code the user types on the vendor's page. Shown, and copyable. */
  userCode: string;
  /** Where the user types it. */
  verificationUri: string;
  /** Seconds between polls, as the vendor asked. Grows on `slow_down`. */
  intervalSec: number;
  /** Epoch ms after which the vendor will reject the code. */
  expiresAt: number;
  /** Epoch ms of the last poll attempt, so a resume does not poll faster than the interval. */
  lastPolledAt: number;
  /** Epoch ms the flow was started, for the "waiting since" line and for diagnostics. */
  startedAt: number;
}

/** The smallest interval any vendor is allowed to talk us into, in seconds. */
export const MIN_INTERVAL_SEC = 1;
/** How much a `slow_down` adds, per RFC 8628 §3.5. */
export const SLOW_DOWN_STEP_SEC = 5;
/** A ceiling, so a vendor answering `slow_down` in a loop cannot stretch the poll past usefulness. */
export const MAX_INTERVAL_SEC = 60;

/** A record built from what a vendor's device-code call returned. */
export function pendingFrom(
  kind: OAuthKind,
  d: { deviceCode: string; userCode: string; verificationUri: string; intervalSec?: number; expiresAt: number },
  now: number,
): PendingLogin {
  return {
    kind,
    deviceCode: d.deviceCode,
    userCode: d.userCode,
    verificationUri: d.verificationUri,
    intervalSec: clampInterval(d.intervalSec ?? 5),
    expiresAt: d.expiresAt,
    // Zero, not `now`: the first poll should not wait a full interval on top of the round trip the
    // device-code call already cost. The user is typically still walking to the other tab.
    lastPolledAt: 0,
    startedAt: now,
  };
}

export function clampInterval(sec: number): number {
  if (!Number.isFinite(sec)) return 5;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.floor(sec)));
}

/** A `slow_down` from the vendor: back off by the RFC's step, up to the ceiling. */
export function slowDown(p: PendingLogin): PendingLogin {
  return { ...p, intervalSec: clampInterval(p.intervalSec + SLOW_DOWN_STEP_SEC) };
}

export function isExpired(p: PendingLogin, now: number): boolean {
  return now >= p.expiresAt;
}

/**
 * Whether it is time to hit the token endpoint again.
 *
 * This is what makes resuming safe. The caller is a poll RPC that may be called at any rate at all
 * — a popup's 2s timer, a background wake, a user reopening the popup twice in a second — and the
 * vendor will answer `slow_down` or rate-limit if that rate reaches it. The decision is made from
 * the stored `lastPolledAt` rather than from a timer, so it holds across a worker that died and
 * across two surfaces asking at once.
 */
export function shouldPoll(p: PendingLogin, now: number): boolean {
  if (isExpired(p, now)) return false;
  return now - p.lastPolledAt >= p.intervalSec * 1000;
}

/** How long until the next poll is due, in ms (0 when it is due now). For a UI countdown. */
export function msUntilNextPoll(p: PendingLogin, now: number): number {
  return Math.max(0, p.lastPolledAt + p.intervalSec * 1000 - now);
}

/** The vendor's name, as every user-facing string in this flow spells it. */
export function vendorName(kind: OAuthKind): string {
  return kind === 'chatgpt' ? 'ChatGPT' : 'SuperGrok';
}

/** The sentence shown when a code ran out before it was approved. */
export function expiredMessage(kind: OAuthKind): string {
  return `The ${vendorName(kind)} sign-in code expired before it was approved. Start again to get a new one.`;
}

// ---------------------------------------------------------------------------
// One step of the machine
// ---------------------------------------------------------------------------

/** What a single poll attempt against the vendor came back as, normalised across the two vendors. */
export type PollOutcome =
  | { kind: 'pending' }
  | { kind: 'slow_down' }
  | { kind: 'success'; tokens: unknown }
  | { kind: 'denied'; message: string }
  | { kind: 'expired' }
  /** The network or the vendor failed in a way that is worth retrying: keep the flow alive. */
  | { kind: 'retry'; message: string }
  /** Something the flow cannot recover from. Ends it. */
  | { kind: 'fatal'; message: string };

/** What the caller should do with the stored record after an outcome. */
export type PendingEffect =
  | { store: 'keep'; next: PendingLogin }
  | { store: 'clear' };

/**
 * Fold one poll outcome into the stored record.
 *
 * Split out from the I/O so every branch is testable: a `slow_down` must widen the interval and
 * keep the flow, a `retry` must keep the flow without widening it, and everything terminal must
 * clear the record so a later popup does not resurrect a dead code.
 */
export function applyOutcome(p: PendingLogin, outcome: PollOutcome, now: number): PendingEffect {
  const polled = { ...p, lastPolledAt: now };
  switch (outcome.kind) {
    case 'pending':
      return { store: 'keep', next: polled };
    case 'slow_down':
      return { store: 'keep', next: slowDown(polled) };
    case 'retry':
      // A transient failure is not the user's problem and not a reason to make them read a new
      // code off a new page. The flow stays, and the next tick tries again.
      return { store: 'keep', next: polled };
    case 'success':
    case 'denied':
    case 'expired':
    case 'fatal':
      return { store: 'clear' };
  }
}

/**
 * The login state a surface should show, given what is in storage.
 *
 * The popup calls this on every mount, which is what makes a reopened popup resume rather than
 * offer a fresh sign-in button. An expired record reads as an error with the "start again"
 * sentence rather than as pending, so a stale code is never presented as though it could still be
 * typed.
 */
export function restore(p: PendingLogin | null, now: number):
  | { status: 'idle' }
  | { status: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { status: 'error'; message: string } {
  if (!p) return { status: 'idle' };
  if (isExpired(p, now)) return { status: 'error', message: expiredMessage(p.kind) };
  return { status: 'pending', userCode: p.userCode, verificationUri: p.verificationUri, expiresAt: p.expiresAt };
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export async function loadPending(kind: OAuthKind): Promise<PendingLogin | null> {
  const r = await chrome.storage.local.get(pendingKey(kind));
  const v = r[pendingKey(kind)] as PendingLogin | undefined;
  // A record from a different shape (an older build, a half-written value) is not worth guessing
  // at: it cannot be polled without a device code, and offering a code the vendor never issued
  // would be worse than starting over.
  if (!v || typeof v.deviceCode !== 'string' || !v.deviceCode) return null;
  return v;
}

export async function savePending(p: PendingLogin): Promise<void> {
  await chrome.storage.local.set({ [pendingKey(p.kind)]: p });
}

export async function clearPending(kind: OAuthKind): Promise<void> {
  await chrome.storage.local.remove(pendingKey(kind));
}

/** Both vendors' records, for a surface that shows both cards at once. */
export async function loadAllPending(): Promise<Partial<Record<OAuthKind, PendingLogin>>> {
  const kinds: OAuthKind[] = ['chatgpt', 'xai'];
  const r = await chrome.storage.local.get(kinds.map(pendingKey));
  const out: Partial<Record<OAuthKind, PendingLogin>> = {};
  for (const k of kinds) {
    const v = r[pendingKey(k)] as PendingLogin | undefined;
    if (v && typeof v.deviceCode === 'string' && v.deviceCode) out[k] = v;
  }
  return out;
}
