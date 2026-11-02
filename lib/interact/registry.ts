// Refs and fingerprints: how a step names an element, on this page and on a later visit.
//
// A ref is `k3e14`: a prefix derived from the document's performance.timeOrigin, then a counter. The
// origin is the value lib/navwatch.ts compares, so the background and this registry agree about what
// "the same page" is by construction: a real navigation is a new prefix and every old ref is stale,
// and a pushState keeps them. The map lives in the content script and dies with its document; nothing
// is written into the page's DOM.
//
// A fingerprint is what is kept about an element so it can be found again: role, name, tag, a stable
// selector, the landmark around it. Two things read it:
//   - a ref whose element was re-rendered gets one try at rebinding;
//   - a skill replays from it, serialised as the `at` map of docs/specs/skills.md section 1.2, with
//     the role and name on the verb line. The name check is strict on purpose: a recorded
//     `click: button "Save"` may not click a button that now reads anything else, whatever the
//     selector says.
//
// A fingerprint holds no field values: nameOf never reads one and the selector never uses one.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { liveProbe, type Probe } from '../inspect.ts';
import { selectorFor } from '../snapshot.ts';
import { formatRoleName, landmarkOf, nameOf, roleOf, sameName } from './name.ts';
import { closestMatches, closestNote, operableElements, queryEverywhere, resolveSelector, resolveText, type AtMap, type BrokenTarget, type ResolveDeps, type RoleName, type TargetResult, type TargetSpec } from './target.ts';

export interface Fingerprint {
  role: string;
  name: string;
  tag: string;
  css?: string;
  /** The nearest landmark: `form "New expense"`. */
  landmark?: string;
  /** The ordinal among elements of the same role and name, only when there are several. */
  nth?: number;
}

/** A ref's shape. The counter is digits, so the last `e` always separates it from the prefix. */
const REF = /^k([0-9a-z]*)e(\d+)$/;

/** Is this string a ref rather than a selector? */
export function isRef(s: string): boolean {
  return REF.test(s);
}

/** The prefix a document's refs carry: FNV-1a of its timeOrigin, three base-36 characters. */
export function refPrefix(timeOrigin: number): string {
  let h = 0x811c9dc5;
  for (const c of String(timeOrigin)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `k${(h % 46656).toString(36)}`;
}

const TEST_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy'];

const attrQuote = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const cssEscape = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`));

/** Does this selector pick out `el` alone, inside el's own root? */
function uniqueIn(el: Element, selector: string): boolean {
  try {
    const root = (el.getRootNode?.() ?? el.ownerDocument) as ParentNode;
    const found = root.querySelectorAll(selector);
    return found.length === 1 && found[0] === el;
  } catch {
    return false;
  }
}

/**
 * The most durable selector that picks out this element: an id, a test attribute, a name, an
 * aria-label, then the path selectorFor builds, used only when nothing better is unique.
 */
export function stableSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const candidates: string[] = [];
  if (el.id && !/\d{4,}/.test(el.id)) candidates.push(`#${cssEscape(el.id)}`);
  for (const a of TEST_ATTRS) {
    const v = el.getAttribute(a);
    if (v) candidates.push(`${tag}[${a}=${attrQuote(v)}]`);
  }
  const name = el.getAttribute('name');
  if (name) candidates.push(`${tag}[name=${attrQuote(name)}]`);
  const label = el.getAttribute('aria-label');
  if (label) candidates.push(`${tag}[aria-label=${attrQuote(label)}]`);
  for (const c of candidates) if (uniqueIn(el, c)) return c;
  return selectorFor(el);
}

/** The fingerprint of a live element. `withNth` scans the page; a ref's stored one goes without. */
export function fingerprintOf(el: Element, opts: { probe?: Probe; withNth?: boolean; doc?: Document } = {}): Fingerprint {
  const role = roleOf(el);
  const name = nameOf(el);
  const landmark = landmarkOf(el);
  const fp: Fingerprint = { role, name, tag: el.tagName.toLowerCase(), css: stableSelector(el), ...(landmark ? { landmark } : {}) };
  if (opts.withNth) {
    const alike = sameRoleAndName({ role, name }, opts.probe ?? liveProbe, opts.doc ?? document).filter((e) => landmarkOf(e) === landmark);
    if (alike.length > 1) fp.nth = alike.indexOf(el);
  }
  return fp;
}

/** The serialised half of a fingerprint. The role and name go on the step's verb line instead. */
export function toAt(fp: Fingerprint): AtMap {
  return { ...(fp.css ? { css: fp.css } : {}), ...(fp.landmark ? { in: fp.landmark } : {}), ...(fp.nth !== undefined ? { nth: fp.nth } : {}) };
}

/** Whatever a skill file holds, back as a fingerprint. Malformed values are dropped, not guessed at. */
export function fromAt(at: AtMap | undefined, role: string, name: string): Fingerprint {
  return {
    role,
    name,
    tag: '',
    ...(typeof at?.css === 'string' && at.css ? { css: at.css } : {}),
    ...(typeof at?.in === 'string' && at.in ? { landmark: at.in } : {}),
    ...(Number.isInteger(at?.nth) && at!.nth! >= 0 ? { nth: at!.nth } : {}),
  };
}

function sameRoleAndName(want: RoleName, probe: Probe, doc: Document): Element[] {
  return operableElements(probe, undefined, doc).found.filter((el) => roleOf(el) === want.role && sameName(nameOf(el), want.name));
}

function brokenFingerprint(fp: Fingerprint, reason: BrokenTarget['reason'], matches: number, deps: ResolveDeps, live?: RoleName): BrokenTarget {
  const closest = closestMatches({ role: fp.role, name: fp.name, ...(fp.landmark ? { landmark: fp.landmark } : {}) }, deps);
  const wanted = formatRoleName(fp.role, fp.name);
  const message =
    reason === 'changed'
      ? `${wanted} now reads ${formatRoleName(live!.role, live!.name)}${closestNote(closest)}`
      : reason === 'several'
        ? `${matches} elements match ${wanted}${closestNote(closest)}`
        : `could not find ${wanted} (0 matches${closestNote(closest)})`;
  return { kind: 'broken', reason, matches, recorded: { role: fp.role, name: fp.name }, ...(live ? { live } : {}), closest, message };
}

/**
 * Find a recorded element on the live page, strictly: exactly one connected, visible element with
 * the recorded role and name.
 *
 * The selector goes first, and among its hits those that also read right. A selector that finds only
 * elements reading differently is not yet the end, because a positional selector can drift onto a
 * neighbour while the real control has moved; so role and name are then searched on their own, and
 * only if that finds nothing is it the distinct `changed` result. `in` and `nth` tell several apart
 * and never turn a wrong name into a right one.
 */
export function resolveFingerprint(fp: Fingerprint, deps: ResolveDeps = {}): TargetResult {
  const probe = deps.probe ?? liveProbe;
  const doc = deps.doc ?? document;
  let bySelector: Element[] = [];
  if (fp.css) {
    try {
      bySelector = queryEverywhere(fp.css, doc).filter((el) => el.isConnected && probe.visible(el));
    } catch {
      /* a selector this browser refuses reads as one that found nothing */
    }
  }
  const reads = (el: Element) => roleOf(el) === fp.role && sameName(nameOf(el), fp.name);
  let hits = bySelector.filter(reads);
  if (!hits.length) hits = sameRoleAndName(fp, probe, doc);
  if (!hits.length && bySelector.length) {
    const first = bySelector[0]!;
    return brokenFingerprint(fp, 'changed', bySelector.length, deps, { role: roleOf(first), name: nameOf(first) });
  }
  if (!hits.length) return brokenFingerprint(fp, 'none', 0, deps);
  if (hits.length > 1 && fp.landmark) {
    const inPlace = hits.filter((el) => landmarkOf(el) === fp.landmark);
    if (inPlace.length) hits = inPlace;
  }
  if (hits.length > 1 && fp.nth !== undefined && hits[fp.nth]) hits = [hits[fp.nth]!];
  if (hits.length !== 1) return brokenFingerprint(fp, 'several', hits.length, deps);
  return { kind: 'found', el: hits[0]! };
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface Entry {
  el: WeakRef<Element>;
  fp: Fingerprint;
}

export interface Registry {
  /** This document's ref prefix. */
  readonly prefix: string;
  /** The element's ref, made on first sight and kept across calls. */
  refFor(el: Element): string;
  /** What a step names, on the live page. */
  resolve(spec: TargetSpec): TargetResult;
}

export function createRegistry(timeOrigin: number, opts: { probe?: Probe; doc?: Document } = {}): Registry {
  const prefix = refPrefix(timeOrigin);
  const probe = opts.probe ?? liveProbe;
  const entries = new Map<string, Entry>();
  const refs = new WeakMap<Element, string>();
  let counter = 0;

  const refFor = (el: Element): string => {
    let ref = refs.get(el);
    if (!ref) {
      ref = `${prefix}e${++counter}`;
      refs.set(el, ref);
    }
    // Refreshed on every sight, so a re-render is compared against what the element last read.
    entries.set(ref, { el: new WeakRef(el), fp: fingerprintOf(el, { probe }) });
    return ref;
  };

  const deps: ResolveDeps = { probe, refOf: refFor, ...(opts.doc ? { doc: opts.doc } : {}) };

  const resolveRef = (ref: string): TargetResult => {
    const m = REF.exec(ref);
    if (m && `k${m[1]}` !== prefix) {
      return { kind: 'broken', reason: 'stale', matches: 0, closest: [], message: `${ref} is from before the page navigated. Call find_elements for a fresh one.` };
    }
    const entry = entries.get(ref);
    if (!entry) return { kind: 'broken', reason: 'none', matches: 0, closest: [], message: `${ref} is not a ref on this page. Call find_elements for a fresh one.` };
    const el = entry.el.deref();
    if (el?.isConnected) return { kind: 'found', el };
    // Re-rendered: one try from the fingerprint. Exactly one match rebinds this ref to it.
    const again = resolveFingerprint(entry.fp, deps);
    if (again.kind === 'broken') return { ...again, message: `${ref} is gone: ${again.message}. Call find_elements for a fresh one.` };
    refs.set(again.el, ref);
    entries.set(ref, { el: new WeakRef(again.el), fp: fingerprintOf(again.el, { probe }) });
    return { kind: 'found', el: again.el, rebound: true };
  };

  return {
    prefix,
    refFor,
    resolve(spec) {
      if ('ref' in spec) return resolveRef(spec.ref);
      if ('selector' in spec) return resolveSelector(spec.selector, deps);
      if ('text' in spec) return resolveText(spec.text, deps);
      return resolveFingerprint(fromAt(spec.at, spec.role, spec.name), deps);
    },
  };
}
