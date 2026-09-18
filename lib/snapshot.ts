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
    return `${i + 1}. ${selectorFor(el)} [${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}] ${isVisible(el) ? '' : '(hidden) '}${trunc(el.textContent ?? '', 120)}`;
  });
  return `${els.length} element(s) match "${selector}"${els.length > limit ? `, showing ${limit}` : ''}:\n${lines.join('\n')}`;
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
