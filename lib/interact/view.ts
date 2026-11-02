// The inventory of what can be operated: one more of find_elements' lists, in the line shape of
// Playwright MCP's snapshot because models already read it.
//
//   - navigation "Pagination"
//     - link "Next page" [ref=k3e14] → /orders?page=2
//   - textbox "Search orders" [ref=k3e9] value=(empty)
//   … 38 more below the fold: narrow the scope, or scroll
//
// Viewport first, so a page's first screen is what a small budget buys. A field's value is never
// printed, whatever its type: this goes to a third-party model and lib/snapshot.ts's valueIsSafe
// holds for the same reason. It says whether the field holds anything, which is what a step needs.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { liveProbe, parentOf, type Probe } from '../inspect.ts';
import { trunc } from '../snapshot.ts';
import { formatRoleName, isEditable, LANDMARK_ROLES, nameOf, roleOf, stateOf } from './name.ts';
import { operableElements } from './target.ts';

/** About 6,000 characters by default, as get_page's read is sized in characters too. */
export const INVENTORY_MAX_CHARS = 6000;

const MAX_URL = 100;

/** What nests a line: landmarks, and a table row, which is how a row's buttons are told apart. */
const nests = (role: string) => LANDMARK_ROLES.has(role) || role === 'row';

function currentValue(el: Element): string {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const select = el as HTMLSelectElement;
    const picked = select.selectedOptions?.[0] ?? el.querySelector('option[selected]') ?? el.querySelector('option');
    return picked ? ` value=${JSON.stringify(trunc(picked.textContent ?? '', 40))}` : '';
  }
  if (tag === 'textarea' || (tag === 'input' && roleOf(el) === 'textbox') || (tag === 'input' && (roleOf(el) === 'searchbox' || roleOf(el) === 'spinbutton'))) {
    return (el as HTMLInputElement).value ? ' value=(filled)' : ' value=(empty)';
  }
  if (isEditable(el)) return (el.textContent ?? '').trim() ? ' value=(filled)' : ' value=(empty)';
  return '';
}

function urlOf(el: Element, here: URL | null): string {
  const href = el.getAttribute('href') ?? (el.tagName === 'IMG' ? el.getAttribute('src') : null);
  if (!href) return '';
  let shown = href;
  try {
    const url = new URL(href, here?.href ?? el.baseURI);
    shown = here && url.origin === here.origin ? url.pathname + url.search + url.hash : url.href;
  } catch {
    /* an address the browser would not parse either is shown as written */
  }
  return ` → ${trunc(shown, MAX_URL)}`;
}

function line(el: Element, refOf: (el: Element) => string, here: URL | null): string {
  const state = stateOf(el);
  return `${formatRoleName(roleOf(el), nameOf(el))} [ref=${refOf(el)}]${state.length ? ` ${state.map((s) => `[${s}]`).join(' ')}` : ''}${currentValue(el)}${urlOf(el, here)}`;
}

/** The elements that nest this one, outermost first, stopping at `scope`. */
function pathOf(el: Element, scope: Element | undefined): Element[] {
  const out: Element[] = [];
  let cur = parentOf(el).el;
  while (cur && cur !== scope) {
    if (nests(roleOf(cur))) out.unshift(cur);
    cur = parentOf(cur).el;
  }
  return out;
}

export interface InventoryOptions {
  /** Only what is inside this element. */
  scope?: Element;
  refOf: (el: Element) => string;
  maxChars?: number;
  probe?: Probe;
  doc?: Document;
  /** The page's address, which a same-site link's path is shown relative to. */
  pageUrl?: string;
}

/** The inventory as text. See the file comment. */
export function operableInventory(opts: InventoryOptions): string {
  const probe = opts.probe ?? liveProbe;
  const maxChars = opts.maxChars ?? INVENTORY_MAX_CHARS;
  const { found, cut } = operableElements(probe, opts.scope, opts.doc ?? document);
  const vp = probe.viewport();
  const inView = (el: Element) => {
    const b = probe.box(el);
    return b.y + b.h > 0 && b.y < vp.h && b.x + b.w > 0 && b.x < vp.w;
  };
  let here: URL | null = null;
  try {
    here = new URL(opts.pageUrl ?? (opts.doc ?? document).URL);
  } catch {
    /* no address to shorten against: links print whole */
  }

  const ranked = found.map((el, i) => ({ el, i, view: inView(el) })).sort((a, b) => Number(b.view) - Number(a.view) || a.i - b.i);
  const kept = new Set<number>();
  const rendered = new Map<number, { text: string; path: Element[] }>();
  // Each element's ancestors are charged in full here; a shared one prints once, so this stops
  // somewhat early rather than late, which is the direction that keeps the budget true.
  let used = 0;
  for (const r of ranked) {
    const text = line(r.el, opts.refOf, here);
    const path = pathOf(r.el, opts.scope);
    const cost = text.length + 3 + path.length * 2;
    if (used + cost > maxChars && kept.size) continue;
    used += cost;
    kept.add(r.i);
    rendered.set(r.i, { text, path });
  }

  const out: string[] = [];
  let open: Element[] = [];
  found.forEach((_, i) => {
    const entry = rendered.get(i);
    if (!entry) return;
    let shared = 0;
    while (shared < open.length && shared < entry.path.length && open[shared] === entry.path[shared]) shared++;
    for (let d = shared; d < entry.path.length; d++) {
      const p = entry.path[d]!;
      out.push(`${'  '.repeat(d)}- ${formatRoleName(roleOf(p), nameOf(p))}`);
    }
    open = entry.path;
    out.push(`${'  '.repeat(entry.path.length)}- ${entry.text}`);
  });

  const left = found.length - kept.size;
  if (!found.length) out.push('Nothing to operate here.');
  if (left) {
    const below = found.some((el, i) => !kept.has(i) && !inView(el));
    out.push(`… ${left} more${below ? ' below the fold' : ''}: narrow the scope, or scroll`);
  }
  if (cut) out.push('… stopped walking a very long page: narrow the scope');
  return out.join('\n');
}
