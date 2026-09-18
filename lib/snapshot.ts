// DOM serialization for the model. Runs inside the content script.
// Produces a compact, pruned HTML-like view with a hard character budget.

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'PATH', 'DEFS', 'CLIPPATH',
  'LINEARGRADIENT', 'RADIALGRADIENT', 'FILTER', 'MASK', 'SYMBOL', 'USE',
]);
const KEEP_ATTRS = [
  'id', 'class', 'href', 'src', 'alt', 'title', 'role', 'name', 'type', 'placeholder', 'value',
  'aria-label', 'aria-expanded', 'aria-hidden', 'data-testid', 'for', 'action', 'method', 'target', 'disabled', 'checked', 'selected',
];
const MAX_ATTR = 120;
const MAX_TEXT = 200;

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return true;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true } as CheckVisibilityOptions);
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden';
}

function trunc(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

export interface SnapshotOptions {
  root?: Element | null;
  maxChars?: number;
  maxDepth?: number;
  includeHidden?: boolean;
}

export function snapshot(opts: SnapshotOptions = {}): string {
  const root = opts.root ?? document.body;
  const maxChars = opts.maxChars ?? 20_000;
  const maxDepth = opts.maxDepth ?? 40;
  if (!root) return '';
  const out: string[] = [];
  let used = 0;
  let truncated = false;

  const push = (s: string) => {
    if (truncated) return;
    if (used + s.length > maxChars) {
      truncated = true;
      return;
    }
    out.push(s);
    used += s.length;
  };

  const walk = (node: Node, depth: number) => {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      const t = trunc(node.textContent ?? '', MAX_TEXT);
      if (t) push(t + ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!opts.includeHidden && !isVisible(el)) return;
    if (depth > maxDepth) {
      push('<…/>');
      return;
    }
    const tag = el.tagName.toLowerCase();
    const attrs: string[] = [];
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v != null && v !== '') attrs.push(`${a}="${trunc(v, MAX_ATTR).replace(/"/g, '&quot;')}"`);
    }
    if (tag === 'svg') {
      push(`<svg${attrs.length ? ' ' + attrs.join(' ') : ''}/>`);
      return;
    }
    push(`<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
    const kids = el.shadowRoot ? [...el.shadowRoot.childNodes, ...el.childNodes] : [...el.childNodes];
    if (el.shadowRoot) push('<#shadow-root>');
    for (const k of kids) walk(k, depth + 1);
    if (el.shadowRoot) push('</#shadow-root>');
    push(`</${tag}>`);
  };

  walk(root, 0);
  let s = out.join('').replace(/\s+</g, '<').replace(/>\s+/g, '>');
  if (truncated) s += `\n<!-- truncated at ${maxChars} chars; ask for a narrower selector -->`;
  return s;
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

export function describeElements(selector: string, limit = 20): string {
  let els: Element[];
  try {
    els = [...document.querySelectorAll(selector)];
  } catch (e) {
    return `Invalid selector: ${String(e)}`;
  }
  if (!els.length) return `No elements match "${selector}".`;
  const lines = els.slice(0, limit).map((el, i) => {
    const r = el.getBoundingClientRect();
    const sel = selectorFor(el);
    return `${i + 1}. ${sel} ${durabilityLabel(sel)} [${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}] ${isVisible(el) ? '' : '(hidden) '}${trunc(el.textContent ?? '', 120)}`;
  });
  return [
    `${els.length} element(s) match "${selector}"${els.length > limit ? `, showing ${limit}` : ''}:`,
    ...lines,
    '',
    'The bracketed label is how durable each selector is across site deploys. A [fragile: …] one is worth a second look; a [stable: …] one is not.',
  ].join('\n');
}

export function computedStyles(selector: string, properties?: string[]): string {
  const el = document.querySelector(selector);
  if (!el) return `No element matches "${selector}".`;
  const cs = getComputedStyle(el);
  const props = properties?.length
    ? properties
    : ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'font-family', 'z-index', 'overflow', 'visibility', 'opacity'];
  return props.map((p) => `${p}: ${cs.getPropertyValue(p)}`).join('\n');
}
