/**
 * The wire between the mod runner and the background, and the validation that makes it safe.
 *
 * Under the content-script engine this traffic shares `chrome.runtime.onMessage` with the panel, the
 * dashboard and the page content script. There is no `onUserScriptMessage` on Safari to keep it
 * apart. So every message is checked here before the background acts on it, and the checks are an
 * allowlist rather than a shape guess: an unrecognised field is dropped, an unrecognised call type is
 * refused, and `modId` is not a field this protocol has at all. Identity comes from the token (see
 * lib/exec/grants.ts), never from the message.
 *
 * Pure, so the whole boundary is exercised in node (test/exec-protocol.test.ts) with the messages a
 * hostile sender would actually try.
 */

import type { GmMessage } from '../gm.ts';
import type { Mod } from '../types';

/** Marks a message as belonging to this protocol. Namespaced so nothing else can collide with it. */
export const EXEC_TAG = '__usermodsExec';

/** The port a document opens so the background can push GM value changes into it. */
export const EXEC_PORT = 'usermods-exec';

/** GM calls a mod may make. An allowlist: a type not named here never reaches handleGm. */
export const GM_CALLS = ['gm.setValue', 'gm.deleteValue', 'gm.xhr', 'gm.openInTab', 'gm.log'] as const;
export type GmCall = (typeof GM_CALLS)[number];

/** One mod, ready to run, as the background hands it over. */
export interface ScriptToRun {
  modId: string;
  name: string;
  /** Output of buildRegisteredCode(). A function body for the isolated world; page text for MAIN. */
  code: string;
  runAt: Mod['runAt'];
  world: Mod['world'];
  /** Present only for USER_SCRIPT-world code. MAIN-world code gets no capability (see grants.ts). */
  token?: string;
}

export interface ClaimRequest {
  docKey: string;
  url: string;
  topFrame: boolean;
  readyState: string;
}

export interface ClaimResponse {
  scripts: ScriptToRun[];
  /** True when this claim replayed an earlier one, so the runner can say so in a log rather than run. */
  replayed: boolean;
}

export interface GmRequest {
  token: string;
  call: GmCall;
  /** Everything else the GM message carries. Copied field by field, never spread wholesale. */
  key?: string;
  value?: unknown;
  url?: string;
  active?: boolean;
  details?: GmMessage['details'];
  args?: unknown[];
}

/** A mod could not be evaluated in this document. Reported so the failure is never silent. */
export interface BlockedReport {
  modId: string;
  world: Mod['world'];
  reason: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Does this message belong to the exec protocol at all? Cheap, so onMessage can bail early. */
export function execKind(msg: unknown): 'claim' | 'gm' | 'blocked' | null {
  if (!isRecord(msg)) return null;
  const kind = msg[EXEC_TAG];
  return kind === 'claim' || kind === 'gm' || kind === 'blocked' ? kind : null;
}

export function parseClaim(msg: unknown): ClaimRequest | null {
  if (!isRecord(msg) || msg[EXEC_TAG] !== 'claim') return null;
  const docKey = str(msg.docKey);
  const url = str(msg.url);
  if (!docKey || !url) return null;
  // A docKey is generated page-side, so its length is bounded here rather than trusted. It is only
  // ever a Map key, but an unbounded one is an unbounded allocation.
  if (docKey.length > 100) return null;
  return {
    docKey,
    url,
    topFrame: msg.topFrame === true,
    readyState: typeof msg.readyState === 'string' ? msg.readyState : 'loading',
  };
}

/**
 * A GM call, or null.
 *
 * Note what is NOT copied: `modId`, `__usermods`, and anything else the sender invented. A caller
 * that sets `modId: 'some-other-mod'` gets a request with no modId at all, and the background fills
 * in the one its grant says. That is the property test/exec-protocol.test.ts pins down.
 */
export function parseGm(msg: unknown): GmRequest | null {
  if (!isRecord(msg) || msg[EXEC_TAG] !== 'gm') return null;
  const token = str(msg.token);
  const call = msg.call;
  if (!token) return null;
  if (typeof call !== 'string' || !(GM_CALLS as readonly string[]).includes(call)) return null;
  const out: GmRequest = { token, call: call as GmCall };
  if (typeof msg.key === 'string') out.key = msg.key;
  if ('value' in msg) out.value = msg.value;
  if (typeof msg.url === 'string') out.url = msg.url;
  if (typeof msg.active === 'boolean') out.active = msg.active;
  if (Array.isArray(msg.args)) out.args = msg.args;
  const d = msg.details;
  if (isRecord(d) && typeof d.url === 'string') {
    out.details = {
      url: d.url,
      method: typeof d.method === 'string' ? d.method : undefined,
      headers: isRecord(d.headers) ? (d.headers as Record<string, string>) : undefined,
      data: typeof d.data === 'string' ? d.data : null,
      responseType: typeof d.responseType === 'string' ? d.responseType : undefined,
      timeout: typeof d.timeout === 'number' ? d.timeout : undefined,
    };
  }
  return out;
}

export function parseBlocked(msg: unknown): BlockedReport | null {
  if (!isRecord(msg) || msg[EXEC_TAG] !== 'blocked') return null;
  const modId = str(msg.modId);
  const reason = str(msg.reason);
  if (!modId || !reason) return null;
  const world = msg.world === 'MAIN' ? 'MAIN' : 'USER_SCRIPT';
  return { modId, world, reason: reason.slice(0, 500) };
}

/**
 * The `GmMessage` to hand to the existing background handler, built from a validated request and a
 * resolved grant.
 *
 * The one line that matters: `modId: grant.modId`. It is written last so no spread can overwrite it,
 * and the request it is built from has no modId field to spread in the first place.
 */
export function gmMessageFor(req: GmRequest, grant: { modId: string }): GmMessage {
  return {
    __usermods: true,
    type: req.call,
    key: req.key,
    value: req.value,
    url: req.url,
    active: req.active,
    details: req.details,
    args: req.args,
    modId: grant.modId,
  };
}
