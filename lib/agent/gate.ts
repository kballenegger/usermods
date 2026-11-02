// Whether a step may happen: allow, ask, or refuse. See docs/specs/browser-use.md, section 4.5.
//
// The decision reads only what the content script read from the live element (lib/interact/describe.ts)
// and what the user has answered. Nothing a model says and nothing a skill file claims is an input:
// `decide` has no parameter for either. A skill's `confirm: true` can add a question through
// `forceConfirm`; there is no way for anything to remove one.
//
// The word list is English. On a site in another language only the form rule applies, which is why
// the interface says "anything it can tell". What a misled model does by script gets past all of this
// (section 4.6); this is the rule for a typed step.
//
// Pure: no chrome.*, no DOM, tested under node (test/gate.test.ts).

import type { Described } from '../interact/describe';

/** The verbs of the act tool. */
export type Verb = 'click' | 'fill' | 'select' | 'check' | 'press' | 'hover' | 'scroll_to' | 'go';

/** A control or link whose name or path holds one of these, as a whole word, is consequential. */
export const CONSEQUENTIAL_WORDS: ReadonlySet<string> = new Set(['send', 'post', 'publish', 'pay', 'buy', 'purchase', 'order', 'checkout', 'delete', 'remove', 'cancel', 'unsubscribe', 'confirm', 'transfer']);

/** What `check` is for. It presses the element, so on anything else it is a click under another name. */
export const CHECKABLE_ROLES: ReadonlySet<string> = new Set(['checkbox', 'radio', 'switch', 'menuitemcheckbox', 'menuitemradio']);

/** What the user has answered, for this chat on this site. lib/agent/allowances.ts holds them. */
export interface GateAllowances {
  /** usermods may operate this site, standing or for this chat. */
  site: boolean;
  /** Named actions allowed for the rest of the chat: "allow every one of these". */
  actions: readonly string[];
}

export interface GateContext {
  verb: Verb;
  /** The key, for `press`. */
  key?: string;
  /** Hosts this run may go to with `go`: the site it started on, and any the user continued onto. */
  siteHosts?: readonly string[];
  /** Addresses that need no question: seen as a link in this chat, or typed by the user. */
  knownUrls?: readonly string[];
  /** Settings' "Ask before every step". */
  askEveryStep?: boolean;
  /** This step asks whatever else is true: a skill's `confirm: true`, a repair's steps. */
  forceConfirm?: boolean;
}

export type GateDecision =
  | { kind: 'allow' }
  | {
      kind: 'confirm';
      /** The first question on this site is part of this card. */
      asksSite: boolean;
      /** Why this step asks, in words for the card. Empty when only the site question is up. */
      reasons: string[];
      /** What "allow every one of these in this chat" would allow, when that is on offer. */
      actionKey?: string;
    }
  | { kind: 'deny'; reason: string };

const SCHEMES_WE_ACT_ON = new Set(['http:', 'https:', 'file:']);

function schemeOf(url: string): string | null {
  try {
    return new URL(url).protocol;
  } catch {
    return null;
  }
}

/** Can usermods act on this page at all? Everything but the web is a browser or extension page. */
export function isWebPage(url: string): boolean {
  const scheme = schemeOf(url);
  return scheme !== null && SCHEMES_WE_ACT_ON.has(scheme);
}

/** Would this key send the form the field is in? */
const isEnter = (key: string | undefined) => (key ?? '').trim().toLowerCase() === 'enter';

const isSpace = (key: string | undefined) => key === ' ' || (key ?? '').trim().toLowerCase() === 'space';

/** Does this key type into the field, as opposed to moving out of it? */
const typesText = (key: string | undefined) => !/^(tab|escape|esc|arrow(up|down|left|right))$/.test((key ?? '').trim().toLowerCase());

/**
 * Why a step is on the never list, or null. Shared with lib/interact/actions.ts, which checks again
 * in the page, whatever the background decided: it is the last thing between a message and a field.
 */
export function neverReason(d: Described, verb: Verb, key?: string): string | null {
  if (!isWebPage(d.pageUrl)) return 'it is on a browser or extension page';
  if (d.go?.kind === 'url' && !isWebPage(d.go.href)) return 'it goes to a browser or extension page';
  if (d.link && schemeOf(d.link.href) !== null && /^(chrome|chrome-extension|moz-extension|safari-web-extension|edge|about|devtools|view-source):$/.test(schemeOf(d.link.href)!)) return 'it opens a browser or extension page';
  if (d.field && (verb === 'fill' || verb === 'select' || (verb === 'press' && typesText(key)))) return `it types into a ${d.field} field`;
  const holds = d.form?.holds;
  if (holds && ((verb === 'click' && d.submits) || (verb === 'press' && (isEnter(key) || (isSpace(key) && d.submits))))) return `it submits a form holding a ${holds} field`;
  return null;
}

/** A string as lowercase whole words; `placeOrder` and `place_order` both hold "order". */
export function wordsOf(s: string): string[] {
  return s
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function consequentialWord(s: string | undefined): string | null {
  if (!s) return null;
  return wordsOf(s).find((w) => CONSEQUENTIAL_WORDS.has(w)) ?? null;
}

/** Verbs that activate something. Typing into "Order notes", or hovering a Delete, sends nothing. */
const ACTIVATES = new Set<Verb>(['click', 'check', 'select', 'press']);

/** Why a step is consequential, for the card; empty when it is not. Only what was read is read. */
export function consequentialReasons(d: Described, ctx: GateContext): string[] {
  const reasons: string[] = [];
  if (ctx.verb === 'go') {
    const go = d.go;
    if (go?.kind === 'url' && !(ctx.knownUrls ?? []).some((u) => sameAddress(u, go.href))) reasons.push('it goes to an address not seen on this site');
    return reasons;
  }
  if (!ACTIVATES.has(ctx.verb)) return reasons;
  const activates = ctx.verb !== 'press' || isEnter(ctx.key) || isSpace(ctx.key);
  if (ctx.verb === 'press') {
    const keyWord = consequentialWord(ctx.key);
    if (keyWord) reasons.push(`the key is ${ctx.key}`);
  }
  if (!activates) return reasons;
  const form = d.form;
  const submitting = d.submits || (ctx.verb === 'press' && isEnter(ctx.key) && !!form);
  if (submitting && form && form.method !== 'get') reasons.push('it submits a form');
  const word = consequentialWord(d.name) ?? consequentialWord(d.text);
  if (word) reasons.push(`it says "${word}"`);
  const pathWord = consequentialWord(d.link?.path) ?? (submitting ? consequentialWord(form?.action) : null);
  if (pathWord && pathWord !== word) reasons.push(`its address says "${pathWord}"`);
  return reasons;
}

/** Two addresses, ignoring the fragment. A string that is not a URL is never the same as anything. */
function sameAddress(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    x.hash = '';
    y.hash = '';
    return x.href === y.href;
  } catch {
    return false;
  }
}

/** What "allow every one of these" names: the verb and what the element reads, nothing wider. */
export function actionKey(d: Described, verb: Verb): string {
  const name = d.go?.kind === 'url' ? d.go.href : d.name.toLowerCase();
  return `${verb} ${d.role} "${name}"`;
}

/** www. is the same site, to `go` as to the boundary (lib/agent/boundary.ts). */
const bareHost = (host: string) => host.toLowerCase().replace(/^www\./, '');

/**
 * The decision. Order is the whole rule: the never list beats everything; then a question that is
 * forced cannot be answered away by an allowance; then the site's first question and the step's own
 * question share one card; and whatever is left is allowed.
 */
export function decide(d: Described, allowances: GateAllowances, ctx: GateContext): GateDecision {
  const never = neverReason(d, ctx.verb, ctx.key);
  if (never) return { kind: 'deny', reason: never };
  if (ctx.verb === 'go' && d.go?.kind === 'url') {
    const hosts = ctx.siteHosts?.map(bareHost);
    if (hosts && !hosts.includes(bareHost(d.go.host))) return { kind: 'deny', reason: 'it leaves this site' };
  }
  const key = actionKey(d, ctx.verb);
  const reasons = consequentialReasons(d, ctx);
  const forced = ctx.forceConfirm === true || ctx.askEveryStep === true;
  const named = reasons.length > 0 && !allowances.actions.includes(key);
  const asksSite = !allowances.site;
  if (!forced && !named && !asksSite) return { kind: 'allow' };
  // Offered only where it can do something: a forced step asks every time regardless.
  return { kind: 'confirm', asksSite, reasons, ...(reasons.length && !forced ? { actionKey: key } : {}) };
}
