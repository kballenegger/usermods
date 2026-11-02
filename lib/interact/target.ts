// Finding what a step is about: across open shadow roots and same-origin frames, and, when it is not
// there, saying what is closest. Refs and fingerprints are lib/interact/registry.ts; this file is the
// searching they and the inventory share.
//
// lib/waitdom.ts's queryAllDeep asks the document first and the shadow roots only on a miss, which is
// right for a read. A step needs the opposite: "this selector matches exactly one element" has to be
// true of the whole page, or a second match in a shadow root is clicked past unnoticed.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { liveProbe, type Probe } from '../inspect.ts';
import { elementsWithText, normalizeText } from '../waitdom.ts';
import { formatRoleName, isOperable, landmarkOf, nameOf, roleOf } from './name.ts';

/** The most elements a page walk visits. A page past this is said to be cut, never silently. */
export const WALK_CAP = 30_000;

/** A frame's document when it is a same-origin frame; null for anything else. */
function frameDocument(el: Element): Document | null {
  if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
  try {
    return (el as HTMLIFrameElement).contentDocument;
  } catch {
    return null; // cross-origin frames need a content script of their own: phase 5
  }
}

/** Every root a step can reach: the document, open shadow roots and same-origin frames, nested. */
export function searchRoots(doc: Document = document): ParentNode[] {
  const roots: ParentNode[] = [doc];
  const visit = (scope: ParentNode) => {
    for (const el of [...scope.querySelectorAll('*')]) {
      // Our own page UI is not part of the page.
      if (el.hasAttribute('data-usermods')) continue;
      const sr = el.shadowRoot;
      if (sr) {
        roots.push(sr);
        visit(sr);
      }
      const inner = frameDocument(el);
      if (inner) {
        roots.push(inner);
        visit(inner);
      }
    }
  };
  visit(doc);
  return roots;
}

/** Every element matching `selector` in every reachable root. Throws on an invalid selector. */
export function queryEverywhere(selector: string, doc: Document = document): Element[] {
  const out: Element[] = [];
  for (const root of searchRoots(doc)) {
    for (const el of [...root.querySelectorAll(selector)]) if (!el.hasAttribute('data-usermods')) out.push(el);
  }
  return out;
}

/** The operable elements under `scope` (or the whole page), in page order, shown ones only. */
export function operableElements(probe: Probe = liveProbe, scope?: Element, doc: Document = document): { found: Element[]; cut: boolean } {
  const found: Element[] = [];
  let visited = 0;
  const seen = (el: Element) => {
    visited++;
    if (isOperable(el, probe) && probe.visible(el)) found.push(el);
  };
  const walk = (root: ParentNode) => {
    for (const el of [...root.querySelectorAll('*')]) {
      if (visited >= WALK_CAP) return;
      if (el.hasAttribute('data-usermods')) continue;
      seen(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      const inner = frameDocument(el);
      if (inner) walk(inner);
    }
  };
  if (scope) {
    seen(scope);
    walk(scope);
    if (scope.shadowRoot) walk(scope.shadowRoot);
  } else {
    walk(doc);
  }
  return { found, cut: visited >= WALK_CAP };
}

// ---------------------------------------------------------------------------
// What a target can be, and how it can fail
// ---------------------------------------------------------------------------

/** The serialised fingerprint a skill's step carries (docs/specs/skills.md, section 1.2). */
export interface AtMap {
  css?: string;
  in?: string;
  nth?: number;
}

/** What a step names: a ref from find_elements, a selector, a visible text, or a recording. */
export type TargetSpec = { ref: string } | { selector: string } | { text: string } | { at: AtMap; role: string; name: string };

/** One of the closest matches a broken target reports. */
export interface Closest {
  role: string;
  name: string;
  landmark?: string;
  ref?: string;
}

/**
 * Why a target did not resolve to one element:
 *   none     nothing matched;
 *   several  more than one did, and nothing recorded tells them apart;
 *   changed  the recording found an element whose live role or name is not the recorded one;
 *   stale    a ref from a document that has gone;
 *   invalid  a selector the browser refuses.
 */
export type BrokenReason = 'none' | 'several' | 'changed' | 'stale' | 'invalid';

export interface RoleName {
  role: string;
  name: string;
}

export interface BrokenTarget {
  kind: 'broken';
  reason: BrokenReason;
  matches: number;
  recorded?: RoleName;
  live?: RoleName;
  closest: Closest[];
  /** Said for the model and the card: `0 matches; closest: 2 buttons in navigation "Billing"`. */
  message: string;
}

export type TargetResult = { kind: 'found'; el: Element; rebound?: boolean } | BrokenTarget;

// ---------------------------------------------------------------------------
// Closest matches
// ---------------------------------------------------------------------------

/** How many closest matches a broken target carries. */
export const CLOSEST_KEPT = 5;

const words = (s: string) => new Set(normalizeText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean));

/** How close a live element is to what was wanted: role, shared words of the name, the landmark. */
function closeness(want: Partial<RoleName> & { landmark?: string }, el: Element, name: string): number {
  let score = 0;
  if (want.name) {
    const a = words(want.name);
    const b = words(name);
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    if (shared) score += 2 + shared / Math.max(a.size, b.size);
  }
  if (want.role && roleOf(el) === want.role) score += 1;
  if (want.landmark && landmarkOf(el) === want.landmark) score += 1;
  return score;
}

/** The operable elements nearest to what was wanted, best first. Nothing related is nothing listed. */
export function closestMatches(want: Partial<RoleName> & { landmark?: string }, opts: { probe?: Probe; refOf?: (el: Element) => string; doc?: Document } = {}): Closest[] {
  const { found } = operableElements(opts.probe ?? liveProbe, undefined, opts.doc ?? document);
  const scored = found
    .map((el, i) => {
      const name = nameOf(el);
      return { el, name, i, score: closeness(want, el, name) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, CLOSEST_KEPT).map(({ el, name }) => {
    const landmark = landmarkOf(el);
    return { role: roleOf(el), name, ...(landmark ? { landmark } : {}), ...(opts.refOf ? { ref: opts.refOf(el) } : {}) };
  });
}

/**
 * The closest matches in one short phrase. Several of a role in one place fold, because "2 buttons
 * in navigation "Billing"" is what helps; one is named in full.
 */
export function formatClosest(closest: readonly Closest[]): string {
  const groups = new Map<string, Closest[]>();
  for (const c of closest) {
    const k = `${c.role}\n${c.landmark ?? ''}`;
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }
  return [...groups.values()]
    .map((g) => {
      const c = g[0]!;
      const where = c.landmark ? ` in ${c.landmark}` : '';
      if (g.length > 1) return `${g.length} ${c.role}${c.role.endsWith('s') ? 'es' : 's'}${where}`;
      return `${formatRoleName(c.role, c.name)}${c.ref ? ` [ref=${c.ref}]` : ''}${where}`;
    })
    .join('; ');
}

export const closestNote = (closest: readonly Closest[]) => (closest.length ? `; closest: ${formatClosest(closest)}` : '');

// ---------------------------------------------------------------------------
// By selector, and by text
// ---------------------------------------------------------------------------

export interface ResolveDeps {
  probe?: Probe;
  refOf?: (el: Element) => string;
  doc?: Document;
}

/** A selector must match exactly one element. Several are listed with their refs. */
export function resolveSelector(selector: string, deps: ResolveDeps = {}): TargetResult {
  let found: Element[];
  try {
    found = queryEverywhere(selector, deps.doc ?? document);
  } catch (e) {
    return { kind: 'broken', reason: 'invalid', matches: 0, closest: [], message: `Invalid selector: ${String(e)}` };
  }
  if (found.length === 1) return { kind: 'found', el: found[0]! };
  if (!found.length) return { kind: 'broken', reason: 'none', matches: 0, closest: [], message: `No element matches "${selector}".` };
  const closest = found.slice(0, CLOSEST_KEPT).map((el) => {
    const landmark = landmarkOf(el);
    return { role: roleOf(el), name: nameOf(el), ...(landmark ? { landmark } : {}), ...(deps.refOf ? { ref: deps.refOf(el) } : {}) };
  });
  const listed = closest.map((c) => `${formatRoleName(c.role, c.name)}${c.ref ? ` [ref=${c.ref}]` : ''}`).join(', ');
  return { kind: 'broken', reason: 'several', matches: found.length, closest, message: `${found.length} elements match "${selector}": ${listed}${found.length > closest.length ? ', …' : ''}. Use one ref.` };
}

/** A visible text: the deepest element holding it, or the control around that element. */
export function resolveText(text: string, deps: ResolveDeps = {}): TargetResult {
  const probe = deps.probe ?? liveProbe;
  const body = (deps.doc ?? document).body;
  const hits = body ? elementsWithText(body, text).map((m) => m.el) : [];
  const targets = new Set<Element>();
  for (const hit of hits) {
    if (!probe.visible(hit)) continue;
    let cur: Element | null = hit;
    while (cur && !isOperable(cur, probe)) cur = cur.parentElement;
    targets.add(cur ?? hit);
  }
  const list = [...targets];
  if (list.length === 1) return { kind: 'found', el: list[0]! };
  const closest = list.slice(0, CLOSEST_KEPT).map((el) => ({ role: roleOf(el), name: nameOf(el), ...(deps.refOf ? { ref: deps.refOf(el) } : {}) }));
  if (!list.length) return { kind: 'broken', reason: 'none', matches: 0, closest: [], message: `No element's text contains "${text}".` };
  return { kind: 'broken', reason: 'several', matches: list.length, closest, message: `${list.length} elements contain "${text}"${closestNote(closest)}. Use one ref.` };
}
