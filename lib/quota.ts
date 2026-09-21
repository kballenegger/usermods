// Running out of chrome.storage.local, and saying so.
//
// THE MEASUREMENT. The Chrome manifest asks for `storage` and not `unlimitedStorage`, so
// chrome.storage.local is capped at 10 MB. Against the real constants in lib/images.ts, one
// full-size attachment costs ~1.53 MB of that quota once base64 is counted (MAX_BYTES is 1.2 MB
// decoded, and base64 is 4/3 of it), and it lives in 'chat:<id>:blobs' for as long as the chat
// does. SIX attachments across a whole profile is the entire quota. A single 60-turn chat with an
// image every ten turns estimates at ~21 MB — twice the quota on its own.
//
// So "it breaks in long sessions" has a storage half, and it used to break SILENTLY: every
// transcript save in the panel and the background is `.catch(() => {})`, the blob writer swallows
// its own failure by design, and a chat that could no longer be written simply stopped being
// written. The user keeps talking to a conversation that is no longer being saved and finds out on
// the next panel open.
//
// WHAT THIS MODULE DOES. Two things, neither of which is "ask for unlimitedStorage":
//
//   1. Recognises a quota failure, so a save that failed for THIS reason can be reported instead of
//      swallowed. Callers still never throw from a save — losing the reply because the transcript
//      could not be written would be worse — but they can now say what happened.
//   2. Measures what is stored, so the panel can warn before the wall rather than at it.
//
// Why not `unlimitedStorage`: it is a new permission on an extension whose v0.1.0 is in review at
// the Chrome Web Store, it changes the manifest and the permissions justification, and it does not
// fix the actual problem, which is that nothing ever evicted a blob (lib/blobs.ts had pruneBlobs
// written and never called). Bounding what is stored is the fix; the permission is a decision for
// the owner, with these numbers in hand. See docs/qa-checklist.md.

/** Chrome's cap on storage.local without the `unlimitedStorage` permission. */
export const QUOTA_BYTES = 10 * 1024 * 1024;

/** Warn the user once usage passes this share of the quota, while there is still room to act. */
export const WARN_AT = 0.8;

/**
 * Is this the storage quota, rather than some other storage failure?
 *
 * Chrome throws / sets lastError with "QUOTA_BYTES quota exceeded" or "QUOTA_BYTES_PER_ITEM quota
 * exceeded"; Firefox says "QuotaExceededError"; Safari's WebExtension layer says "exceeded the
 * quota". A DOMException named QuotaExceededError is the spec spelling. Anything else — storage
 * unavailable, the context going away mid-write — is a different problem with a different answer.
 */
export function isQuotaError(e: unknown): boolean {
  if (!e) return false;
  const name = (e as { name?: unknown }).name;
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return true;
  const message = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  return /quota|storage full|exceeded the storage/i.test(message);
}

/** What the panel says when a write was refused for want of room. One string, one place. */
export const QUOTA_PANEL_NOTE =
  'Out of extension storage. This chat is no longer being saved. Delete some chats, or remove attached images, in the dashboard — then send again.';

/** What it says while there is still room, but not much. */
export function quotaWarningNote(usedBytes: number): string {
  const pct = Math.min(99, Math.round((usedBytes / QUOTA_BYTES) * 100));
  return `Extension storage is ${pct}% full. Attached images are the bulk of it — delete old chats in the dashboard to free space before saving stops working.`;
}

/**
 * How much of the quota is in use, or null when the browser will not say.
 *
 * getBytesInUse with no argument is the whole area. Safari has not always implemented it, and a
 * measurement that is unavailable must not become a measurement of zero — hence null rather than a
 * number, so a caller cannot accidentally read "unavailable" as "empty".
 */
export async function bytesInUse(): Promise<number | null> {
  try {
    const area = chrome.storage.local as unknown as { getBytesInUse?: (keys?: null) => Promise<number> };
    if (typeof area.getBytesInUse !== 'function') return null;
    const n = await area.getBytesInUse(null);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Is usage far enough along to be worth telling the user about? Null usage never warns. */
export function shouldWarn(usedBytes: number | null): boolean {
  return usedBytes !== null && usedBytes >= QUOTA_BYTES * WARN_AT;
}

/**
 * Write to storage, reporting a quota failure instead of throwing it.
 *
 * Every existing save is fire-and-forget for a good reason: failing the user's turn because the
 * transcript could not be written would lose the reply as well as the record. That reason still
 * holds — this does not make saves throw. It makes the failure SAYABLE, which is the whole
 * difference between "long sessions break" and "long sessions tell you why".
 *
 * Returns 'ok', 'quota' or 'error'.
 */
export async function trySet(items: Record<string, unknown>): Promise<'ok' | 'quota' | 'error'> {
  try {
    await chrome.storage.local.set(items);
    return 'ok';
  } catch (e) {
    return isQuotaError(e) ? 'quota' : 'error';
  }
}
