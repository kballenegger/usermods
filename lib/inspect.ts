// find_elements and get_styles: the cheap lookups, answered from the live page. Runs inside the
// content script. get_page's serializer and the selector helpers live in lib/snapshot.ts.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { durabilityLabel, isVisible, reachFor, selectorFor, trunc } from './snapshot.ts';
import { deepestOnly, elementsWithText, hasText, queryAllDeep, type DeepMatch } from './waitdom.ts';

/** The note for a selector that matched nothing anywhere, naming the shadow roots it also tried. */
function missNote(searchedRoots: number): string {
  return searchedRoots ? ` Also searched ${searchedRoots} open shadow root(s); closed shadow roots cannot be searched.` : '';
}

/**
 * find_elements: by selector, by visible text, or both.
 *
 * With `text`, the answer is the deepest elements containing it (see elementsWithText), so asking
 * for "the shelf that says Recommended for you" costs one short list rather than a full get_page.
 * A selector that matches nothing in the document is retried inside open shadow roots, and those
 * matches say how to reach them.
 */
export function describeElements(selector: string | undefined, limit = 20, text?: string): string {
  const sel = selector?.trim() || undefined;
  const needle = text?.trim() || undefined;
  if (!sel && !needle) return 'Give a selector, a text, or both.';
  let found: DeepMatch[];
  let searchedRoots = 0;
  if (sel) {
    try {
      ({ matches: found, searchedRoots } = queryAllDeep(sel));
    } catch (e) {
      return `Invalid selector: ${String(e)}`;
    }
    if (!found.length) return `No elements match "${sel}".${missNote(searchedRoots)}`;
    if (needle) {
      const all = found.length;
      found = deepestOnly(found.filter((m) => hasText(m.el, needle)));
      if (!found.length) return `${all} element(s) match "${sel}", but none contain "${needle}".`;
    }
  } else {
    found = document.body ? elementsWithText(document.body, needle!) : [];
    if (!found.length) return `No element's text contains "${needle}".`;
  }
  const what = sel && needle ? `match "${sel}" and contain "${needle}"` : sel ? `match "${sel}"` : `contain "${needle}"`;
  const lines = found.slice(0, limit).map((m, i) => {
    const el = m.el;
    const r = el.getBoundingClientRect();
    const s = selectorFor(el);
    return `${i + 1}. ${s} ${durabilityLabel(s)} [${Math.round(r.width)}x${Math.round(r.height)} @${Math.round(r.x)},${Math.round(r.y)}] ${m.hosts.length ? '(in shadow root) ' : ''}${isVisible(el) ? '' : '(hidden) '}${trunc((el as HTMLElement).innerText ?? el.textContent ?? '', 120)}`;
  });
  const shadowed = found.slice(0, limit).find((m) => m.hosts.length);
  return [
    `${found.length} element(s) ${what}${found.length > limit ? `, showing ${limit}` : ''}:`,
    ...lines,
    '',
    'The bracketed label is how durable each selector is across site deploys. A [fragile: …] one is worth a second look; a [stable: …] one is not.',
    ...(shadowed
      ? [`"(in shadow root)" ones are inside an open shadow root, where document.querySelector and page CSS do not reach. The selector is relative to that root: ${reachFor(shadowed, sel ?? selectorFor(shadowed.el))}`]
      : []),
  ].join('\n');
}

export function computedStyles(selector: string, properties?: string[]): string {
  let found: DeepMatch[];
  let searchedRoots: number;
  try {
    ({ matches: found, searchedRoots } = queryAllDeep(selector));
  } catch (e) {
    return `Invalid selector: ${String(e)}`;
  }
  const m = found[0];
  if (!m) return `No element matches "${selector}".${missNote(searchedRoots)}`;
  const cs = getComputedStyle(m.el);
  const props = properties?.length
    ? properties
    : ['display', 'position', 'width', 'height', 'margin', 'padding', 'color', 'background-color', 'font-size', 'font-family', 'z-index', 'overflow', 'visibility', 'opacity'];
  const lines = props.map((p) => `${p}: ${cs.getPropertyValue(p)}`);
  if (m.hosts.length) lines.unshift(`(inside an open shadow root: ${reachFor(m, selector)})`);
  return lines.join('\n');
}
