// What changed across a step, for the model and for a touched row. An action returns this rather than
// a snapshot: a budget can be as low as 8,000 tokens, and ten steps that each re-read the page do not
// fit. It counts what run_script's wrapper counts (lib/exec/wrap.ts __watchDom), in the same DomEffect
// shape, and says it with the same words, and adds the one thing a step's next step wants: what can
// now be operated that could not before.
//
// Names and counts only. An attribute's new value is never read, so a value set on a field stays
// out of what goes back to the model.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { formatDomEffect, type DomEffect } from '../domeffect.ts';
import { liveProbe, type Probe } from '../inspect.ts';
import { formatRoleName, isOperable, nameOf, roleOf } from './name.ts';

/** Distinct names kept per kind, as the wrapper keeps. */
const MAX_NAMES = 20;

/** Distinct new controls named in a delta, most frequent first. */
const NEW_SHOWN = 5;

export interface Delta {
  dom: DomEffect;
  urlBefore: string;
  urlAfter: string;
  /** Controls that appeared, by role and name, with how many of each. */
  newOperable: Array<[string, number]>;
}

/** `tag`, then `#id` or up to two classes: the wrapper's short name, so the two read alike. */
export function nodeName(n: Node): string {
  if (n.nodeType !== 1) return n.nodeName.toLowerCase();
  const el = n as Element;
  const tag = el.tagName.toLowerCase();
  if (el.id) return `${tag}#${el.id.slice(0, 40)}`;
  const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
  return tag + classes.map((c) => `.${c.slice(0, 30)}`).join('');
}

/** Our own page UI comes and goes with every step and is not something the step did. */
const isOurs = (n: Node) => n.nodeType === 1 && (n as Element).hasAttribute('data-usermods');

/** Fold MutationRecords into a DomEffect. Pure: tests hand it records of their own. */
export function tallyRecords(records: Iterable<Pick<MutationRecord, 'type' | 'target' | 'attributeName' | 'addedNodes' | 'removedNodes'>>): DomEffect {
  const counts = { added: 0, removed: 0, attributes: 0 };
  const added = new Map<string, number>();
  const removed = new Map<string, number>();
  const attributes = new Map<string, { attrs: string[]; n: number }>();
  const bump = (m: Map<string, number>, n: Node) => {
    const k = nodeName(n);
    if (m.has(k) || m.size < MAX_NAMES) m.set(k, (m.get(k) ?? 0) + 1);
  };
  for (const r of records) {
    if (isOurs(r.target)) continue;
    if (r.type === 'attributes') {
      counts.attributes++;
      const k = nodeName(r.target);
      const e = attributes.get(k);
      if (e) {
        e.n++;
        if (r.attributeName && e.attrs.length < 4 && !e.attrs.includes(r.attributeName)) e.attrs.push(r.attributeName);
      } else if (attributes.size < MAX_NAMES) {
        attributes.set(k, { attrs: r.attributeName ? [r.attributeName] : [], n: 1 });
      }
      continue;
    }
    if (r.type !== 'childList') continue;
    for (const n of r.addedNodes) {
      if (isOurs(n)) continue;
      counts.added++;
      bump(added, n);
    }
    for (const n of r.removedNodes) {
      if (isOurs(n)) continue;
      counts.removed++;
      bump(removed, n);
    }
  }
  const dom: DomEffect = { ...counts };
  if (counts.added || counts.removed || counts.attributes) {
    dom.targets = {
      added: [...added],
      removed: [...removed],
      attributes: [...attributes].map(([k, e]) => [k, e.attrs, e.n]),
    };
  }
  return dom;
}

/** The controls among nodes that appeared, by role and name. A node gone again by now is not new. */
export function newOperableAmong(nodes: Iterable<Node>, probe: Probe = liveProbe): Array<[string, number]> {
  const tally = new Map<string, number>();
  const seen = new Set<Element>();
  const consider = (el: Element) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (!isOperable(el, probe) || !probe.visible(el)) return;
    const label = formatRoleName(roleOf(el), nameOf(el));
    if (tally.has(label) || tally.size < MAX_NAMES) tally.set(label, (tally.get(label) ?? 0) + 1);
  };
  for (const n of nodes) {
    if (n.nodeType !== 1 || isOurs(n) || !(n as Element).isConnected) continue;
    const el = n as Element;
    consider(el);
    for (const k of [...el.querySelectorAll('*')]) consider(k);
  }
  return [...tally].sort((a, b) => b[1] - a[1]);
}

/**
 * The lines an action's result ends with:
 *   DOM: 0 removed, 120 added (div.reply ×120), 0 attributes changed. URL unchanged.
 *   New: link "permalink" ×120, button "Reply" ×120. find_elements to get refs.
 */
export function renderDelta(d: Delta): string {
  const dom = formatDomEffect(d.dom);
  const url = d.urlAfter === d.urlBefore ? 'URL unchanged.' : `URL is now ${d.urlAfter}.`;
  const lines = [`DOM: ${dom ?? 'nothing changed'}. ${url}`];
  if (d.newOperable.length) {
    const shown = d.newOperable.slice(0, NEW_SHOWN).map(([label, n]) => (n > 1 ? `${label} ×${n}` : label));
    const rest = d.newOperable.length - shown.length;
    lines.push(`New: ${shown.join(', ')}${rest > 0 ? `, +${rest} more` : ''}. find_elements to get refs.`);
  }
  return lines.join('\n');
}

export interface DeltaWatch {
  finish(): Delta;
}

/** Start counting. `finish` flushes the observer and stops it; nothing is left on the page. */
export function watchDelta(opts: { doc?: Document; probe?: Probe; url?: () => string } = {}): DeltaWatch {
  const doc = opts.doc ?? document;
  const url = opts.url ?? (() => (typeof location !== 'undefined' ? location.href : doc.URL));
  const urlBefore = url();
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((rs) => {
    records.push(...rs);
  });
  observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true });
  return {
    finish() {
      records.push(...observer.takeRecords());
      observer.disconnect();
      const addedNodes = records.filter((r) => r.type === 'childList').flatMap((r) => [...r.addedNodes]);
      return { dom: tallyRecords(records), urlBefore, urlAfter: url(), newOperable: newOperableAmong(addedNodes, opts.probe ?? liveProbe) };
    },
  };
}
