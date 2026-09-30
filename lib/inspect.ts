// find_elements and get_styles: the cheap lookups, answered from the live page. Runs inside the
// content script. get_page's serializer and the selector helpers live in lib/snapshot.ts.
//
// Why these answer more than "where is it": the owner's exported chats (14 chats, 184 tool calls)
// had models write 55 run_script calls that changed nothing, about 1,200 characters each, to ask
// the same three questions again and again: which ancestor of this text is the card or popup worth
// hiding, what does the page's furniture look like (overlays, dialogs, fixed and sticky bars,
// scroll locks), and what are the display / position / size of these few elements. find_elements
// was called 4 times in the same chats. So find_elements now answers all three in one call:
//   - every match carries its layout essentials, and any computed properties asked for (`styles`);
//   - the first CHAIN_MATCHES matches carry a compact ancestor chain with the likely unit to hide;
//   - `overlays` lists the page's layers and scroll locks instead of matching anything.
//
// Everything that needs layout goes through a Probe, so node tests can drive the same code on a
// parsed page by reading boxes and styles from attributes (see test/inspect.test.ts).

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { durabilityLabel, isGeneratedClass, isVisible, reachFor, selectorFor, trunc } from './snapshot.ts';
import { deepestOnly, elementsWithText, hasText, queryAllDeep, type DeepMatch } from './waitdom.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What these reads need from a laid-out page. The live one is liveProbe; tests inject their own. */
export interface Probe {
  box(el: Element): Box;
  /** A reader of el's computed style: property name in, computed value out ('' when unknown). */
  style(el: Element): (prop: string) => string;
  visible(el: Element): boolean;
  viewport(): { w: number; h: number; scrollY: number; pageH: number };
}

export const liveProbe: Probe = {
  box(el) {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  },
  style(el) {
    // Guarded because node tests call describeElements on a parsed page with no getComputedStyle.
    if (typeof getComputedStyle !== 'function') return () => '';
    const cs = getComputedStyle(el);
    return (p) => cs.getPropertyValue(p);
  },
  visible: isVisible,
  viewport: () => ({
    w: window.innerWidth,
    h: window.innerHeight,
    scrollY: Math.round(window.scrollY),
    pageH: Math.round(document.documentElement.scrollHeight),
  }),
};

/** The note for a selector that matched nothing anywhere, naming the shadow roots it also tried. */
function missNote(searchedRoots: number): string {
  return searchedRoots ? ` Also searched ${searchedRoots} open shadow root(s); closed shadow roots cannot be searched.` : '';
}

const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, (c) => `\\${c}`));
const attrValue = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
const size = (b: Box) => `${Math.round(b.w)}x${Math.round(b.h)}`;
const area = (b: Box) => Math.max(0, b.w) * Math.max(0, b.h);

/**
 * An element as a short, copyable CSS selector: tag, #id, one class (a readable one if any),
 * then role, aria-label and data-testid when present. Not unique; it says what the element IS, which
 * is what a chain of ancestors or a list of layers needs, and a model can paste it into a rule.
 */
export function describeNode(el: Element): string {
  let out = el.tagName.toLowerCase();
  if (el.id && !/\d{4,}/.test(el.id)) out += `#${esc(el.id)}`;
  const classes = (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean);
  const readable = classes.filter((c) => !isGeneratedClass(c));
  // A generated class still beats nothing: `[class*=…]` on its readable prefix is a real hook.
  // One class: a second rarely narrows what the element is, and chains print several of these.
  const cls = readable[0] ?? classes[0];
  if (cls) out += `.${esc(cls)}`;
  const role = el.getAttribute('role');
  if (role) out += `[role="${attrValue(role)}"]`;
  const label = el.getAttribute('aria-label')?.trim();
  // A long label as a prefix match, so the selector stays short and still valid.
  if (label) out += label.length > 40 ? `[aria-label^="${attrValue(label.slice(0, 30))}"]` : `[aria-label="${attrValue(label)}"]`;
  if (el.getAttribute('aria-modal') === 'true') out += '[aria-modal="true"]';
  const testid = el.getAttribute('data-testid');
  if (testid && testid.length <= 40) out += `[data-testid="${attrValue(testid)}"]`;
  return out;
}

/** A dialog in any of the ways a page says so. */
export function isDialog(el: Element): boolean {
  const role = el.getAttribute('role');
  return el.tagName === 'DIALOG' || role === 'dialog' || role === 'alertdialog' || el.getAttribute('aria-modal') === 'true';
}

/**
 * The layout facts a mod author asks about, non-defaults only so a plain element costs one word:
 * display always, then visibility, opacity, position and z-index when they are not the default.
 */
export function layoutFacts(style: (p: string) => string): string {
  const out: string[] = [];
  const display = style('display');
  if (display) out.push(`display:${display}`);
  const vis = style('visibility');
  if (vis && vis !== 'visible') out.push(`visibility:${vis}`);
  const opacity = style('opacity');
  if (opacity && opacity !== '1') out.push(`opacity:${opacity}`);
  const pos = style('position');
  if (pos && pos !== 'static') out.push(`position:${pos}`);
  const z = style('z-index');
  if (z && z !== 'auto') out.push(`z-index:${z}`);
  return out.join(' ');
}

/** The parent, crossing out of an open shadow root to its host. */
function parentOf(el: Element): { el: Element | null; viaHost: boolean } {
  if (el.parentElement) return { el: el.parentElement, viaHost: false };
  const root = el.getRootNode?.() as (Node & { host?: Element }) | undefined;
  return root?.host ? { el: root.host, viaHost: true } : { el: null, viaHost: false };
}

/** What makes siblings "alike" for the unit guess: tag plus first class, as the snapshot's folds. */
function sig(el: Element): string {
  const cls = (el.getAttribute('class') ?? '').trim().split(/\s+/)[0];
  return cls ? `${el.tagName}.${cls}` : el.tagName;
}

/**
 * Why an ancestor looks like the natural unit to hide, or null. Checked nearest first, so the answer
 * is the SMALLEST such ancestor:
 *   - a dialog, or a fixed or sticky layer: the popup's shell, whatever its inner structure;
 *   - a box (not display:inline), one of at least UNIT_MIN_ALIKE similar siblings (same tag and
 *     first class), and at least UNIT_MIN_GROWTH times the match's area: a card in a feed, a row in
 *     a list, a section in a sidebar. The display test keeps a label's inline siblings (the spans of
 *     a byline) from winning; a pure size ratio could not, because a card holding little more than
 *     its heading (a 1264x59 card around a 1264x22 h3) is only 2.7 times its area.
 * A guess from layout, and the output says so; it is right for the shapes the real scripts were
 * hunting (an ad card, a subscribe popup, a sidebar section) and cheap: no text is read.
 */
export const UNIT_MIN_ALIKE = 3;
export const UNIT_MIN_GROWTH = 2;
function unitReason(el: Element, box: Box, style: (p: string) => string, matchBox: Box): string | null {
  const pos = style('position');
  if (isDialog(el)) return 'dialog';
  if (pos === 'fixed' || pos === 'sticky') return `${pos} layer`;
  const parent = el.parentElement;
  if (!parent) return null;
  const display = style('display');
  if (display.startsWith('inline') || display === 'contents') return null;
  const big = area(matchBox) > 0 ? area(box) >= UNIT_MIN_GROWTH * area(matchBox) : area(box) > 0;
  if (!big) return null;
  const mine = sig(el);
  let alike = 0;
  for (const k of parent.children) if (sig(k) === mine) alike++;
  return alike >= UNIT_MIN_ALIKE ? `1 of ${alike} like it` : null;
}

/**
 * How many ancestors a chain prints, and how far it may walk to find them. A chain also stops one
 * step after the unit: the unit's parent says what it repeats in, and above that is page layout
 * (the content column, the page container) that costs characters and answers nothing.
 */
export const CHAIN_STEPS = 6;
const CHAIN_WALK = 40;

/**
 * One match's ancestors, nearest first, as one line: `div.meta 300x20 › article.post 600x480 [unit?
 * 1 of 12 like it] › main 1200x6000`. Stops at body. Wrappers with the same box as the last printed
 * step are counted, not printed ("2 same-size"), because a React page nests a dozen of them and they
 * say nothing. A step already printed for an earlier match ends the chain with "(then as in 2.)",
 * so twenty cards in one list cost one chain, not twenty. `seen` carries that across matches.
 */
export function ancestorChain(el: Element, matchBox: Box, probe: Probe, seen: Map<Element, number>, index: number): string {
  const steps: string[] = [];
  let last = matchBox;
  let skipped = 0;
  let unitFound = false;
  let sinceUnit = 0;
  let cur = parentOf(el);
  for (let walked = 0; cur.el && walked < CHAIN_WALK; walked++) {
    const a = cur.el;
    if (a.tagName === 'BODY' || a.tagName === 'HTML') break;
    const earlier = seen.get(a);
    if (earlier !== undefined) {
      if (skipped) steps.push(`(${skipped} same-size)`);
      steps.push(`(then as in ${earlier}.)`);
      return steps.join(' › ');
    }
    seen.set(a, index);
    const s = probe.style(a);
    const pos = s('position');
    const box = probe.box(a);
    const unit = unitFound ? null : unitReason(a, box, s, matchBox);
    const layered = pos === 'fixed' || pos === 'sticky';
    const sameBox = Math.round(box.w) === Math.round(last.w) && Math.round(box.h) === Math.round(last.h);
    if (sameBox && !unit && !layered) {
      skipped++;
    } else {
      if (steps.length >= CHAIN_STEPS || (unitFound && sinceUnit >= 1)) {
        // The cut is said, never silent: the model can ask again from the last step it saw.
        steps.push('…');
        return steps.join(' › ');
      }
      if (skipped) steps.push(`(${skipped} same-size)`);
      skipped = 0;
      const display = s('display') === 'contents' ? ' display:contents' : '';
      const layer = layered ? ` ${pos}${s('z-index') && s('z-index') !== 'auto' ? ` z-index:${s('z-index')}` : ''}` : '';
      steps.push(`${describeNode(a)}${cur.viaHost ? ' (shadow host)' : ''} ${size(box)}${display}${layer}${unit ? ` [unit? ${unit}]` : ''}`);
      if (unitFound) sinceUnit++;
      if (unit) unitFound = true;
      last = box;
    }
    cur = parentOf(a);
  }
  if (skipped) steps.push(`(${skipped} same-size)`);
  return steps.join(' › ');
}

/**
 * How many matches carry an ancestor chain. Measured in Chromium on Wikipedia, GitHub and a modal
 * fixture: one chain line is 85-390 characters, and a single-match find grew by 270-370 characters
 * in all (chain, layout and the one-line legend), about 90 tokens. The question "which container?"
 * is asked about the first match or two, which is what a text search returns; twenty chains for
 * twenty list items would say the same thing twenty times. Three, with a shared tail cut to
 * "(then as in 1.)", show whether the matches share a unit: the second and third cost 60-150
 * characters each on those pages. No flag to ask for more: every schema field is sent on every
 * request, and a model that wants the chain of match 7 can search for it directly.
 */
export const CHAIN_MATCHES = 3;

/** Longest computed value printed for a property asked for by name. */
const MAX_STYLE_VALUE = 80;

export interface FindOptions {
  /** Computed CSS properties to print for every listed match. */
  styles?: string[];
  /** List the page's layers and scroll locks (describeFurniture) ahead of any matches. */
  overlays?: boolean;
}

/**
 * find_elements: by selector, by visible text, or both, and/or the page's furniture.
 *
 * With `text`, the answer is the deepest elements containing it (see elementsWithText), so asking
 * for "the shelf that says Recommended for you" costs one short list rather than a full get_page.
 * A selector that matches nothing in the document is retried inside open shadow roots, and those
 * matches say how to reach them. See the file comment for what each match carries and why.
 */
export function describeElements(selector: string | undefined, limit = 20, text?: string, opts: FindOptions = {}, probe: Probe = liveProbe): string {
  const sel = selector?.trim() || undefined;
  const needle = text?.trim() || undefined;
  const furniture = opts.overlays ? describeFurniture(probe) : '';
  if (!sel && !needle) return furniture || 'Give a selector, a text, or both.';
  const matches = describeMatches(sel, needle, limit, opts.styles ?? [], probe);
  return furniture ? `${furniture}\n\n${matches}` : matches;
}

function describeMatches(sel: string | undefined, needle: string | undefined, limit: number, styles: string[], probe: Probe): string {
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
  const seen = new Map<Element, number>();
  let chains = 0;
  let units = 0;
  const lines = found.slice(0, limit).flatMap((m, i) => {
    const el = m.el;
    const r = probe.box(el);
    const s = selectorFor(el);
    const style = probe.style(el);
    const layout = layoutFacts(style);
    const out = [
      `${i + 1}. ${s} ${durabilityLabel(s)} [${size(r)} @${Math.round(r.x)},${Math.round(r.y)}]${layout ? ` ${layout}` : ''} ${m.hosts.length ? '(in shadow root) ' : ''}${probe.visible(el) ? '' : '(hidden) '}${trunc((el as HTMLElement).innerText ?? el.textContent ?? '', 120)}`,
    ];
    if (styles.length) out.push(`   ${styles.map((p) => `${p}: ${trunc(style(p), MAX_STYLE_VALUE) || '(none)'}`).join('; ')}`);
    if (i < CHAIN_MATCHES) {
      const chain = ancestorChain(el, r, probe, seen, i + 1);
      if (chain) {
        out.push(`   ancestors: ${chain}`);
        chains++;
        if (chain.includes('[unit? ')) units++;
      }
    }
    return out;
  });
  const shadowed = found.slice(0, limit).find((m) => m.hosts.length);
  return [
    `${found.length} element(s) ${what}${found.length > limit ? `, showing ${limit}` : ''}:`,
    ...lines,
    '',
    'The bracketed label is how durable each selector is across site deploys. A [fragile: …] one is worth a second look; a [stable: …] one is not.',
    // Said only when there is something to explain: the chain itself reads as "nearest first".
    ...(chains && found.length > CHAIN_MATCHES ? [`Ancestors are listed for the first ${CHAIN_MATCHES} matches only.`] : []),
    ...(units ? ['[unit? …] = likely thing to hide (a dialog, a fixed/sticky layer, or a much larger ancestor repeated among its siblings); a layout guess.'] : []),
    ...(shadowed
      ? [`"(in shadow root)" ones are inside an open shadow root, where document.querySelector and page CSS do not reach. The selector is relative to that root: ${reachFor(shadowed, sel ?? selectorFor(shadowed.el))}`]
      : []),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The page's furniture: find_elements with overlays
// ---------------------------------------------------------------------------
//
// "Find backdrop, fixed overlays, and other subscribe blocks", "Inventory ads, banners, popups":
// the same script every time, walking every element for position:fixed and reading html/body for a
// scroll lock. This is that script, run once, with the answer shaped for removing an overlay: what
// each layer is, how much of the screen it covers, which one is the dim backdrop, which are inside
// which, and what is keeping the page from scrolling.

const FURNITURE_SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'SVG', 'svg']);

/** How many layers are listed; the rest are counted, smallest first to go. */
export const FURNITURE_ROWS = 12;

/** A class on html or body that usually means "a modal has locked the page". */
const LOCK_CLASS = /(modal|dialog|popup|overlay).*(open|active|show|visible)|(open|active|show)[-_]?(modal|dialog|popup|overlay)|has-?(modal|dialog|overlay)|no-?scroll|scroll-?lock|overflow-?hidden|locked|frozen/i;

export interface Layer {
  el: Element;
  pos: string;
  z: string;
  box: Box;
  /** Share of the viewport covered, 0..1. */
  cover: number;
  dialog: boolean;
  text: string;
  /** Index into the layer list of the nearest layer containing this one, or -1. */
  inside: number;
}

/** Share of the viewport a box covers, 0..1. */
export function coverage(b: Box, vw: number, vh: number): number {
  if (vw <= 0 || vh <= 0) return 0;
  const w = Math.max(0, Math.min(b.x + b.w, vw) - Math.max(b.x, 0));
  const h = Math.max(0, Math.min(b.y + b.h, vh) - Math.max(b.y, 0));
  return (w * h) / (vw * vh);
}

/**
 * Which layers make the list when there are more than `rows`: dialogs first, then by how much of
 * the screen they cover, then back into page order so "(inside 3.)" reads naturally.
 */
export function pickLayers(layers: Layer[], rows = FURNITURE_ROWS): { shown: number[]; rest: number } {
  const order = layers.map((_, i) => i);
  if (layers.length <= rows) return { shown: order, rest: 0 };
  const ranked = [...order].sort((a, b) => Number(layers[b]!.dialog) - Number(layers[a]!.dialog) || layers[b]!.cover - layers[a]!.cover);
  return { shown: ranked.slice(0, rows).sort((a, b) => a - b), rest: layers.length - rows };
}

/** The furniture inventory, as text. Walks every rendered element once; see the section comment. */
export function describeFurniture(probe: Probe = liveProbe, rows = FURNITURE_ROWS): string {
  const vp = probe.viewport();
  const body = document.body;
  if (!body) return 'The page has no body.';
  const layers: Layer[] = [];
  let hidden = 0;
  // An explicit stack rather than recursion: some pages nest a few thousand deep.
  const stack: { el: Element; inside: number }[] = [...body.children].reverse().map((el) => ({ el, inside: -1 }));
  while (stack.length) {
    const { el, inside } = stack.pop()!;
    if (FURNITURE_SKIP.has(el.tagName) || el.hasAttribute('data-usermods')) continue;
    const s = probe.style(el);
    const pos = s('position');
    const dialog = isDialog(el);
    let here = inside;
    if (!probe.visible(el)) {
      // A modal waiting to be shown is worth a count: it may be the thing that appears later.
      if (pos === 'fixed' || pos === 'sticky' || dialog) hidden++;
      continue;
    }
    const z = s('z-index');
    const layered = pos === 'fixed' || pos === 'sticky' || dialog;
    // An absolutely positioned sheet over most of the screen at a high z-index is an overlay too;
    // some sites put their modal root there rather than on position:fixed.
    const zn = Number(z);
    if (layered || (pos === 'absolute' && zn >= 100)) {
      const box = probe.box(el);
      const cover = coverage(box, vp.w, vp.h);
      if (area(box) === 0) {
        if (layered) hidden++;
      } else if (layered || cover >= 0.3) {
        const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
        layers.push({ el, pos, z, box, cover, dialog, text: t, inside });
        here = layers.length - 1;
      }
    }
    const kids = [...el.children];
    for (let i = kids.length - 1; i >= 0; i--) stack.push({ el: kids[i]!, inside: here });
  }

  const out: string[] = [`Viewport ${vp.w}x${vp.h}, page height ${vp.pageH}, scrolled to ${vp.scrollY}.`, scrollLock(probe, vp)];
  if (!layers.length) {
    out.push(`No fixed, sticky or dialog layers are showing${hidden ? ` (${hidden} hidden ones: display:none or zero size)` : ''}.`);
    return out.join('\n');
  }
  const { shown, rest } = pickLayers(layers, rows);
  const number = new Map(shown.map((li, n) => [li, n + 1]));
  out.push(`${layers.length} layer(s) (fixed, sticky, dialogs), in page order:`);
  for (const li of shown) {
    const l = layers[li]!;
    const tags: string[] = [];
    if (l.dialog) tags.push('dialog');
    // A near-empty sheet over most of the screen is the dimmer behind a modal.
    if (l.cover >= 0.5 && l.text.length < 3 && !l.dialog) tags.push('backdrop?');
    let parent = l.inside;
    while (parent >= 0 && !number.has(parent)) parent = layers[parent]!.inside;
    // Zero is a sticky bar or banner further down the page: there, but not covering anything now.
    const covers = l.cover === 0 ? 'off screen now' : `covers ${l.cover < 0.01 ? '<1' : Math.round(l.cover * 100)}%`;
    out.push(
      `${number.get(li)}. ${describeNode(l.el)} ${l.pos}${l.z && l.z !== 'auto' ? ` z-index:${l.z}` : ''} ${size(l.box)} @${Math.round(l.box.x)},${Math.round(l.box.y)} ${covers}` +
        `${tags.length ? ` [${tags.join(', ')}]` : ''}${parent >= 0 ? ` (inside ${number.get(parent)}.)` : ''} ${l.text ? JSON.stringify(trunc(l.text, 60)) : '(no text)'}`,
    );
  }
  if (rest) out.push(`…and ${rest} smaller layer(s) not listed.`);
  if (hidden) out.push(`Also ${hidden} hidden fixed/sticky/dialog element(s) (display:none or zero size).`);
  return out.join('\n');
}

/** What is stopping the page from scrolling, in one line: overflow, a fixed body, inert, aria-hidden. */
function scrollLock(probe: Probe, vp: { w: number; h: number }): string {
  const found: string[] = [];
  for (const el of [document.documentElement, document.body]) {
    if (!el) continue;
    const name = el.tagName.toLowerCase();
    const s = probe.style(el);
    const oy = s('overflow-y') || s('overflow');
    if (/hidden|clip/.test(oy)) found.push(`${name} overflow-y:${oy}`);
    if (s('position') === 'fixed') found.push(`${name} position:fixed${s('top') && s('top') !== 'auto' && s('top') !== '0px' ? ` top:${s('top')}` : ''}`);
    const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter((c) => LOCK_CLASS.test(c));
    if (cls.length) found.push(`${name} class "${cls.slice(0, 3).join(' ')}"`);
  }
  const inert = [...document.querySelectorAll('[inert]')];
  if (inert.length) found.push(`inert on ${inert.slice(0, 2).map(describeNode).join(', ')}${inert.length > 2 ? ` and ${inert.length - 2} more` : ''}`);
  // aria-hidden on a big chunk of the page is how a modal hides the rest from screen readers; a
  // mod that removes the modal and leaves this behind leaves the page unreadable to them.
  const hiddenMain = [...(document.body?.children ?? [])].filter((el) => el.getAttribute('aria-hidden') === 'true' && coverage(probe.box(el), vp.w, vp.h) >= 0.25);
  if (hiddenMain.length) found.push(`aria-hidden="true" on ${hiddenMain.slice(0, 2).map(describeNode).join(', ')}`);
  return found.length ? `Scroll lock: ${found.join('; ')}.` : 'Scroll lock: none (html and body scroll normally, nothing inert).';
}

/**
 * get_styles: computed properties for the first match. When more match, it says so and points at
 * find_elements with styles, which reads them for every match, rather than leaving the model to
 * assume the first one speaks for all of them.
 */
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
  if (found.length > 1) lines.push(`(the first of ${found.length} matches; find_elements with styles reads every match)`);
  return lines.join('\n');
}
