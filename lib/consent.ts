// First-run data notice. Before the first message is ever sent to a model, the panel explains what
// leaves the browser and where it goes. The acknowledgement is a single flag in
// chrome.storage.local, so it survives the service worker sleeping and browser restarts but stays
// on this device: nothing about it is ever sent anywhere.

export const CONSENT_KEY = 'consent';

/** What the user acknowledged, and when. `version` lets a future material change ask again. */
export interface ConsentRecord {
  version: number;
  acceptedAt: number;
}

/**
 * Bumping this re-shows the notice to everyone. Only do that when what the extension sends, or
 * where it sends it, has materially changed — not for wording fixes.
 */
export const CONSENT_VERSION = 1;

export async function loadConsent(): Promise<ConsentRecord | null> {
  try {
    const r = await chrome.storage.local.get(CONSENT_KEY);
    const c = r[CONSENT_KEY] as Partial<ConsentRecord> | undefined;
    return typeof c?.version === 'number' ? { version: c.version, acceptedAt: c.acceptedAt ?? 0 } : null;
  } catch {
    return null;
  }
}

/** True when the notice has been acknowledged at the current version. */
export function isAccepted(c: ConsentRecord | null): boolean {
  return !!c && c.version >= CONSENT_VERSION;
}

export async function hasConsented(): Promise<boolean> {
  return isAccepted(await loadConsent());
}

export async function acceptConsent(): Promise<ConsentRecord> {
  const record: ConsentRecord = { version: CONSENT_VERSION, acceptedAt: Date.now() };
  await chrome.storage.local.set({ [CONSENT_KEY]: record });
  return record;
}

/** Show the notice again on the next send. Used by "Review data notice" in Settings. */
export async function resetConsent(): Promise<void> {
  await chrome.storage.local.remove(CONSENT_KEY);
}
