// find_elements' ancestors, layout and overlay inventory, and get_styles (lib/inspect.ts): the
// one-call answers to what models were writing inspection scripts for.
//
// Parsed with linkedom, which has no layout. The Probe below reads a box from data-box="x,y,w,h"
// and computed style from the inline style attribute, over browser defaults, so the same code that
// runs on a live page runs here on a page whose geometry the test states.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  ancestorChain,
  CHAIN_MATCHES,
  CHAIN_STEPS,
  computedStyles,
  coverage,
  describeElements,
  describeFurniture,
  describeNode,
  layoutFacts,
  pickLayers,
  type Box,
  type Layer,
  type Probe,
} from '../lib/inspect.ts';

Object.assign(globalThis, { CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) } });

function load(html: string): Document {
  const d = parseHTML(html).document as unknown as Document;
  Object.assign(globalThis, { document: d, HTMLElement: class {} });
  return d;
}

const DEFAULTS: Record<string, string> = { display: 'block', visibility: 'visible', opacity: '1', position: 'static', 'z-index': 'auto', overflow: 'visible', 'overflow-y': 'visible', top: 'auto' };

function inline(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  for (const decl of (el.getAttribute('style') ?? '').split(';')) {
    const [k, v] = decl.split(':').map((x) => x?.trim());
    if (k && v) out[k] = v;
  }
  return out;
}

const probe: Probe = {
  box(el) {
    const [x, y, w, h] = (el.getAttribute('data-box') ?? '0,0,100,20').split(',').map(Number);
    return { x: x!, y: y!, w: w!, h: h! };
  },
  style(el) {
    const own = inline(el);
    return (p) => own[p] ?? DEFAULTS[p] ?? '';
  },
  visible: (el) => !el.hasAttribute('hidden') && inline(el).display !== 'none',
  viewport: () => ({ w: 1000, h: 800, scrollY: 0, pageH: 3000 }),
};

// ---------- describing an element ----------

test('describeNode is a short, valid selector: tag, id, a readable class, role, label, testid', () => {
  load('<html><body><div id="feed" class="css-1a2b3c card big" role="article" aria-label="Post" data-testid="post"></div></body></html>');
  assert.equal(describeNode(document.querySelector('div')!), 'div#feed.card[role="article"][aria-label="Post"][data-testid="post"]');
  load(`<html><body><button class="x9f8e7d6" aria-label="${'a'.repeat(50)}" aria-modal="true"></button></body></html>`);
  assert.equal(describeNode(document.querySelector('button')!), `button.x9f8e7d6[aria-label^="${'a'.repeat(30)}"][aria-modal="true"]`, 'a generated class beats none; a long label is a prefix match');
});

test('layoutFacts names display always and the rest only when not the default', () => {
  assert.equal(layoutFacts((p) => DEFAULTS[p] ?? ''), 'display:block');
  const style: Record<string, string> = { ...DEFAULTS, display: 'flex', position: 'fixed', 'z-index': '10', opacity: '0.5', visibility: 'hidden' };
  assert.equal(layoutFacts((p) => style[p] ?? ''), 'display:flex visibility:hidden opacity:0.5 position:fixed z-index:10');
});

// ---------- ancestor chains ----------

const FEED = `<html><body><main id="main" data-box="0,0,1000,3000">
  <div class="feed" data-box="0,0,600,3000">
    <article class="post" data-box="0,0,600,400"><div class="wrap" data-box="0,0,600,40"><div class="inner" data-box="0,0,600,40"><span class="label" data-box="0,0,60,16">Sponsored</span></div></div></article>
    <article class="post" data-box="0,400,600,400"><div class="wrap" data-box="0,400,600,40"><span class="label" data-box="0,400,60,16">Sponsored</span></div></article>
    <article class="post" data-box="0,800,600,400">organic</article>
  </div></main></body></html>`;

test('a chain collapses same-size wrappers, marks the card in a list as the unit, and stops one step above it', () => {
  load(FEED);
  const label = document.querySelector('span.label')!;
  const chain = ancestorChain(label, probe.box(label), probe, new Map(), 1);
  assert.equal(chain, 'div.inner 600x40 › (1 same-size) › article.post 600x400 [unit? 1 of 3 like it] › div.feed 600x3000 › …');
});

test('a chain with no unit in it walks all the way up to body', () => {
  load('<html><body><main id="m" data-box="0,0,1000,3000"><div class="col" data-box="0,0,600,3000"><p data-box="0,0,600,100"><b data-box="0,0,50,16">x</b></p></div></main></body></html>');
  const b = document.querySelector('b')!;
  assert.equal(ancestorChain(b, probe.box(b), probe, new Map(), 1), 'p 600x100 › div.col 600x3000 › main#m 1000x3000');
});

test('a later match whose ancestors were already printed ends with "then as in N."', () => {
  load(FEED);
  const [a, b] = [...document.querySelectorAll('span.label')];
  const seen = new Map<Element, number>();
  ancestorChain(a!, probe.box(a!), probe, seen, 1);
  assert.equal(ancestorChain(b!, probe.box(b!), probe, seen, 2), 'div.wrap 600x40 › article.post 600x400 [unit? 1 of 3 like it] › (then as in 1.)');
});

test('a popup: the dialog is the unit even when it does not repeat, and a fixed shell says so', () => {
  load(`<html><body><div class="shell" style="position:fixed;z-index:50" data-box="0,0,1000,800">
    <div role="dialog" aria-label="Subscribe modal" data-box="300,200,400,300"><div class="body" data-box="300,200,400,260"><button class="close" data-box="660,210,32,32">x</button></div></div>
  </div></body></html>`);
  const close = document.querySelector('button')!;
  assert.equal(
    ancestorChain(close, probe.box(close), probe, new Map(), 1),
    'div.body 400x260 › div[role="dialog"][aria-label="Subscribe modal"] 400x300 [unit? dialog] › div.shell 1000x800 fixed z-index:50',
  );
});

test('a small label among inline siblings is not a unit: the ancestor must be much larger than the match', () => {
  load('<html><body><p data-box="0,0,600,200"><span class="m" data-box="0,0,80,16"><b data-box="0,0,40,16">x</b></span><span class="m" data-box="80,0,80,16"></span><span class="m" data-box="160,0,80,16"></span></p></body></html>');
  const b = document.querySelector('b')!;
  assert.doesNotMatch(ancestorChain(b, probe.box(b), probe, new Map(), 1).split(' › ')[0]!, /unit/);
});

test('a deep chain stops at CHAIN_STEPS and says it was cut', () => {
  let html = '<html><body>';
  for (let i = 0; i < 12; i++) html += `<div class="d${i}" data-box="0,0,${1000 - i * 10},${1000 - i * 10}">`;
  html += '<i data-box="0,0,5,5">x</i>' + '</div>'.repeat(12) + '</body></html>';
  load(html);
  const i = document.querySelector('i')!;
  const steps = ancestorChain(i, probe.box(i), probe, new Map(), 1).split(' › ');
  assert.equal(steps.length, CHAIN_STEPS + 1);
  assert.equal(steps.at(-1), '…');
});

test('find_elements prints layout and asked-for styles for every match, and chains for the first few only', () => {
  let html = '<html><body><ul class="list" data-box="0,0,500,2000">';
  for (let n = 0; n < 6; n++) html += `<li class="row" style="display:flex" data-box="0,${n * 50},500,50"><a class="t" data-box="0,${n * 50},100,20">item ${n}</a></li>`;
  load(html + '</ul></body></html>');
  const out = describeElements('a.t', 20, undefined, { styles: ['display', 'color'] }, probe);
  assert.equal((out.match(/^\d+\. /gm) ?? []).length, 6);
  assert.equal((out.match(/^ {3}display: block; color: \(none\)$/gm) ?? []).length, 6, 'the styles line is there for every match');
  assert.equal((out.match(/^ {3}ancestors: /gm) ?? []).length, CHAIN_MATCHES);
  assert.match(out, /1\. .* \[100x20 @0,0\] display:block item 0/);
  assert.match(out, /ancestors: li\.row 500x50 \[unit\? 1 of 6 like it\] › ul\.list 500x2000$/m);
  assert.match(out, /ancestors: li\.row 500x50 \[unit\? 1 of 6 like it\] › \(then as in 1\.\)$/m);
  assert.match(out, /Ancestors are listed for the first 3 matches only\.\n\[unit\? …\] = likely thing to hide/);
});

test('find_elements with only overlays needs no selector, and a plain call is unchanged in wording', () => {
  load('<html><body><p>hi</p></body></html>');
  assert.match(describeElements(undefined, 20, undefined, { overlays: true }, probe), /^Viewport 1000x800/);
  assert.equal(describeElements(undefined, 20, undefined, {}, probe), 'Give a selector, a text, or both.');
});

// ---------- the furniture inventory ----------

const FURNITURE = `<html><body class="has-modal-open" style="overflow-y:hidden">
  <header class="site" style="position:sticky;z-index:10" data-box="0,0,1000,60"><a>Home</a> <a>News</a></header>
  <main id="content" inert data-box="0,60,1000,2000"><p>Article text</p></main>
  <div id="cookie" style="position:fixed;z-index:40" data-box="0,680,1000,120">We use cookies <button>Accept</button></div>
  <div class="backdrop" style="position:fixed;z-index:999" data-box="0,0,1000,800"></div>
  <div class="modal-root" style="position:fixed;z-index:1000" data-box="0,0,1000,800">
    <div role="dialog" aria-modal="true" class="modal" data-box="300,250,400,300">Subscribe to our newsletter</div>
  </div>
  <div class="toast" style="position:fixed;display:none"></div>
</body></html>`;

test('the furniture inventory lists layers with cover, backdrop, dialog, nesting, and the scroll lock', () => {
  load(FURNITURE);
  const out = describeFurniture(probe);
  const lines = out.split('\n');
  assert.equal(lines[0], 'Viewport 1000x800, page height 3000, scrolled to 0.');
  assert.equal(lines[1], 'Scroll lock: body overflow-y:hidden; body class "has-modal-open"; inert on main#content.');
  assert.equal(lines[2], '5 layer(s) (fixed, sticky, dialogs), in page order:');
  assert.equal(lines[3], '1. header.site sticky z-index:10 1000x60 @0,0 covers 8% "Home News"');
  assert.equal(lines[4], '2. div#cookie fixed z-index:40 1000x120 @0,680 covers 15% "We use cookies Accept"');
  assert.equal(lines[5], '3. div.backdrop fixed z-index:999 1000x800 @0,0 covers 100% [backdrop?] (no text)');
  assert.equal(lines[6], '4. div.modal-root fixed z-index:1000 1000x800 @0,0 covers 100% "Subscribe to our newsletter"');
  assert.equal(lines[7], '5. div.modal[role="dialog"][aria-modal="true"] static 400x300 @300,250 covers 15% [dialog] (inside 4.) "Subscribe to our newsletter"');
  assert.equal(lines[8], 'Also 1 hidden fixed/sticky/dialog element(s) (display:none or zero size).');
});

test('a page with nothing layered says so, and a normal page reports no scroll lock', () => {
  load('<html><body><p>plain</p></body></html>');
  assert.equal(describeFurniture(probe).split('\n').slice(1).join('\n'), 'Scroll lock: none (html and body scroll normally, nothing inert).\nNo fixed, sticky or dialog layers are showing.');
});

test('a layer below the fold is "off screen now", and a class that merely mentions dialog is not a lock', () => {
  load('<html class="uls-dialog-sticky-hide"><body><div class="tabs" style="position:sticky" data-box="0,1200,900,48">Files</div></body></html>');
  const out = describeFurniture(probe);
  assert.match(out, /\nScroll lock: none/);
  assert.match(out, /1\. div\.tabs sticky 900x48 @0,1200 off screen now "Files"/);
});

test('over the row cap, dialogs and the biggest layers are kept, in page order, and the rest counted', () => {
  const layer = (cover: number, dialog = false) => ({ cover, dialog }) as Layer;
  const r = pickLayers([layer(0.01), layer(0.9), layer(0.02, true), layer(0.5), layer(0.001)], 3);
  assert.deepEqual(r, { shown: [1, 2, 3], rest: 2 });
});

test('coverage clips a box to the viewport', () => {
  const b = (x: number, y: number, w: number, h: number): Box => ({ x, y, w, h });
  assert.equal(coverage(b(0, 0, 1000, 800), 1000, 800), 1);
  assert.equal(coverage(b(-500, 0, 1000, 800), 1000, 800), 0.5);
  assert.equal(coverage(b(0, 900, 1000, 800), 1000, 800), 0, 'below the fold covers nothing now');
});

// ---------- get_styles ----------

test('get_styles says when it read only the first of several matches', () => {
  load('<html><body><p>a</p><p>b</p></body></html>');
  Object.assign(globalThis, { getComputedStyle: () => ({ getPropertyValue: () => 'block' }) });
  try {
    assert.equal(computedStyles('p', ['display']), 'display: block\n(the first of 2 matches; find_elements with styles reads every match)');
  } finally {
    delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
  }
});
