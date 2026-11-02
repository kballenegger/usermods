// The gate (lib/agent/gate.ts) and the allowances it reads (lib/agent/allowances.ts).
//
// A decision is a function of what was read from the live element and what the user answered, so
// each case below is built the way the page builds it: describeTarget on a parsed element.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import {
  actionKey,
  CONSEQUENTIAL_WORDS,
  consequentialReasons,
  decide,
  isWebPage,
  neverReason,
  wordsOf,
  type GateAllowances,
  type GateContext,
  type Verb,
} from '../lib/agent/gate.ts';
import {
  ALLOWANCES_KEY,
  allowAction,
  allowancesFor,
  allowSite,
  EMPTY_ALLOWANCES,
  forgetChat,
  loadAllowances,
  parseAllowances,
  removeSite,
  standingSites,
  updateAllowances,
  type AllowanceStore,
} from '../lib/agent/allowances.ts';
import type { Probe } from '../lib/inspect.ts';
import { describeGo, describeTarget, type Described } from '../lib/interact/describe.ts';

Object.assign(globalThis, { CSS: { escape: (s: string) => s } });

const PAGE = 'https://shop.example.com/account';
const probe: Probe = {
  box: () => ({ x: 0, y: 0, w: 10, h: 10 }),
  style: () => () => '',
  visible: () => true,
  viewport: () => ({ w: 1000, h: 800, scrollY: 0, pageH: 1000 }),
};

/** The first element with id="t" in this markup, described as the page describes it. */
function read(html: string, pageUrl = PAGE): Described {
  const d = parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
  Object.assign(globalThis, { document: d });
  return describeTarget(d.querySelector('#t')!, { probe, pageUrl });
}

const OPEN: GateAllowances = { site: true, actions: [] };
const ctx = (verb: Verb, over: Partial<GateContext> = {}): GateContext => ({ verb, ...over });

// ---------- the words ----------

test('consequential words match whole words only, in names and in camelCase paths', () => {
  assert.deepEqual(wordsOf('placeOrder now_please'), ['place', 'order', 'now', 'please']);
  const asks = (name: string) => decide(read(`<button id="t" type="button">${name}</button>`), OPEN, ctx('click')).kind;
  for (const word of CONSEQUENTIAL_WORDS) assert.equal(asks(`Please ${word} this`), 'confirm', word);
  for (const name of ['Orders', 'Ordering', 'Sender', 'Postcard', 'Repay', 'Removed', 'Buyers guide', 'Show more']) assert.equal(asks(name), 'allow', name);
  assert.equal(asks('PLACE ORDER'), 'confirm', 'case is ignored');
});

test('a link is judged on its path as well as its name', () => {
  assert.equal(decide(read('<a id="t" href="/account/delete">Settings</a>'), OPEN, ctx('click')).kind, 'confirm');
  assert.equal(decide(read('<a id="t" href="/orders/1182">Settings</a>'), OPEN, ctx('click')).kind, 'allow', '"orders" is not "order"');
  assert.equal(decide(read('<a id="t" href="/items/placeOrder">Settings</a>'), OPEN, ctx('click')).kind, 'confirm');
  assert.equal(decide(read('<a id="t" href="/x?action=delete">Settings</a>'), OPEN, ctx('click')).kind, 'allow', 'the path, not the query');
});

test('a control labelled harmlessly and showing a dangerous word still asks', () => {
  const d = read('<button id="t" type="button" aria-label="Details">Delete account</button>');
  assert.equal(d.name, 'Details');
  assert.equal(decide(d, OPEN, ctx('click')).kind, 'confirm');
});

// ---------- the form rule ----------

test('submitting a form asks unless its method is GET', () => {
  assert.equal(decide(read('<form method="post"><button id="t">Save</button></form>'), OPEN, ctx('click')).kind, 'confirm');
  assert.equal(decide(read('<form method="PUT"><button id="t">Save</button></form>'), OPEN, ctx('click')).kind, 'confirm');
  assert.equal(decide(read('<form><button id="t">Save</button></form>'), OPEN, ctx('click')).kind, 'allow');
  assert.equal(decide(read('<form method="get"><button id="t">Search</button></form>'), OPEN, ctx('click')).kind, 'allow');
  assert.equal(decide(read('<form method="post"><button id="t" type="button">Preview</button></form>'), OPEN, ctx('click')).kind, 'allow', 'not a submit');
  assert.equal(decide(read('<form method="post"><button id="t" formmethod="get">Preview</button></form>'), OPEN, ctx('click')).kind, 'allow');
  assert.equal(decide(read('<form><button id="t" formmethod="post">Go</button></form>'), OPEN, ctx('click')).kind, 'confirm');
  assert.equal(decide(read('<form method="post"><div id="t" role="button">Go</div></form>'), OPEN, ctx('click')).kind, 'confirm', 'a scripted button in a form cannot be told apart from a submit');
});

test('Enter in a field of a POST form asks; another key does not', () => {
  const d = read('<form method="post"><input id="t" aria-label="Title"></form>');
  assert.equal(decide(d, OPEN, ctx('press', { key: 'Enter' })).kind, 'confirm');
  assert.equal(decide(d, OPEN, ctx('press', { key: 'Tab' })).kind, 'allow');
  assert.equal(decide(read('<form><input id="t" aria-label="Title"></form>'), OPEN, ctx('press', { key: 'Enter' })).kind, 'allow');
  assert.equal(decide(read('<ul id="t" tabindex="0"></ul>'), OPEN, ctx('press', { key: 'Delete' })).kind, 'confirm', 'the Delete key is what it says');
});

test('typing, hovering and scrolling do not ask because of a word', () => {
  const field = read('<input id="t" aria-label="Order notes">');
  assert.equal(decide(field, OPEN, ctx('fill')).kind, 'allow');
  const del = read('<button id="t" type="button">Delete</button>');
  assert.equal(decide(del, OPEN, ctx('hover')).kind, 'allow');
  assert.equal(decide(del, OPEN, ctx('scroll_to')).kind, 'allow');
  assert.equal(decide(del, OPEN, ctx('click')).kind, 'confirm');
});

test('choosing and ticking are judged like a click', () => {
  assert.equal(decide(read('<input id="t" type="checkbox" aria-label="Remove me">'), OPEN, ctx('check')).kind, 'confirm');
  assert.equal(decide(read('<select id="t" aria-label="Cancel reason"></select>'), OPEN, ctx('select')).kind, 'confirm');
  assert.equal(decide(read('<select id="t" aria-label="Size"></select>'), OPEN, ctx('select')).kind, 'allow');
});

// ---------- the never list ----------

test('never: typing into a password, one-time-code or card field', () => {
  for (const [html, word] of [
    ['<input id="t" type="password">', 'password'],
    ['<input id="t" autocomplete="one-time-code">', 'one-time code'],
    ['<input id="t" name="cc-number" autocomplete="cc-number">', 'card'],
    ['<input id="t" name="cvv">', 'card'],
  ] as const) {
    const d = decide(read(html), OPEN, ctx('fill'));
    assert.equal(d.kind, 'deny', html);
    assert.match(d.kind === 'deny' ? d.reason : '', new RegExp(`types into a ${word} field`));
  }
  assert.equal(decide(read('<select id="t" autocomplete="cc-exp-month"></select>'), OPEN, ctx('select')).kind, 'deny');
  assert.equal(decide(read('<input id="t" type="password">'), OPEN, ctx('press', { key: 'x' })).kind, 'deny');
  assert.equal(decide(read('<input id="t" type="password">'), OPEN, ctx('press', { key: 'Tab' })).kind, 'allow', 'moving out of it types nothing');
  assert.equal(decide(read('<input id="t" type="password">'), OPEN, ctx('click')).kind, 'allow', 'clicking a field types nothing');
});

test('never: submitting a form holding one, by click or by key, whatever its method', () => {
  const button = read('<form><input type="password"><button id="t">Sign in</button></form>');
  assert.equal(decide(button, OPEN, ctx('click')).kind, 'deny');
  assert.equal(decide(button, OPEN, ctx('press', { key: 'Enter' })).kind, 'deny');
  assert.equal(decide(button, OPEN, ctx('press', { key: ' ' })).kind, 'deny');
  assert.equal(decide(read('<form><input name="otp"><button id="t">Verify</button></form>'), OPEN, ctx('click')).kind, 'deny');
  assert.equal(decide(read('<form><input type="password"><input id="t" name="user"></form>'), OPEN, ctx('press', { key: 'Enter' })).kind, 'deny');
  assert.equal(decide(read('<form><input type="password"><input id="t" name="user" aria-label="User"></form>'), OPEN, ctx('fill')).kind, 'allow');
  assert.equal(decide(read('<form><input type="password"><button id="t" type="button">Show</button></form>'), OPEN, ctx('click')).kind, 'allow', 'a show-password button submits nothing');
});

test('never: any step on a browser or extension page', () => {
  for (const url of ['chrome://settings/', 'chrome-extension://x/sidepanel.html', 'about:blank', 'edge://flags', 'view-source:https://a.com']) {
    assert.equal(isWebPage(url), false, url);
    assert.equal(decide(read('<button id="t">Go</button>', url), OPEN, ctx('click')).kind, 'deny', url);
    assert.equal(decide(read('<button id="t">Go</button>', url), OPEN, ctx('hover')).kind, 'deny', url);
  }
  assert.equal(isWebPage('https://a.com/'), true);
  assert.equal(isWebPage('not a url'), false);
});

test('never: a go or a link to a browser page or a script', () => {
  assert.equal(decide(describeGo('javascript:alert(1)', PAGE), OPEN, ctx('go')).kind, 'deny');
  assert.equal(decide(describeGo('chrome://settings', PAGE), OPEN, ctx('go')).kind, 'deny');
  assert.equal(decide(read('<a id="t" href="chrome://settings">x</a>'), OPEN, ctx('click')).kind, 'deny');
});

test('the never list beats every allowance and every answer', () => {
  const d = read('<input id="t" type="password">');
  const everything: GateAllowances = { site: true, actions: [actionKey(d, 'fill')] };
  assert.equal(decide(d, everything, ctx('fill')).kind, 'deny');
  assert.equal(decide(d, everything, ctx('fill', { forceConfirm: true })).kind, 'deny');
  assert.ok(neverReason(d, 'fill'));
});

// ---------- go ----------

test('go: on the site and already seen is allowed; unseen asks; off the site is refused', () => {
  const siteHosts = ['shop.example.com'];
  const known = ['https://shop.example.com/orders?page=2'];
  assert.equal(decide(describeGo('/orders?page=2', PAGE), OPEN, ctx('go', { siteHosts, knownUrls: known })).kind, 'allow');
  assert.equal(decide(describeGo('/orders?page=2#row', PAGE), OPEN, ctx('go', { siteHosts, knownUrls: known })).kind, 'allow', 'the fragment does not make it a new address');
  const unseen = decide(describeGo('/somewhere', PAGE), OPEN, ctx('go', { siteHosts, knownUrls: known }));
  assert.equal(unseen.kind, 'confirm');
  assert.match(unseen.kind === 'confirm' ? unseen.reasons[0]! : '', /address not seen/);
  const off = decide(describeGo('https://evil.test/?q=secret', PAGE), OPEN, ctx('go', { siteHosts, knownUrls: ['https://evil.test/?q=secret'] }));
  assert.equal(off.kind, 'deny');
  assert.match(off.kind === 'deny' ? off.reason : '', /leaves this site/);
  for (const t of ['back', 'forward', 'reload']) assert.equal(decide(describeGo(t, PAGE), OPEN, ctx('go', { siteHosts })).kind, 'allow', t);
});

// ---------- the questions ----------

test('the first step on a site asks, and a consequential first step asks both on one card', () => {
  const plain = decide(read('<button id="t" type="button">Show more</button>'), { site: false, actions: [] }, ctx('click'));
  assert.deepEqual(plain, { kind: 'confirm', asksSite: true, reasons: [] });
  const del = read('<button id="t" type="button">Unsubscribe</button>');
  const both = decide(del, { site: false, actions: [] }, ctx('click'));
  assert.equal(both.kind, 'confirm');
  if (both.kind === 'confirm') {
    assert.equal(both.asksSite, true);
    assert.deepEqual(both.reasons, ['it says "unsubscribe"']);
    assert.equal(both.actionKey, 'click button "unsubscribe"');
  }
});

test('"allow every one of these" allows that name and nothing wider', () => {
  const unsub = read('<button id="t" type="button">Unsubscribe</button>');
  const key = actionKey(unsub, 'click');
  const allowed: GateAllowances = { site: true, actions: [key] };
  assert.equal(decide(unsub, allowed, ctx('click')).kind, 'allow');
  assert.equal(decide(read('<button id="t" type="button">Unsubscribe and delete my account</button>'), allowed, ctx('click')).kind, 'confirm');
  assert.equal(decide(read('<a id="t" href="/x">Unsubscribe</a>'), allowed, ctx('click')).kind, 'confirm', 'a link is not that button');
  assert.equal(decide(unsub, allowed, ctx('press', { key: 'Enter' })).kind, 'confirm', 'nor another verb');
});

test('a forced question cannot be answered away by an allowance', () => {
  const del = read('<button id="t" type="button">Delete</button>');
  const allowed: GateAllowances = { site: true, actions: [actionKey(del, 'click')] };
  const skill = decide(del, allowed, ctx('click', { forceConfirm: true }));
  assert.equal(skill.kind, 'confirm');
  assert.equal(skill.kind === 'confirm' && skill.actionKey, undefined, 'and is not offered "every one of these"');
  assert.equal(decide(read('<button id="t" type="button">Show</button>'), OPEN, ctx('click', { askEveryStep: true })).kind, 'confirm');
  assert.equal(decide(read('<button id="t" type="button">Show</button>'), OPEN, ctx('hover', { forceConfirm: true })).kind, 'confirm');
});

test('the decision reads the element, not anything about what it was called before', () => {
  // A recording or a model calling this "Save" changes nothing: there is nowhere to pass that. What
  // differs is the element, read live.
  const was = read('<button id="t" type="button">Save</button>');
  const now = read('<button id="t" type="button">Delete</button>');
  assert.equal(decide(was, OPEN, ctx('click')).kind, 'allow');
  assert.equal(decide(now, OPEN, ctx('click')).kind, 'confirm');
  assert.equal(decide.length, 3);
});

test('the reasons are the extension\'s own words', () => {
  const reasons = consequentialReasons(read('<form method="post" action="/cart/checkout"><button id="t">Place order</button></form>'), ctx('click'));
  assert.deepEqual(reasons, ['it submits a form', 'it says "order"', 'its address says "checkout"']);
});

// ---------- allowances ----------

test('a chat allowance holds for that chat on that host, and no further', () => {
  let s = allowSite(EMPTY_ALLOWANCES, 'chat1', 'Shop.Example.com', false);
  assert.deepEqual(allowancesFor(s, 'chat1', 'shop.example.com'), { site: true, actions: [] });
  assert.equal(allowancesFor(s, 'chat2', 'shop.example.com').site, false);
  assert.equal(allowancesFor(s, 'chat1', 'other.example.com').site, false);
  assert.deepEqual(standingSites(s), []);
  s = allowAction(s, 'chat1', 'shop.example.com', 'click button "unsubscribe"');
  assert.deepEqual(allowancesFor(s, 'chat1', 'shop.example.com').actions, ['click button "unsubscribe"']);
  assert.deepEqual(allowancesFor(s, 'chat1', 'other.example.com').actions, []);
  assert.deepEqual(allowancesFor(s, 'chat2', 'shop.example.com').actions, []);
});

test('a standing allowance holds in every chat, and removing it takes every hold on the host', () => {
  let s = allowSite(EMPTY_ALLOWANCES, 'chat1', 'shop.example.com', true, 5);
  assert.equal(allowancesFor(s, 'chat9', 'shop.example.com').site, true);
  assert.deepEqual(standingSites(s), ['shop.example.com']);
  s = allowAction(s, 'chat1', 'shop.example.com', 'k');
  s = removeSite(s, 'SHOP.example.com');
  assert.deepEqual(allowancesFor(s, 'chat1', 'shop.example.com'), { site: false, actions: [] });
  assert.deepEqual(standingSites(s), []);
});

test('a standing site allowance does not stand for any named action', () => {
  const s = allowSite(EMPTY_ALLOWANCES, 'chat1', 'shop.example.com', true);
  assert.deepEqual(allowancesFor(s, 'chat2', 'shop.example.com').actions, []);
});

test('a deleted chat forgets its allowances and keeps the standing ones', () => {
  const s = forgetChat(allowSite(EMPTY_ALLOWANCES, 'chat1', 'a.com', true), 'chat1');
  assert.deepEqual(s.chats, {});
  assert.deepEqual(standingSites(s), ['a.com']);
  assert.equal(forgetChat(s, 'nobody'), s);
});

test('whatever is stored is read defensively, and junk allows nothing', () => {
  for (const raw of [undefined, null, 3, 'x', [], { sites: 'x', chats: 7 }]) assert.deepEqual(parseAllowances(raw), { sites: {}, chats: {} });
  const s = parseAllowances({ sites: { 'A.com': 1, 'b.com': 'yes' }, chats: { c: { sites: ['A.com', 3], actions: { 'A.com': ['k', 9], 'b.com': 'nope' } }, d: 'junk' } });
  assert.deepEqual(s.sites, { 'a.com': 1 });
  assert.deepEqual(s.chats.c, { sites: ['a.com'], actions: { 'a.com': ['k'] } });
  assert.deepEqual(s.chats.d, { sites: [], actions: {} });
});

test('storage: answers in quick succession both land, through a fake store', async () => {
  const data: Record<string, unknown> = {};
  let writes = 0;
  const store: AllowanceStore = {
    async get(key) {
      await new Promise((r) => setTimeout(r, 1));
      return { [key]: data[key] };
    },
    async set(items) {
      await new Promise((r) => setTimeout(r, 1));
      writes++;
      Object.assign(data, items);
    },
  };
  await Promise.all([updateAllowances((s) => allowSite(s, 'c', 'a.com', false), store), updateAllowances((s) => allowAction(s, 'c', 'a.com', 'k1'), store), updateAllowances((s) => allowAction(s, 'c', 'a.com', 'k2'), store)]);
  const out = await loadAllowances(store);
  assert.deepEqual(allowancesFor(out, 'c', 'a.com'), { site: true, actions: ['k1', 'k2'] });
  assert.equal(writes, 3);
  assert.ok(data[ALLOWANCES_KEY]);
  await updateAllowances((s) => s, store);
  assert.equal(writes, 3, 'nothing changed, nothing written');
});

test('check is a press: it cannot submit a form holding a password either', () => {
  const d = { role: 'button', name: 'Sign in', tag: 'button', pageUrl: 'https://a.test/', submits: true, form: { method: 'get', holds: 'password' }, fingerprint: { role: 'button', name: 'Sign in', tag: 'button' } } as unknown as Described;
  assert.match(neverReason(d, 'check') ?? '', /submits a form holding a password/);
  assert.equal(decide(d, { site: true, actions: [] }, { verb: 'check' }).kind, 'deny');
});
