// DOM serialization for the model. Runs inside the content script.
// Produces a compact, pruned HTML-like view with a hard character budget.
//
// Two stages: buildTree walks the live DOM once into plain objects (the only part that needs a
// real page: visibility, shadow roots), and renderTree turns that into text under the budget. The
// second is a pure function, which is what lets the overflow behaviour be tested on saved pages.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import type { DeepMatch } from './waitdom.ts';

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'PATH', 'DEFS', 'CLIPPATH',
  'LINEARGRADIENT', 'RADIALGRADIENT', 'FILTER', 'MASK', 'SYMBOL', 'USE',
]);
const KEEP_ATTRS = [
  'id', 'class', 'href', 'src', 'alt', 'title', 'role', 'name', 'type', 'placeholder', 'value',
  'aria-label', 'aria-expanded', 'aria-hidden', 'data-testid', 'for', 'action', 'method', 'target', 'disabled', 'checked', 'selected',
  // The state half of ARIA: which tab is selected, which item is current, whether a toggle is on.
  // A mod that styles "the active tab" needs exactly these, and they are short.
  'aria-selected', 'aria-checked', 'aria-current', 'aria-pressed', 'aria-disabled',
];
const MAX_ATTR = 120;
const MAX_TEXT = 200;

/**
 * data-* attributes, within limits.
 *
 * The prompt tells the model to prefer data attributes for selectors, and they are usually the
 * most durable hook a site offers (`data-component="shelf"` survives redesigns that rename every
 * class), so the snapshot has to show them. But they are also where frameworks put their bulk:
 * Vue's `data-v-7ba5bd90` scoping marker on every node, tracking payloads of serialized JSON,
 * per-render ids and nonces, click-tracking payloads. So:
 *   - at most MAX_DATA_ATTRS per element, in document order (data-testid is kept separately above);
 *   - a name whose suffix looks generated (a hash, like data-v-7ba5bd90), that belongs to
 *     analytics (data-ga-*, data-track*, data-*-click…) or to navigation plumbing (turbo, pjax,
 *     hovercards), or that carries a URL or a UI string (data-*-url, data-*-text), is skipped;
 *   - a value is kept only if it is short and readable. A long value, JSON, a long unbroken token
 *     mixing letters and digits (a hash, an id) or a bare number (a row index, a line number, a
 *     record id) skips the attribute: it would cost tokens, and a mod selects on what an element
 *     IS, not on which one of forty it happens to be;
 *   - an empty value is shown as the bare name, the way a boolean flag reads in HTML;
 *   - the same name="value" pair is printed at most MAX_DATA_REPEATS times per snapshot. A marker
 *     every component carries (GitHub's data-view-component="true") tells the model nothing after
 *     it has seen it a few times, and a list of cards has made its point by then too.
 * Measured on live pages, a full snapshot grows by about 1% on Wikipedia, YouTube and Hacker News
 * and about 7% on a GitHub repository page, most of it Primer's data-component, which is exactly
 * the kind of hook a mod wants.
 */
const MAX_DATA_ATTRS = 4;
const MAX_DATA_VALUE = 40;
const MAX_DATA_REPEATS = 8;
const SKIPPED_NAME = /^(ga|gtm|octo|hydro|analytics|track|tracking|event|log|beacon|ping|ved|hveid|turbo|pjax|hovercard)([-_]|$)|(click|[-_](url|text|src|href))$/;
/**
 * Names that carry credentials or contact details, anywhere in the name. This output goes to a
 * third-party model and PRIVACY.md promises "a limited set of attributes": a short CSRF token or a
 * data-email passes the value checks, so these are dropped by name, whatever their value.
 */
const SENSITIVE_NAME = /(^|[-_])(csrf|xsrf|token|nonce|secret|password|passwd|session|sid|auth|signature|sig|apikey|api-key|email|e-mail|mail|phone|tel|ssn)([-_]|$)/;

/** Rendered and not display:none or visibility:hidden. Shared with lib/inspect.ts. */
export function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (typeof el.checkVisibility === 'function') {
    if (el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions)) return true;
    // display:contents has no box of its own, so checkVisibility is false for it by definition, and
    // every read dropped the whole subtree under it. Substack wraps its article and its subscribe
    // dialog in one. Its children are laid out and checked one by one as usual.
    return getComputedStyle(el).display === 'contents';
  }
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

/** Whitespace collapsed, then cut at `n` with an ellipsis, so a cut is always visible. */
export function trunc(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/** Is this attribute value noise to the model: too long, JSON, or a random-looking token? */
export function noisyDataValue(v: string): boolean {
  if (v.length > MAX_DATA_VALUE) return true;
  if (/^\s*[[{]/.test(v) || /^\d+$/.test(v)) return true;
  // An email address or a phone number, whatever the attribute is called.
  if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(v) || /^\+?[\d\s().-]{7,}$/.test(v)) return true;
  return v.length >= 16 && /^[\w+/=-]+$/.test(v) && /\d/.test(v) && /[a-z]/i.test(v);
}

/**
 * The data-* attributes worth printing for one element, already formatted. See MAX_DATA_ATTRS.
 * `seen` counts name="value" pairs across one snapshot, for MAX_DATA_REPEATS.
 */
export function dataAttrs(attrs: ReadonlyArray<readonly [string, string]>, seen: Map<string, number> = new Map()): string[] {
  const out: string[] = [];
  for (const [name, value] of attrs) {
    if (out.length >= MAX_DATA_ATTRS) break;
    if (!name.startsWith('data-') || name === 'data-testid') continue;
    const suffix = name.slice(5).toLowerCase();
    if (!suffix || suffix.length > 30 || SKIPPED_NAME.test(suffix) || SENSITIVE_NAME.test(suffix)) continue;
    if (isGeneratedClass(suffix) || /(^|[-_])(?=[a-z]*\d)[0-9a-f]{6,}$/i.test(suffix)) continue;
    if (value !== '' && noisyDataValue(value)) continue;
    const text = value === '' ? name : `${name}="${trunc(value, MAX_DATA_VALUE).replace(/"/g, '&quot;')}"`;
    const n = (seen.get(text) ?? 0) + 1;
    seen.set(text, n);
    if (n <= MAX_DATA_REPEATS) out.push(text);
  }
  return out;
}

export interface SnapshotOptions {
  root?: Element | null;
  maxChars?: number;
  maxDepth?: number;
  includeHidden?: boolean;
}

/**
 * One element of the snapshot, before rendering. `kids` holds rendered text and the `<…/>` depth
 * marker as strings, and child elements as nodes.
 */
export interface SNode {
  open: string;
  close: string;
  kids: (string | SNode)[];
  /** Characters of the full rendering. */
  size: number;
  /** Element descendants, for the "…N nodes" placeholder. */
  nodes: number;
  /** What makes siblings "similar": the tag and first class, e.g. `li.item`. */
  sig: string;
  /** ", 38× li.item" when most children look alike, for the placeholder. */
  hint: string;
  /** The first text inside, short, so a collapsed region still says what it is. */
  firstText: string;
}

function makeNode(open: string, close: string, kids: (string | SNode)[], sig: string): SNode {
  let size = open.length + close.length;
  let nodes = 0;
  let firstText = '';
  const sigs = new Map<string, number>();
  for (const k of kids) {
    if (typeof k === 'string') {
      size += k.length;
      if (!firstText && k !== '<…/>') firstText = k.trim();
    } else {
      size += k.size;
      nodes += 1 + k.nodes;
      if (!firstText) firstText = k.firstText;
      sigs.set(k.sig, (sigs.get(k.sig) ?? 0) + 1);
    }
  }
  let hint = '';
  let best = 0;
  for (const [s, n] of sigs) {
    if (n >= 3 && n > best) {
      best = n;
      hint = `, ${n}× ${s}`;
    }
  }
  return { open, close, kids, size, nodes, sig, hint, firstText };
}

/**
 * Walk the DOM into SNodes. Hidden elements, scripts and styles are left out, as before; an open
 * shadow root becomes a `#shadow-root` child ahead of the light children (which are what it slots).
 * `visible` is injectable so node tests can run this on a parsed page that has no layout.
 */
export function buildTree(root: Element, opts: { maxDepth?: number; includeHidden?: boolean } = {}, visible: (el: Element) => boolean = isVisible): SNode | null {
  const maxDepth = opts.maxDepth ?? 40;
  const seen = new Map<string, number>();
  const walkKids = (nodes: Iterable<Node>, depth: number): (string | SNode)[] => {
    const out: (string | SNode)[] = [];
    for (const k of nodes) {
      const r = walk(k, depth);
      if (r) out.push(r);
    }
    return out;
  };
  const walk = (node: Node, depth: number): string | SNode | null => {
    // nodeType numbers rather than Node.TEXT_NODE: the global Node does not exist in a node test.
    if (node.nodeType === 3) {
      const t = trunc(node.textContent ?? '', MAX_TEXT);
      return t ? t + ' ' : null;
    }
    if (node.nodeType !== 1) return null;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName.toUpperCase())) return null;
    if (!opts.includeHidden && !visible(el)) return null;
    if (depth > maxDepth) return '<…/>';
    const tag = el.tagName.toLowerCase();
    const attrs: string[] = [];
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v != null && v !== '') attrs.push(`${a}="${trunc(v, MAX_ATTR).replace(/"/g, '&quot;')}"`);
    }
    attrs.push(...dataAttrs(el.getAttributeNames().map((n) => [n, el.getAttribute(n) ?? ''] as const), seen));
    const a = attrs.length ? ' ' + attrs.join(' ') : '';
    const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
    const sig = cls ? `${tag}.${cls}` : tag;
    if (tag === 'svg') return makeNode(`<svg${a}/>`, '', [], sig);
    const kids: (string | SNode)[] = [];
    if (el.shadowRoot) kids.push(makeNode('<#shadow-root>', '</#shadow-root>', walkKids(el.shadowRoot.childNodes, depth + 1), '#shadow-root'));
    kids.push(...walkKids(el.childNodes, depth + 1));
    return makeNode(`<${tag}${a}>`, `</${tag}>`, kids, sig);
  };
  const r = walk(root, 0);
  return r && typeof r !== 'string' ? r : null;
}

// ---------------------------------------------------------------------------
// Rendering under a budget
// ---------------------------------------------------------------------------
//
// A page that fits is printed whole, exactly as it always was. A page that does not used to be cut
// at the budget in document order, which on a real site means the header and navigation were
// printed in full and the main content, the part the user is asking about, was what got lost.
//
// Now the page keeps its SHAPE instead. Every region appears; the ones that do not fit are
// collapsed to one line saying how big they are and what they start with, and the model opens one
// with get_page(selector). How the budget is shared out:
//   - each element gets at least its one-line placeholder, so nothing disappears;
//   - what is left is shared between siblings in proportion to their size, so the biggest region,
//     usually the content, gets the most detail. Equal or even square-root shares let a dozen small
//     menu items together outweigh one large article and starve it again (tried on the saved
//     GitHub page: the code lines came out as placeholders); the small ones lose little, since the
//     placeholder already names them;
//   - siblings are rendered smallest first, and whatever a small one did not use goes back into
//     the pot for the larger ones, so the budget is filled rather than rationed;
//   - a run of similar siblings (a feed, a result list, table rows) shows as many whole examples
//     as its share allows, at least FOLD_KEEP, then one `<… 35 more li.item/>` line. Three whole
//     items and a count say more than forty truncated ones.

/** Similar siblings below this count are never folded. */
const FOLD_MIN = 6;
/** How many examples of a folded run are always kept. */
const FOLD_KEEP = 3;
/** An element with fewer children than this is never cut, only collapsed. See cutPlan. */
const CUT_MIN_KIDS = 20;

/** How much of a parent's spare budget a child claims. See the section comment. */
const shareWeight = (k: SNode) => k.size;

function placeholder(n: SNode): string {
  const text = n.firstText ? `, "${n.firstText.length > 32 ? n.firstText.slice(0, 32) + '…' : n.firstText}"` : '';
  return `${n.open}…${n.nodes} nodes${n.hint}${text}${n.close}`;
}

/** The least an element can be printed as: whole if that is shorter than its placeholder. */
function minSize(n: SNode): number {
  return Math.min(n.size, placeholder(n).length);
}

function renderFull(n: SNode, out: string[]): void {
  out.push(n.open);
  for (const k of n.kids) {
    if (typeof k === 'string') out.push(k);
    else renderFull(k, out);
  }
  out.push(n.close);
}

/**
 * Which children to print, and the fold markers standing in for the rest. Null when not even a
 * cut list fits `avail`, in which case the parent prints this node's placeholder.
 */
function planKids(n: SNode, avail: number): (string | SNode)[] | null {
  const elems = n.kids.filter((k): k is SNode => typeof k !== 'string');
  const fixed = n.kids.reduce((s, k) => s + (typeof k === 'string' ? k.length : 0), 0);
  const weight = (k: SNode) => shareWeight(k);
  const totalW = elems.reduce((s, k) => s + weight(k), 0) || 1;
  // Pushed in place: rebuilding the array per child was quadratic, seconds on a 50,000-item list.
  const groups = new Map<string, SNode[]>();
  for (const k of elems) {
    const g = groups.get(k.sig);
    if (g) g.push(k);
    else groups.set(k.sig, [k]);
  }

  // `scale` shrinks each run's share of the budget. The share is computed on whole sizes and
  // leaves no room for the fold marker or the other children's placeholders, so a run that
  // exactly fills its share does not fit; rather than dropping straight to one example (the tight
  // attempt), try smaller shares first.
  const attempt = (tight: boolean, scale = 1): (string | SNode)[] | null => {
    const dropped = new Set<SNode>();
    const markerAt = new Map<SNode, string>();
    for (const [sig, members] of groups) {
      if (members.length < (tight ? FOLD_KEEP : FOLD_MIN)) continue;
      let keep = tight ? 1 : FOLD_KEEP;
      if (!tight) {
        const share = (scale * (avail - fixed) * members.reduce((s, k) => s + weight(k), 0)) / totalW;
        let used = 0;
        let fit = 0;
        for (const m of members) {
          used += m.size;
          if (used > share) break;
          fit++;
        }
        keep = Math.max(FOLD_KEEP, fit);
      }
      // Folding one or two costs about what it saves, and hides them for nothing.
      if (members.length - keep < 3) continue;
      markerAt.set(members[keep]!, `<… ${members.length - keep} more ${sig}/>`);
      for (const m of members.slice(keep)) dropped.add(m);
    }
    const plan: (string | SNode)[] = [];
    let min = 0;
    for (const k of n.kids) {
      if (typeof k === 'string') {
        plan.push(k);
        min += k.length;
      } else if (markerAt.has(k)) {
        plan.push(markerAt.get(k)!);
        min += markerAt.get(k)!.length;
      } else if (!dropped.has(k)) {
        plan.push(k);
        min += minSize(k);
      }
    }
    return min <= avail ? plan : null;
  };
  for (const scale of [1, 0.8, 0.6, 0.4, 0.2, 0]) {
    const plan = attempt(false, scale);
    if (plan) return plan;
  }
  return attempt(true) ?? cutPlan(n, avail);
}

/**
 * The last resort for one element: its children in order, as many as fit (each at least as its
 * placeholder), then one marker counting the elements left out. Used when the children cannot all
 * be listed even as placeholders and folded, e.g. thousands of unlike siblings. Without it the
 * whole element collapsed to one placeholder, and opening it with get_page(selector) collapsed it
 * again, so its content could not be read at all.
 */
function cutPlan(n: SNode, avail: number): (string | SNode)[] | null {
  // Only for a long list of children. With a few, the element's placeholder names more than a
  // "cut: 1 more" would, and cutting them is how a page fills with cut markers.
  if (n.nodes < CUT_MIN_KIDS || n.kids.filter((k) => typeof k !== 'string').length < CUT_MIN_KIDS) return null;
  const marker = (rest: number) => `<… cut: ${rest} more elements/>`;
  const elemsAfter: number[] = new Array(n.kids.length + 1).fill(0);
  for (let i = n.kids.length - 1; i >= 0; i--) elemsAfter[i] = elemsAfter[i + 1]! + (typeof n.kids[i] === 'string' ? 0 : 1);
  const plan: (string | SNode)[] = [];
  let min = 0;
  let i = 0;
  for (; i < n.kids.length; i++) {
    const k = n.kids[i]!;
    const cost = typeof k === 'string' ? k.length : minSize(k);
    const tail = elemsAfter[i + 1] ? marker(elemsAfter[i + 1]!).length : 0;
    if (min + cost + tail > avail) break;
    plan.push(k);
    min += cost;
  }
  // Nothing kept: the element's own placeholder says more ("…N nodes, 50× div.row, …").
  if (!plan.some((k) => typeof k !== 'string')) return null;
  if (i < n.kids.length && elemsAfter[i]) {
    const m = marker(elemsAfter[i]!);
    if (min + m.length > avail) return null;
    plan.push(m);
  }
  return plan;
}

/** Render `n` in at most `budget` characters, which is never less than minSize(n). */
function renderBudget(n: SNode, budget: number, out: string[]): number {
  if (n.size <= budget) {
    renderFull(n, out);
    return n.size;
  }
  const ph = placeholder(n);
  const avail = budget - n.open.length - n.close.length;
  const plan = avail > 0 ? planKids(n, avail) : null;
  if (!plan) {
    out.push(ph);
    return ph.length;
  }
  const kids = plan.filter((k): k is SNode => typeof k !== 'string');
  let extra = avail - plan.reduce((s, k) => s + (typeof k === 'string' ? k.length : minSize(k)), 0);
  let remainingW = kids.reduce((s, k) => s + shareWeight(k), 0);
  const rendered = new Map<SNode, string[]>();
  for (const k of [...kids].sort((a, b) => a.size - b.size)) {
    const w = shareWeight(k);
    const share = remainingW > 0 ? (extra * w) / remainingW : 0;
    const buf: string[] = [];
    const used = renderBudget(k, Math.floor(minSize(k) + share), buf);
    extra -= used - minSize(k);
    remainingW -= w;
    rendered.set(k, buf);
  }
  let used = n.open.length + n.close.length;
  out.push(n.open);
  for (const k of plan) {
    if (typeof k === 'string') {
      out.push(k);
      used += k.length;
    } else {
      for (const s of rendered.get(k)!) {
        out.push(s);
        used += s.length;
      }
    }
  }
  out.push(n.close);
  return used;
}

/** The `>\s+` / `\s+<` squeeze every snapshot has always had. */
function squeeze(s: string): string {
  return s.replace(/\s+</g, '<').replace(/>\s+/g, '>');
}

/** Render a tree under `maxChars`. Pure: see the section comment above. */
export function renderTree(tree: SNode, maxChars: number): string {
  const out: string[] = [];
  if (tree.size <= maxChars) {
    renderFull(tree, out);
    return squeeze(out.join(''));
  }
  const note = `\n<!-- over ${maxChars} chars, so parts are collapsed: "…N nodes" is an unopened element and "<… N more x/>" repeats the one before; get_page with a selector opens one -->`;
  renderBudget(tree, maxChars - note.length, out);
  // The last resort, for a root whose children cannot all be listed even as placeholders (the
  // root came back as its own one-line placeholder): the old tail cut, so there is still a page.
  if (out.length === 1) {
    const full: string[] = [];
    renderFull(tree, full);
    return squeeze(full.join('').slice(0, maxChars)) + `\n<!-- truncated at ${maxChars} chars; ask for a narrower selector -->`;
  }
  return squeeze(out.join('')) + note;
}

export function snapshot(opts: SnapshotOptions = {}): string {
  const root = opts.root ?? document.body;
  if (!root) return '';
  const tree = buildTree(root, { maxDepth: opts.maxDepth, includeHidden: opts.includeHidden });
  return tree ? renderTree(tree, opts.maxChars ?? 20_000) : '';
}

// ---------------------------------------------------------------------------
// Selector durability
// ---------------------------------------------------------------------------
//
// A selector that works right now is not the same as one that will still work after the site's
// next deploy, and a saved mod has to survive that. The model cannot tell the two apart from the
// selector text alone — `.css-1x2y3z` looks as authoritative as `#main-nav` — so every selector we
// hand it is labelled, and the prompt tells it to spend its second read on the fragile ones.

export type Durability =
  | { kind: 'stable'; reason: 'id' | 'data-attr' | 'role+text' | 'named class' }
  | { kind: 'fragile'; reason: 'generated class' | 'positional' };

/**
 * True for class names a build tool invented, which change whenever the site is rebuilt.
 *
 * The families, in order: css-in-js hashes (emotion `css-1a2b3c`, styled-components `sc-abc123`,
 * `jsx-123`, CSS-modules `_button_1a2b3`), long tokens mixing letters and digits, and any token
 * carrying three or more digits.
 */
export function isGeneratedClass(cls: string): boolean {
  if (!cls) return false;
  if (/^(css|sc|jsx|emotion|styles?)[-_][a-z0-9]{3,}$/i.test(cls)) return true;
  // CSS modules: `_button_1a2b3`, `styles_button__3kF9d` — a name with a hash suffix after _ or __.
  if (/^_?[A-Za-z][\w-]*?_{1,2}[A-Za-z0-9]{4,}$/.test(cls) && /\d/.test(cls)) return true;
  if (/\d{3,}/.test(cls)) return true;
  // A long token that mixes letters and digits and is not a readable word, e.g. `x1n2onr6`.
  if (cls.length >= 6 && /[a-z]/i.test(cls) && /\d/.test(cls) && !/[-_]/.test(cls) && /[a-z]\d|\d[a-z]/i.test(cls)) return true;
  return false;
}

/** Classify a selector this module (or the picker) produced. */
export function durabilityOf(selector: string): Durability {
  if (/^#[^\s>]+$/.test(selector)) return { kind: 'stable', reason: 'id' };
  if (/\[(data-|aria-label)/.test(selector)) return { kind: 'stable', reason: 'data-attr' };
  if (/\[role=/.test(selector)) return { kind: 'stable', reason: 'role+text' };
  const classes = [...selector.matchAll(/\.([\w-]+)/g)].map((m) => m[1]!);
  if (classes.some(isGeneratedClass)) return { kind: 'fragile', reason: 'generated class' };
  if (/:nth-of-type\(|:nth-child\(/.test(selector)) return { kind: 'fragile', reason: 'positional' };
  if (/#[\w-]+/.test(selector)) return { kind: 'stable', reason: 'id' };
  if (classes.length) return { kind: 'stable', reason: 'named class' };
  // A bare tag chain (`div > p`) matches by position in the tree even without an :nth selector.
  return { kind: 'fragile', reason: 'positional' };
}

/** The label appended to a selector in tool output, e.g. `[fragile: generated class]`. */
export function durabilityLabel(selector: string): string {
  const d = durabilityOf(selector);
  return `[${d.kind}: ${d.reason}]`;
}

/** A stable-ish CSS selector for an element. */
export function selectorFor(el: Element): string {
  if (el.id && !/\d{4,}/.test(el.id)) return `#${CSS.escape(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.body && parts.length < 6) {
    let part = cur.tagName.toLowerCase();
    if (cur.id && !/\d{4,}/.test(cur.id)) {
      parts.unshift(`#${CSS.escape(cur.id)}`);
      break;
    }
    const cls = [...cur.classList].filter((c) => !/\d{3,}|^(js-|is-|has-)/.test(c)).slice(0, 2);
    if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
    const parent: Element | null = cur.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.tagName === cur!.tagName);
      if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
    }
    parts.unshift(part);
    cur = parent;
  }
  return parts.join(' > ');
}

/**
 * How to reach a match from a script: the document for an ordinary element, and a
 * `.shadowRoot.querySelector` chain for one inside open shadow roots, since a selector alone cannot
 * cross into them.
 */
export function reachFor(m: DeepMatch, selector: string): string {
  if (!m.hosts.length) return `document.querySelector(${JSON.stringify(selector)})`;
  return 'document' + m.hosts.map((h) => `.querySelector(${JSON.stringify(selectorFor(h))}).shadowRoot`).join('') + `.querySelector(${JSON.stringify(selector)})`;
}
