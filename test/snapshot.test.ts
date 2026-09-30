// The page reads: what get_page prints (lib/snapshot.ts), how it keeps a page's shape when the page
// is over budget, and the lookups find_elements, get_styles and get_page(selector) share with
// wait_for (lib/waitdom.ts): text search and the open-shadow-root fallback.
//
// Parsed with linkedom, which has no layout, so visibility is injected as "everything is visible"
// and the overflow tests run on the saved real pages in test/fixtures/pages.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import { buildTree, dataAttrs, describeElements, noisyDataValue, reachFor, renderTree, type SNode } from '../lib/snapshot.ts';
import { deepestOnly, elementsWithText, hasText, normalizeText, queryAllDeep } from '../lib/waitdom.ts';

// selectorFor uses CSS.escape, which a page has and node does not.
Object.assign(globalThis, { CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) } });

const PAGES = fileURLToPath(new URL('./fixtures/pages/', import.meta.url));
const visible = () => true;

/** Parse a page and install it as the global document, as the content script sees one. */
function load(html: string): Document {
  const w = parseHTML(html);
  const d = w.document as unknown as Document;
  // An HTMLElement nothing is an instance of: lib/snapshot.ts's own visibility check then treats
  // every element as visible, which is all a page without layout can say.
  Object.assign(globalThis, { document: d, HTMLElement: class {} });
  return d;
}

function tree(html: string, opts: { includeHidden?: boolean } = {}): SNode {
  const d = load(html);
  const t = buildTree(d.body, opts, visible);
  assert.ok(t);
  return t;
}

function page(name: string): SNode {
  return tree(readFileSync(PAGES + name, 'utf8'));
}

// ---------- pages that fit ----------

test('a page that fits prints whole, in the same format as always', () => {
  const t = tree('<html><body><div id="a" class="x y"><p>Hello   <a href="/b">there</a></p><script>no()</script></div></body></html>');
  assert.equal(renderTree(t, 20_000), '<body><div id="a" class="x y"><p>Hello<a href="/b">there</a></p></div></body>');
});

test('an open shadow root prints its own children inside the marker, and the light children after it', () => {
  const d = load('<html><body><x-card><span>light</span></x-card></body></html>');
  d.querySelector('x-card')!.attachShadow({ mode: 'open' }).innerHTML = '<div class="inner">shadow</div>';
  const out = renderTree(buildTree(d.body, {}, visible)!, 20_000);
  assert.equal(out, '<body><x-card><#shadow-root><div class="inner">shadow</div></#shadow-root><span>light</span></x-card></body>');
});

test('hidden elements are left out unless include_hidden asks for them', () => {
  const d = load('<html><body><div class="menu" hidden>Settings</div><p>shown</p></body></html>');
  const isShown = (el: Element) => !el.hasAttribute('hidden');
  assert.doesNotMatch(renderTree(buildTree(d.body, {}, isShown)!, 20_000), /Settings/);
  assert.match(renderTree(buildTree(d.body, { includeHidden: true }, isShown)!, 20_000), /<div class="menu">Settings/);
});

// ---------- attributes ----------

test('data-* attributes are kept: short values as they are, bare names for flags', () => {
  assert.deepEqual(dataAttrs([['data-component', 'shelf'], ['data-active', ''], ['class', 'x']]), ['data-component="shelf"', 'data-active']);
});

test('data-* noise is bounded: hashed and tracking names, long, JSON and random values skipped, at most four', () => {
  assert.deepEqual(dataAttrs([['data-v-7ba5bd90', '']]), [], 'Vue scoping markers say nothing');
  assert.deepEqual(dataAttrs([['data-ga-click', 'nav'], ['data-octo-dimensions', 'x'], ['data-track', 'y'], ['data-hydro-view', 'z']]), []);
  assert.deepEqual(dataAttrs([['data-hovercard-url', '/u/x'], ['data-turbo-frame', 'repo'], ['data-error-text', 'Oops']]), []);
  assert.deepEqual(dataAttrs([['data-track', '{"event":"click","pos":3}']]), []);
  assert.deepEqual(dataAttrs([['data-payload', '{"a":1}']]), [], 'JSON');
  assert.deepEqual(dataAttrs([['data-id', 'a8f7c2e91b3d4f56a8f7c2e9']]), [], 'a hash');
  assert.deepEqual(dataAttrs([['data-note', 'x'.repeat(41)]]), [], 'too long');
  assert.deepEqual(dataAttrs([['data-line-number', '12']]), [], 'a number');
  assert.deepEqual(dataAttrs([['data-testid', 'kept-elsewhere']]), [], 'data-testid is in the main allow-list');
  const many = dataAttrs([1, 2, 3, 4, 5, 6].map((i) => [`data-k${'abcdef'[i - 1]}`, 'v'] as const));
  assert.equal(many.length, 4);
  assert.equal(noisyDataValue('video-card'), false);
  assert.equal(noisyDataValue('12345'), true, 'a row index or record id says which, not what');
});

test('data-* attributes that carry credentials or contact details never reach the model', () => {
  // Short enough to pass the value checks, so they must be dropped by name or by shape.
  assert.deepEqual(dataAttrs([['data-csrf', 'Ab12Cd34Ef56'], ['data-auth-token', 'abc'], ['data-session-id', 'x1'], ['data-nonce', 'q']]), []);
  assert.deepEqual(dataAttrs([['data-email', 'me@example.com'], ['data-user-phone', '+1 555 010 9999']]), []);
  assert.deepEqual(dataAttrs([['data-owner', 'jane.doe@example.org'], ['data-contact', '(555) 010-9999']]), [], 'recognised by value too');
  // Words that merely contain those letters are not caught.
  assert.deepEqual(dataAttrs([['data-hotkey', 'g d'], ['data-state', 'open']]), ['data-hotkey="g d"', 'data-state="open"']);
});

test('the same data-* pair is printed a few times per snapshot, not on every element', () => {
  const seen = new Map<string, number>();
  const printed = Array.from({ length: 20 }, () => dataAttrs([['data-view-component', 'true'], ['data-row', 'x']], seen));
  assert.equal(printed.filter((p) => p.includes('data-view-component="true"')).length, 8);
  // A pair with a different value is its own pair.
  assert.deepEqual(dataAttrs([['data-view-component', 'false']], seen), ['data-view-component="false"']);
});

test('the state half of ARIA reaches the snapshot', () => {
  const out = renderTree(tree('<html><body><div role="tab" aria-selected="true" aria-current="page" aria-pressed="false" data-tab="home">Home</div></body></html>'), 20_000);
  assert.equal(out, '<body><div role="tab" aria-selected="true" aria-current="page" aria-pressed="false" data-tab="home">Home</div></body>');
});

// ---------- over budget: the page keeps its shape ----------

const regions = (t: SNode) => t.kids.filter((k): k is SNode => typeof k !== 'string');

test('over budget, every region of a real page is still there, the tail included', () => {
  const t = page('github-blob.html');
  assert.ok(t.size > 20_000, `the fixture should overflow the default budget (is ${t.size})`);
  const out = renderTree(t, 20_000);
  assert.ok(out.length <= 20_000, `within budget (${out.length})`);
  assert.match(out, /parts are collapsed/);
  // Each top-level region appears, by its opening tag, in document order: the old tail cut lost
  // everything after the header.
  let at = 0;
  for (const r of regions(t)) {
    const i = out.indexOf(r.open, at);
    assert.ok(i >= 0, `region ${r.open.slice(0, 80)} is missing`);
    at = i;
  }
  assert.match(out, /…\d+ nodes/);
});

test('every saved page, at every budget, comes back within it', () => {
  for (const f of readdirSync(PAGES).filter((n) => n.endsWith('.html'))) {
    const t = page(f);
    for (const budget of [1500, 4000, 8000, 20_000, 60_000]) {
      const out = renderTree(t, budget);
      assert.ok(out.length <= budget, `${f} at ${budget}: ${out.length}`);
      if (t.size <= budget) assert.doesNotMatch(out, /parts are collapsed|truncated at/, `${f} fits in ${budget}`);
    }
  }
});

test('the budget goes mostly to the biggest region, not to whichever comes first', () => {
  const nav = Array.from({ length: 40 }, (_, i) => `<a href="/n${i}">Navigation link number ${i}</a>`).join('');
  const body = Array.from({ length: 60 }, (_, i) => `<p class="para">Paragraph ${i}: ${'lorem ipsum '.repeat(12)}</p>`).join('');
  const t = tree(`<html><body><header id="top">${nav}</header><main id="content">${body}</main></body></html>`);
  const out = renderTree(t, 6000);
  const header = out.slice(out.indexOf('<header'), out.indexOf('</header>'));
  const main = out.slice(out.indexOf('<main'), out.indexOf('</main>'));
  assert.ok(main.length > header.length, `main ${main.length} vs header ${header.length}`);
  assert.match(out, /<main id="content">/);
});

test('a long run of similar children folds to whole examples and a count', () => {
  const items = Array.from({ length: 400 }, (_, i) => `<li class="item"><a href="/p/${i}">Post ${i}</a><span class="meta">${i} points</span></li>`).join('');
  const t = tree(`<html><body><nav id="nav"><a href="/">Home</a></nav><ul class="feed">${items}</ul><footer id="foot">Contact</footer></body></html>`);
  const out = renderTree(t, 5000);
  assert.ok(out.length <= 5000);
  assert.match(out, /<li class="item"><a href="\/p\/0">Post 0<\/a><span class="meta">0 points<\/span><\/li>/, 'the first items are whole');
  assert.match(out, /<… \d+ more li\.item\/>/);
  assert.match(out, /<footer id="foot">Contact<\/footer>/, 'and what comes after the feed survives');
});

test('a collapsed element says how big it is, what its children look like, and how it starts', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `<div class="row"><b>Row ${i}</b>${'<i>x</i>'.repeat(20)}</div>`).join('');
  const t = tree(`<html><body><section class="a">${rows}</section><section class="b">${rows}</section></body></html>`);
  const out = renderTree(t, 300);
  assert.match(out, /<section class="a">…\d+ nodes, 50× div\.row, "Row 0"<\/section>/);
});

test('children that cannot all be listed show the first ones and count the rest', () => {
  // Five hundred children with nothing in common, so there is no run to fold either.
  const kids = Array.from({ length: 500 }, (_, i) => `<p class="c${i}">${i}</p>`).join('');
  const out = renderTree(tree(`<html><body>${kids}</body></html>`), 400);
  assert.ok(out.length <= 400, `within budget (${out.length})`);
  assert.match(out, /^<body><p class="c0">0<\/p><p class="c1">1<\/p>/);
  assert.match(out, /<… cut: \d+ more elements\/><\/body>/);
});

test('one big region of unlike children is opened, not collapsed to a line that get_page cannot open', () => {
  // The old failure: the region collapsed to "<div>…5000 nodes</div>" inside a 20,000 budget, and
  // get_page on that div collapsed it the same way again, so its content was unreadable.
  const kids = Array.from({ length: 5000 }, (_, i) => `<p class="c${i}">Paragraph ${i}</p>`).join('');
  const t = tree(`<html><body><header id="top">Site</header><div>${kids}</div></body></html>`);
  const out = renderTree(t, 20_000);
  assert.ok(out.length <= 20_000);
  assert.ok(out.length > 15_000, `the budget is used, not wasted (${out.length})`);
  assert.match(out, /<header id="top">Site<\/header><div><p class="c0">Paragraph 0<\/p>/);
  assert.match(out, /<… cut: \d+ more elements\/><\/div>/);
});

test('a long run of similar items fills the budget rather than folding to one example', () => {
  const items = Array.from({ length: 5000 }, (_, i) => `<li class="item">Item ${i}</li>`).join('');
  const out = renderTree(tree(`<html><body><ul>${items}</ul></body></html>`), 20_000);
  assert.ok(out.length <= 20_000);
  assert.ok(out.length > 10_000, `most of the budget holds items (${out.length})`);
  assert.match(out, /<li class="item">Item 100<\/li>/);
  assert.match(out, /<… \d+ more li\.item\/>/);
});

test('an enormous flat page renders in well under a second', () => {
  // Grouping siblings used to copy the group array per child: quadratic, about 3s at this size.
  const items = Array.from({ length: 50_000 }, (_, i) => `<li class="item">Item ${i}</li>`).join('');
  const t = tree(`<html><body><ul>${items}</ul></body></html>`);
  const started = performance.now();
  const out = renderTree(t, 20_000);
  const ms = performance.now() - started;
  assert.ok(ms < 1000, `took ${Math.round(ms)}ms`);
  // And the run still fills the budget: at this size the fold used to fall to its tight form, one
  // example and "<… 49999 more li.item/>", 237 characters out of 20,000.
  assert.ok(out.length > 10_000 && out.length <= 20_000, `length ${out.length}`);
});

test('a budget too small for anything else still returns the start of the page', () => {
  const out = renderTree(tree(`<html><body><main>${'<p class="x">hello world</p>'.repeat(50)}</main></body></html>`), 100);
  assert.match(out, /^<body><main>/);
  assert.match(out, /truncated at 100 chars/);
});

// ---------- text search ----------

test('text is compared case-insensitively with whitespace collapsed', () => {
  assert.equal(normalizeText('  Recommended\n   for  You '), 'recommended for you');
  const d = load('<html><body><h2>Recommended\n    for you</h2></body></html>');
  assert.equal(hasText(d.querySelector('h2')!, 'recommended FOR you'), true);
});

test('find by text returns the deepest elements, not every ancestor', () => {
  const d = load(
    '<html><body><div id="col"><section class="shelf"><h2 class="title">Recommended for you</h2><div>video</div></section>' +
      '<section class="shelf"><h2 class="title">Trending</h2></section><p>Also recommended for you: nothing</p></div></body></html>',
  );
  const hits = elementsWithText(d.body, 'recommended for you');
  assert.deepEqual(hits.map((h) => h.el.tagName.toLowerCase()), ['h2', 'p']);
  // With a selector as well, the deepest element of THAT kind.
  const sections = [...d.querySelectorAll('section, div')].map((el) => ({ el, hosts: [] }));
  const inSection = deepestOnly(sections.filter((m) => hasText(m.el, 'Recommended for you')));
  assert.deepEqual(inSection.map((m) => m.el.className), ['shelf']);
});

test('find by text reaches into open shadow roots', () => {
  const d = load('<html><body><x-app></x-app></body></html>');
  const host = d.querySelector('x-app')!;
  host.attachShadow({ mode: 'open' }).innerHTML = '<nav><button class="go">Sign in</button></nav>';
  const hits = elementsWithText(d.body, 'sign in');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.el.className, 'go');
  assert.deepEqual(hits[0]!.hosts, [host]);
});

test('find_elements words its answers for text, selector+text, and neither', () => {
  load('<html><body><ul><li class="a">Apple</li><li class="b">Banana</li></ul></body></html>');
  assert.equal(describeElements(undefined, 20, undefined), 'Give a selector, a text, or both.');
  assert.match(describeElements(undefined, 20, 'banana'), /^1 element\(s\) contain "banana":\n1\. .*Banana/);
  assert.match(describeElements('li', 20, 'apple'), /^1 element\(s\) match "li" and contain "apple":/);
  assert.equal(describeElements('li', 20, 'cherry'), '2 element(s) match "li", but none contain "cherry".');
  assert.equal(describeElements(undefined, 20, 'cherry'), 'No element\'s text contains "cherry".');
});

// ---------- open shadow roots ----------

function shadowPage(): { d: Document; outer: Element; inner: Element } {
  const d = load('<html><body><x-app id="app"></x-app><p class="plain">light</p></body></html>');
  const outer = d.querySelector('x-app')!;
  const root = outer.attachShadow({ mode: 'open' });
  root.innerHTML = '<x-list class="list"></x-list><button class="buy">Buy</button>';
  const inner = root.querySelector('x-list')!;
  inner.attachShadow({ mode: 'open' }).innerHTML = '<div class="row">one</div><div class="row">two</div>';
  return { d, outer, inner };
}

test('a selector that matches in the document never looks further', () => {
  shadowPage();
  const r = queryAllDeep('.plain');
  assert.equal(r.matches.length, 1);
  assert.equal(r.searchedRoots, 0);
});

test('a selector that misses the document is found inside open shadow roots, with the host chain', () => {
  const { outer, inner } = shadowPage();
  const buy = queryAllDeep('.buy');
  assert.equal(buy.matches.length, 1);
  assert.deepEqual(buy.matches[0]!.hosts, [outer]);
  const rows = queryAllDeep('.row');
  assert.equal(rows.matches.length, 2);
  assert.deepEqual(rows.matches[0]!.hosts, [outer, inner]);
  assert.equal(
    reachFor(rows.matches[0]!, '.row'),
    'document.querySelector("#app").shadowRoot.querySelector("x-list.list").shadowRoot.querySelector(".row")',
  );
});

test('the extension\'s own in-page UI is never where a selector is found', () => {
  const d = load('<html><body><p>page</p></body></html>');
  const ours = d.createElement('div');
  ours.setAttribute('data-usermods', 'banner');
  ours.attachShadow({ mode: 'open' }).innerHTML = '<button class="close">×</button>';
  d.documentElement.append(ours);
  const r = queryAllDeep('button.close');
  assert.equal(r.matches.length, 0);
  assert.equal(r.searchedRoots, 0);
});

test('deepestOnly keeps the innermost of nested matches, and scales to many', () => {
  const d = load(`<html><body>${'<div class="n">'.repeat(3)}x${'</div>'.repeat(3)}${'<div class="n">y</div>'.repeat(20000)}</body></html>`);
  const items = [...d.querySelectorAll('div.n')].map((el) => ({ el, hosts: [] }));
  const started = performance.now();
  const kept = deepestOnly(items);
  assert.ok(performance.now() - started < 1000);
  assert.equal(kept.length, 20001, 'the two outer divs of the nested three are dropped');
  assert.equal(kept[0]!.el.textContent, 'x');
  assert.equal(kept[0]!.el.children.length, 0);
});

test('a miss everywhere says the shadow roots were searched and closed ones cannot be', () => {
  shadowPage();
  assert.equal(describeElements('.nowhere'), 'No elements match ".nowhere". Also searched 2 open shadow root(s); closed shadow roots cannot be searched.');
});

test('an invalid selector is reported, not thrown', () => {
  shadowPage();
  assert.match(describeElements('div[', 20), /^Invalid selector:/);
});
