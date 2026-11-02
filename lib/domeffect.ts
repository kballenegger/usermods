// What the DOM did across a step, and how that reads. A run_script run counts it in the page
// (lib/exec/wrap.ts); an act step counts it in the content script (lib/interact/delta.ts). Apart
// from lib/runscript.ts because that file holds acorn, which has no business in a content script.

/** What the DOM did while the script ran, as counted by the wrapper's MutationObserver. */
export interface DomEffect {
  added: number;
  removed: number;
  attributes: number;
  /**
   * Which nodes, by name (lib/exec/wrap.ts `__name`: tag, then #id or up to two classes), with how
   * many of each. Attribute entries also carry the attribute names. At most 20 names per kind are
   * tallied in the page; nodes past that are still in the counts above.
   */
  targets?: {
    added: Array<[string, number]>;
    removed: Array<[string, number]>;
    attributes: Array<[string, string[], number]>;
  };
}

/** Names shown per kind in the DOM summary. Five, collapsed by name, is about 40 tokens at most. */
const DOM_NAMES_SHOWN = 5;

/**
 * ` (div.modal-backdrop, li ×12, +3 more)`, or '' when there is nothing to name. Most frequent
 * first; "+N more" counts the changes not covered by the names shown, so it stays true even when
 * the page tallied only the first 20 names.
 */
function namedTargets(entries: Array<[string, number]> | undefined, total: number, label: (e: [string, number], i: number) => string): string {
  if (!entries?.length || !total) return '';
  const sorted = entries.map((e, i) => ({ e, i })).sort((a, b) => b.e[1] - a.e[1] || a.i - b.i);
  const shown = sorted.slice(0, DOM_NAMES_SHOWN);
  const covered = shown.reduce((n, { e }) => n + e[1], 0);
  const parts = shown.map(({ e, i }) => label(e, i));
  if (total > covered) parts.push(`+${total - covered} more`);
  return ` (${parts.join(', ')})`;
}

/**
 * `2 removed (div.modal-backdrop, div#newsletter), 1 added (div.modal), 2 attributes changed
 * (body[class,style])`, or null when nothing moved.
 *
 * The names are what let the model see a site put back what its script removed: the same name under
 * "removed" and "added" in one run. Repeated names collapse into `name ×N`; attribute entries list
 * the attributes instead, since an element restyled sixty times is one fact, not sixty.
 */
export function formatDomEffect(dom: DomEffect | undefined): string | null {
  if (!dom) return null;
  if (!dom.added && !dom.removed && !dom.attributes) return null;
  const t = dom.targets;
  const nodes = (e: [string, number]) => (e[1] > 1 ? `${e[0]} ×${e[1]}` : e[0]);
  const attrs = t?.attributes ?? [];
  const removed = namedTargets(t?.removed, dom.removed, nodes);
  const added = namedTargets(t?.added, dom.added, nodes);
  const changed = namedTargets(
    attrs.map(([name, , n]) => [name, n]),
    dom.attributes,
    ([name], i) => (attrs[i]![1].length ? `${name}[${attrs[i]![1].join(',')}]` : name),
  );
  return `${dom.removed} removed${removed}, ${dom.added} added${added}, ${dom.attributes} attribute${dom.attributes === 1 ? '' : 's'} changed${changed}`;
}
