/**
 * Capability grants: how the background knows WHICH mod a privileged message came from.
 *
 * On Chrome this question never had to be asked. `chrome.userScripts` gives the USER_SCRIPT world a
 * dedicated channel (`runtime.onUserScriptMessage`), so a message arriving there could only have
 * come from registered mod code, and the `modId` it carried was as trustworthy as the world it came
 * from. Safari has no such channel: the mod runner is an ordinary content script, so its GM traffic
 * arrives on the SAME `runtime.onMessage` the panel, the dashboard and every other content script
 * use. A self-declared `modId` on that channel is a claim, not a fact, and GM calls are not
 * harmless. `gm.xhr` makes a network request with the extension's own origin and the `@connect`
 * allowlist of whatever mod it claims to be; `gm.setValue` writes into another mod's storage.
 *
 * So the modId stops travelling in the message. The background mints a single-document grant before
 * it hands code to the runner, and the runner echoes only the opaque token back. The background
 * looks the token up and derives the mod from its own table. `resolve()` is the only place a modId
 * is ever produced, and it never reads one from the wire.
 *
 * What each property buys, all of it asserted in test/exec-grants.test.ts:
 *
 *  - **No forged identity.** A message claiming `modId: 'other'` cannot become mod 'other': the
 *    modId is whatever the token was issued for.
 *  - **No cross-mod leakage.** Mod A's token yields mod A's storage and mod A's `@connect` list.
 *    Two mods in the same document get two different tokens.
 *  - **No hostile-page access.** A page that somehow obtains a token still has to present it from
 *    the frame it was issued to, because `resolve()` compares the sender's tab AND frame. And a page
 *    cannot send extension messages at all without a content script doing it for them.
 *  - **No replay after the document is gone.** Navigation and tab close revoke; a grant also expires
 *    on its own, so a leak has a bounded lifetime even if a revoke is missed (a worker that was
 *    suspended when the tab closed never saw the event).
 *  - **No privilege after disabling.** Turning a mod off revokes every live grant it holds, so an
 *    already-running copy stops being able to call back even though its code cannot be unrun.
 *
 * Pure: no chrome APIs, no timers. The caller supplies randomness and the clock.
 */

import type { Mod } from '../types';

/** Who may present a token: the exact frame the grant was issued to. */
export interface GrantSender {
  tabId: number;
  frameId: number;
}

export interface Grant extends GrantSender {
  token: string;
  modId: string;
  /** The world the code was handed to. Page-world code gets no privileged grant at all. */
  world: Mod['world'];
  /** Per-document identity where the browser supplies one, so a same-URL reload is a new document. */
  documentId?: string;
  issuedAt: number;
}

/** Grants live for one document. Half an hour is far longer than any page load and still bounded. */
export const GRANT_TTL_MS = 30 * 60 * 1000;

/** 32 bytes of CSPRNG, hex. Long enough that guessing is not a threat model. */
export type RandomHex = () => string;

export class GrantTable {
  private readonly byToken = new Map<string, Grant>();
  private readonly random: RandomHex;
  private readonly ttlMs: number;

  // Fields assigned in the body rather than declared as constructor parameters: node runs this file
  // directly under --experimental-strip-types, which erases types and refuses to synthesize the
  // assignment a parameter property implies. The tests are the reason the module is pure, so the
  // form that node can load is the form to write.
  constructor(random: RandomHex, ttlMs: number = GRANT_TTL_MS) {
    this.random = random;
    this.ttlMs = ttlMs;
  }

  get size(): number {
    return this.byToken.size;
  }

  /**
   * Mint a grant for one mod in one frame.
   *
   * MAIN-world code is refused a grant on purpose. It runs in the page, where the page can read the
   * script text it came from, so any token handed there is a token the page has, and a page-held
   * token is a page-held capability. Chrome's MAIN world has no GM messaging either (`chrome` is not
   * defined there), so this is the existing contract enforced rather than a Safari-only limitation.
   */
  issue(spec: { modId: string; world: Mod['world']; documentId?: string } & GrantSender, now: number): Grant | null {
    if (spec.world !== 'USER_SCRIPT') return null;
    const grant: Grant = {
      token: this.random(),
      modId: spec.modId,
      world: spec.world,
      tabId: spec.tabId,
      frameId: spec.frameId,
      documentId: spec.documentId,
      issuedAt: now,
    };
    this.byToken.set(grant.token, grant);
    return grant;
  }

  /**
   * The grant a token stands for, or null.
   *
   * Every rejection reason is deliberate and none of them fall through to "allow":
   * an unknown token, an expired one, or one presented by a frame other than the one it was issued
   * to. The sender is supplied by the browser (`chrome.runtime.MessageSender`), not by the message,
   * which is what makes the binding worth anything.
   */
  resolve(token: unknown, sender: Partial<GrantSender> | null | undefined, now: number): Grant | null {
    if (typeof token !== 'string' || !token) return null;
    const grant = this.byToken.get(token);
    if (!grant) return null;
    if (now - grant.issuedAt > this.ttlMs) {
      this.byToken.delete(token);
      return null;
    }
    if (!sender || sender.tabId !== grant.tabId || sender.frameId !== grant.frameId) return null;
    return grant;
  }

  /** Every live grant for a mod, so the GM bridge can push value changes to its other frames. */
  forMod(modId: string): Grant[] {
    return [...this.byToken.values()].filter((g) => g.modId === modId);
  }

  /** A document is being replaced: everything issued into that frame is done. */
  revokeFrame(tabId: number, frameId: number): void {
    this.revokeWhere((g) => g.tabId === tabId && g.frameId === frameId);
  }

  /** The tab went away, or navigated at the top level (which takes every subframe with it). */
  revokeTab(tabId: number): void {
    this.revokeWhere((g) => g.tabId === tabId);
  }

  /** The mod was disabled, deleted or re-saved. Its running copies lose their capability now. */
  revokeMod(modId: string): void {
    this.revokeWhere((g) => g.modId === modId);
  }

  revokeToken(token: string): void {
    this.byToken.delete(token);
  }

  /** Drop expired grants. Cheap enough to call on every claim. */
  prune(now: number): void {
    this.revokeWhere((g) => now - g.issuedAt > this.ttlMs);
  }

  private revokeWhere(pred: (g: Grant) => boolean): void {
    for (const [token, grant] of this.byToken) if (pred(grant)) this.byToken.delete(token);
  }
}
