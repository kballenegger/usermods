// The core of operating a page (lib/interact): names, refs and fingerprints, what the gate is given,
// the inventory, the delta and the action code.
//
// Parsed with linkedom, which has no layout. As in test/inspect.test.ts, the Probe below reads a box
// from data-box="x,y,w,h" and computed style from the inline style attribute, so the code that runs
// on a live page runs here on a page whose geometry the test states. What needs a real browser (a
// trusted click, focus, a shadow root's hit test) is in the `interact` smoke flow.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import type { Probe } from '../lib/inspect.ts';
import { describeElements } from '../lib/inspect.ts';
import { hitIsTarget, MAX_REPEAT, runStep, describeStep, type ActionDeps, type ActResult, type ActStep } from '../lib/interact/actions.ts';
import { newOperableAmong, renderDelta, tallyRecords, type Delta } from '../lib/interact/delta.ts';
import { describeGo, describeTarget, sensitiveField, signatureOf } from '../lib/interact/describe.ts';
import { formatRoleName, isOperable, landmarkOf, nameOf, parseRoleName, roleOf, stateOf } from '../lib/interact/name.ts';
import { createRegistry, fingerprintOf, fromAt, isRef, refPrefix, resolveFingerprint, stableSelector, toAt, type Registry } from '../lib/interact/registry.ts';
import { closestMatches, formatClosest, queryEverywhere, resolveSelector, resolveText, type TargetResult } from '../lib/interact/target.ts';
import { operableInventory } from '../lib/interact/view.ts';

Object.assign(globalThis, { CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) } });

const PAGE = 'https://shop.example.com/orders';

function load(html: string): Document {
  const w = parseHTML(`<html>${html}</html>`);
  const d = w.document as unknown as Document;
  Object.assign(globalThis, { document: d, HTMLElement: w.HTMLElement, HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, Event: w.Event, location: { href: PAGE } });
  return d;
}

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
    const [x, y, w, h] = (el.getAttribute('data-box') ?? '10,10,100,20').split(',').map(Number);
    return { x: x!, y: y!, w: w!, h: h! };
  },
  style(el) {
    const own = inline(el);
    return (p) => own[p] ?? '';
  },
  visible: (el) => !el.hasAttribute('hidden') && inline(el).display !== 'none',
  viewport: () => ({ w: 1000, h: 800, scrollY: 0, pageH: 3000 }),
};

const found = (r: TargetResult): Element => {
  assert.equal(r.kind, 'found', r.kind === 'broken' ? r.message : '');
  return (r as Extract<TargetResult, { kind: 'found' }>).el;
};
const broken = (r: TargetResult) => {
  assert.equal(r.kind, 'broken');
  return r as Extract<TargetResult, { kind: 'broken' }>;
};

// ---------- role and name ----------

test('a role is the one given, or the one the tag implies', () => {
  load(`<body>
    <a id="l" href="/x">x</a><a id="nl">x</a><button id="b">x</button><input id="t"><input id="c" type="checkbox"><input id="s" type="submit"><input id="q" type="search">
    <select id="sel"></select><select id="lb" multiple></select><textarea id="ta"></textarea><div id="ce" contenteditable="true"></div>
    <div id="r" role="button menuitem"></div><div id="none" role="presentation"></div>
    <section id="s1"></section><section id="s2" aria-label="Filters"></section></body>`);
  const role = (id: string) => roleOf(document.getElementById(id)!);
  assert.deepEqual(
    ['l', 'nl', 'b', 't', 'c', 's', 'q', 'sel', 'lb', 'ta', 'ce', 'r', 'none', 's1', 's2'].map(role),
    ['link', 'generic', 'button', 'textbox', 'checkbox', 'button', 'searchbox', 'combobox', 'listbox', 'textbox', 'textbox', 'button', 'generic', 'generic', 'region'],
  );
});

test('a name comes from aria-label, aria-labelledby, label, alt, title, placeholder, then text', () => {
  load(`<body>
    <button id="a" aria-label="Close dialog">x</button>
    <span id="lbl">Search <b>orders</b></span><input id="b" aria-labelledby="lbl">
    <label for="c">Email</label><input id="c" placeholder="you@example.com">
    <label>Wrapped <input id="d"></label>
    <a id="e" href="/"><img alt="Home"></a>
    <input id="f" placeholder="Filter">
    <button id="g">  Show
      more  </button>
    <input id="h" type="submit" value="Save draft">
    <button id="i"><svg><title>Delete row</title></svg></button>
  </body>`);
  const name = (id: string) => nameOf(document.getElementById(id)!);
  assert.deepEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(name), ['Close dialog', 'Search orders', 'Email', 'Wrapped', 'Home', 'Filter', 'Show more', 'Save draft', 'Delete row']);
});

test('a name never carries what somebody typed', () => {
  load(`<body>
    <input id="a" value="hunter2-typed" aria-label="Note">
    <input id="b" value="hunter2-typed">
    <textarea id="c">hunter2-typed</textarea>
    <div id="d" contenteditable="true">hunter2-typed</div>
    <div id="e" role="textbox">hunter2-typed</div>
    <select id="f"><option>hunter2-typed</option></select>
    <label>Pick <select id="g"><option>hunter2-typed</option></select></label>
  </body>`);
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) assert.doesNotMatch(nameOf(document.getElementById(id)!), /hunter2/, id);
});

test('a container is named by its label or heading, never by all the text inside it', () => {
  load(`<body>
    <form id="f"><h2>New expense</h2><p>a very long paragraph of instructions</p></form>
    <nav id="n" aria-label="Billing"><a href="/a">Invoices</a></nav>
    <table id="t"><caption>Orders</caption><tr id="r"><td>12 Sep</td><td>Headphones</td><td><a href="/1">View</a></td></tr></table>
    <main id="m">everything</main>
  </body>`);
  const name = (id: string) => nameOf(document.getElementById(id)!);
  assert.equal(name('f'), 'New expense');
  assert.equal(name('n'), 'Billing');
  assert.equal(name('t'), 'Orders');
  assert.equal(name('r'), '12 Sep · Headphones', 'a row is its cells, without the ones that hold a control');
  assert.equal(name('m'), '');
});

test('role and name print and parse back, quotes included', () => {
  assert.equal(formatRoleName('button', 'Save'), 'button "Save"');
  assert.equal(formatRoleName('main', ''), 'main');
  for (const [role, name] of [['button', 'Say "hi"'], ['form', 'New expense'], ['main', ''], ['link', 'back\\slash']] as const) {
    assert.deepEqual(parseRoleName(formatRoleName(role, name)), { role, name });
  }
});

test('the landmark is the nearest named place, across a shadow boundary', () => {
  const d = load(`<body><form aria-label="Outer"><div><button id="b">Go</button></div></form><nav aria-label="Top"><div id="host"></div></nav></body>`);
  assert.equal(landmarkOf(d.getElementById('b')!), 'form "Outer"');
  const sr = d.getElementById('host')!.attachShadow({ mode: 'open' });
  sr.innerHTML = '<button id="inner">In</button>';
  assert.equal(landmarkOf(sr.querySelector('#inner')!), 'navigation "Top"');
});

test('operable: controls, roles, tabindex, and cursor:pointer only where it starts', () => {
  load(`<body>
    <a id="link" href="/">x</a><a id="anchor">x</a><input id="hidden" type="hidden"><input id="field">
    <div id="role" role="tab"></div><div id="tab" tabindex="0"></div><div id="tabm" tabindex="-1"></div><div id="ce" contenteditable></div>
    <div id="card" style="cursor:pointer"><span id="inherited" style="cursor:pointer">x</span></div>
    <div id="wrap" style="cursor:pointer"><a href="/" id="inner">x</a></div>
    <label id="lab" style="cursor:pointer">x</label><p id="p">x</p>
    <div id="ours" role="button" data-usermods="bar"></div>
  </body>`);
  const op = (id: string) => isOperable(document.getElementById(id)!, probe);
  assert.deepEqual(
    ['link', 'field', 'role', 'tab', 'ce', 'card', 'inner'].map(op),
    [true, true, true, true, true, true, true],
  );
  assert.deepEqual(['anchor', 'hidden', 'tabm', 'inherited', 'wrap', 'lab', 'p', 'ours'].map(op), [false, false, false, false, false, false, false, false]);
});

test('state comes from native attributes and aria', () => {
  load(`<body><fieldset disabled><button id="a">x</button></fieldset><input id="b" type="checkbox" checked><div id="c" role="tab" aria-selected="true" aria-current="page"></div><button id="d" aria-expanded="true" aria-disabled="true"></button></body>`);
  assert.deepEqual(stateOf(document.getElementById('a')!), ['disabled']);
  assert.deepEqual(stateOf(document.getElementById('b')!), ['checked']);
  assert.deepEqual(stateOf(document.getElementById('c')!), ['selected', 'current']);
  assert.deepEqual(stateOf(document.getElementById('d')!), ['disabled', 'expanded']);
});

// ---------- searching ----------

test('a selector is searched in every root: a second match in a shadow root is a second match', () => {
  const d = load('<body><button class="x">One</button><div id="host"></div><div id="ours" data-usermods="hint" class="x"></div></body>');
  const sr = d.getElementById('host')!.attachShadow({ mode: 'open' });
  sr.innerHTML = '<button class="x">Two</button><button class="y">Three</button>';
  assert.equal(queryEverywhere('.x').length, 2, 'our own UI is not part of the page');
  const reg = createRegistry(1, { probe });
  const r = broken(resolveSelector('.x', { refOf: reg.refFor }));
  assert.equal(r.reason, 'several');
  assert.match(r.message, /2 elements match "\.x": button "One" \[ref=k\w+e1\], button "Two" \[ref=k\w+e2\]/);
  assert.equal(nameOf(found(resolveSelector('.y'))), 'Three');
  assert.equal(broken(resolveSelector('.nope')).reason, 'none');
  assert.equal(broken(resolveSelector('[[')).reason, 'invalid');
});

test('a same-origin frame is searched, and a cross-origin one is skipped without throwing', () => {
  const d = load('<body><iframe id="same"></iframe><iframe id="cross"></iframe></body>');
  const inner = parseHTML('<html><body><button id="in">Framed</button></body></html>').document as unknown as Document;
  Object.defineProperty(d.getElementById('same')!, 'contentDocument', { value: inner });
  Object.defineProperty(d.getElementById('cross')!, 'contentDocument', {
    get() {
      throw new Error('SecurityError');
    },
  });
  assert.equal(queryEverywhere('#in').length, 1);
});

test('text resolves to the control around it, once', () => {
  load('<body><a href="/a"><span>Cancel plan</span></a><p>Plain words</p><button>Dup</button><button>Dup</button></body>');
  assert.equal(found(resolveText('cancel plan', { probe })).tagName, 'A');
  assert.equal(found(resolveText('plain', { probe })).tagName, 'P');
  assert.equal(broken(resolveText('dup', { probe })).reason, 'several');
  assert.equal(broken(resolveText('nope', { probe })).reason, 'none');
});

test('the closest matches rank a shared word over a shared role, and fold in the sentence', () => {
  load(`<body><nav aria-label="Billing"><a href="/a" id="a">Export CSV</a><button>Export PDF</button><button>Export ZIP</button></nav><button>Sign out</button><button>Help</button></body>`);
  const close = closestMatches({ role: 'button', name: 'Export' }, { probe });
  assert.deepEqual(close.slice(0, 3).map((c) => c.name), ['Export PDF', 'Export ZIP', 'Export CSV']);
  assert.ok(!close.some((c) => c.name === 'Sign out' && close.indexOf(c) < 3));
  assert.equal(formatClosest(close.slice(0, 2)), '2 buttons in navigation "Billing"');
  assert.equal(formatClosest(close.slice(2, 3)), 'link "Export CSV" in navigation "Billing"');
});

// ---------- refs ----------

test('a ref prefix is a function of the document, and a ref is told from a selector', () => {
  assert.equal(refPrefix(1234.5), refPrefix(1234.5));
  assert.notEqual(refPrefix(1234.5), refPrefix(1234.6));
  assert.ok(isRef('k3e14'));
  assert.ok(isRef('keee7'), 'a prefix can hold an e: the counter is what follows the last one');
  for (const s of ['button', '.k3e14', 'k3e', '#k3e1']) assert.ok(!isRef(s), s);
});

test('an element keeps its ref across calls, and a ref from another document is stale', () => {
  load('<body><button id="a">A</button><button id="b">B</button></body>');
  const reg = createRegistry(100, { probe });
  const a = document.getElementById('a')!;
  const ref = reg.refFor(a);
  assert.equal(reg.refFor(document.getElementById('b')!) === ref, false);
  assert.equal(reg.refFor(a), ref);
  assert.equal(found(reg.resolve({ ref })), a);
  const next = createRegistry(200, { probe });
  assert.ok(next.prefix !== reg.prefix);
  assert.equal(broken(next.resolve({ ref })).reason, 'stale');
  assert.equal(broken(reg.resolve({ ref: `${reg.prefix}e99` })).reason, 'none');
});

test('a re-rendered element rebinds its ref when exactly one match reads the same', () => {
  const d = load('<body><div id="row"><button id="old" class="save">Save</button></div></body>');
  const reg = createRegistry(1, { probe });
  const ref = reg.refFor(d.getElementById('old')!);
  d.getElementById('row')!.innerHTML = '<button id="new" class="save">Save</button>';
  const r = reg.resolve({ ref });
  assert.equal(found(r), d.getElementById('new'));
  assert.equal((r as { rebound?: boolean }).rebound, true);
  assert.equal(found(reg.resolve({ ref })), d.getElementById('new'), 'the ref now names the new element');
});

test('a re-rendered element with no match, or two, is an error that names it', () => {
  const d = load('<body><div id="row"><button id="old">Save</button></div></body>');
  const reg = createRegistry(1, { probe });
  const ref = reg.refFor(d.getElementById('old')!);
  d.getElementById('row')!.innerHTML = '<button>Publish</button>';
  let r = broken(reg.resolve({ ref }));
  assert.equal(r.reason, 'none');
  assert.match(r.message, /button "Save"/);
  assert.match(r.message, /find_elements/);
  d.getElementById('row')!.innerHTML = '<button>Save</button><button>Save</button>';
  r = broken(reg.resolve({ ref }));
  assert.equal(r.reason, 'several');
});

// ---------- fingerprints and the strict replay ----------

test('the selector kept is the most durable unique one, and never a value', () => {
  load(`<body>
    <input id="merchant" name="m" value="hunter2-typed">
    <input id="a123456" name="amount" value="hunter2-typed">
    <button data-testid="save">Save</button>
    <button aria-label="Close">x</button><div class="row"><button class="go">Go</button></div><div class="row"><button class="go">Go</button></div>
  </body>`);
  assert.equal(stableSelector(document.querySelector('#merchant')!), '#merchant');
  assert.equal(stableSelector(document.querySelector('[name=amount]')!), 'input[name="amount"]', 'a generated id is passed over');
  assert.equal(stableSelector(document.querySelector('[data-testid]')!), 'button[data-testid="save"]');
  assert.equal(stableSelector(document.querySelector('[aria-label]')!), 'button[aria-label="Close"]');
  const at = JSON.stringify(toAt(fingerprintOf(document.querySelector('[name=amount]')!, { probe })));
  assert.doesNotMatch(at, /hunter2/);
});

test('a fingerprint serialises to the at map and back', () => {
  load('<body><form aria-label="New expense"><input id="m" aria-label="Merchant"></form></body>');
  const fp = fingerprintOf(document.getElementById('m')!, { probe, withNth: true });
  const at = toAt(fp);
  assert.deepEqual(at, { css: '#m', in: 'form "New expense"' }, 'nth only when it matters');
  assert.deepEqual(fromAt(at, fp.role, fp.name), { role: 'textbox', name: 'Merchant', tag: '', css: '#m', landmark: 'form "New expense"' });
  assert.deepEqual(fromAt({ css: 3 as unknown as string, nth: -1 }, 'button', 'x'), { role: 'button', name: 'x', tag: '' }, 'a hand-edited file loses the part that is malformed');
});

test('nth is recorded when several read the same, and picks the right one back', () => {
  load('<body><table aria-label="T"><tr><td><button class="u">Unsubscribe</button></td></tr><tr><td><button class="u">Unsubscribe</button></td></tr></table></body>');
  const second = document.querySelectorAll('button')[1]!;
  const fp = fingerprintOf(second, { probe, withNth: true });
  assert.equal(fp.nth, 1);
  assert.equal(found(resolveFingerprint(fromAt(toAt(fp), fp.role, fp.name), { probe })), second);
  const withoutNth = fromAt({ css: 'button.u' }, 'button', 'Unsubscribe');
  assert.equal(broken(resolveFingerprint(withoutNth, { probe })).reason, 'several');
});

test('the replay binds on role and name when the selector still reads right', () => {
  load('<body><form aria-label="F"><button id="s">Save</button></form></body>');
  assert.equal(found(resolveFingerprint(fromAt({ css: '#s', in: 'form "F"' }, 'button', 'Save'), { probe })), document.getElementById('s'));
});

test('a button now reading something else is a distinct result, whatever the selector says', () => {
  load('<body><form aria-label="F"><button id="s">Delete</button></form></body>');
  const r = broken(resolveFingerprint(fromAt({ css: '#s' }, 'button', 'Save'), { probe }));
  assert.equal(r.reason, 'changed');
  assert.deepEqual(r.recorded, { role: 'button', name: 'Save' });
  assert.deepEqual(r.live, { role: 'button', name: 'Delete' });
  assert.match(r.message, /button "Save" now reads button "Delete"/);
});

test('a live role that differs is as broken as a name that differs', () => {
  load('<body><a id="s" href="/x">Save</a></body>');
  const r = broken(resolveFingerprint(fromAt({ css: '#s' }, 'button', 'Save'), { probe }));
  assert.equal(r.reason, 'changed');
  assert.deepEqual(r.live, { role: 'link', name: 'Save' });
});

test('a selector that drifted onto a neighbour does not win over the real control', () => {
  load('<body><div class="a"><button id="drift">Delete</button></div><nav aria-label="N"><button id="real">Save</button></nav></body>');
  assert.equal(found(resolveFingerprint(fromAt({ css: '.a button' }, 'button', 'Save'), { probe })), document.getElementById('real'));
});

test('nothing left is a none result carrying the closest matches', () => {
  load('<body><nav aria-label="Billing"><button>Export PDF</button><button>Export ZIP</button></nav><p>x</p></body>');
  const r = broken(resolveFingerprint(fromAt({ css: '#gone' }, 'button', 'Export'), { probe }));
  assert.equal(r.reason, 'none');
  assert.equal(r.closest.length, 2);
  assert.equal(r.message, 'could not find button "Export" (0 matches; closest: 2 buttons in navigation "Billing")');
});

test('a hidden match does not bind', () => {
  load('<body><button id="s" hidden>Save</button></body>');
  assert.equal(broken(resolveFingerprint(fromAt({ css: '#s' }, 'button', 'Save'), { probe })).reason, 'none');
});

// ---------- what the gate is given ----------

test('a never-list field is recognised by type, autocomplete and what it says about itself', () => {
  load(`<body>
    <input id="p1" type="password"><input id="p2" autocomplete="current-password"><input id="p3" name="user_password"><input id="p4" placeholder="Passcode">
    <input id="o1" autocomplete="one-time-code"><input id="o2" name="otp_code"><input id="o3" aria-label="Verification code">
    <input id="c1" autocomplete="cc-number"><input id="c2" name="cardNumber"><input id="c3" placeholder="CVV"><select id="c4" autocomplete="cc-exp-month"></select>
    <input id="n1" name="email"><input id="n2" name="cc" aria-label="Cc"><input id="n3" type="checkbox" name="password_remember"><button id="n4">Password help</button><input id="n5" name="order_notes">
  </body>`);
  const kind = (id: string) => sensitiveField(document.getElementById(id)!);
  for (const id of ['p1', 'p2', 'p3', 'p4']) assert.equal(kind(id), 'password', id);
  for (const id of ['o1', 'o2', 'o3']) assert.equal(kind(id), 'one-time code', id);
  for (const id of ['c1', 'c2', 'c3', 'c4']) assert.equal(kind(id), 'card', id);
  for (const id of ['n1', 'n2', 'n3', 'n4', 'n5']) assert.equal(kind(id), undefined, id);
});

test('form facts come from attributes, so a field named method cannot clobber them', () => {
  load(`<body><form method="POST" action="/cart/checkout" id="f"><input name="method" value="get"><input name="action"><button id="go">Go</button><button id="plain" type="button">Add</button></form></body>`);
  const d = describeTarget(document.getElementById('go')!, { probe, pageUrl: PAGE });
  assert.equal(d.submits, true);
  assert.deepEqual(d.form, { method: 'post', action: '/cart/checkout' });
  const plain = describeTarget(document.getElementById('plain')!, { probe, pageUrl: PAGE });
  assert.equal(plain.submits, undefined);
});

test('a form with no method is GET, and a submitter can override it', () => {
  load(`<body><form><button id="a">Search</button></form><form><button id="b" formmethod="post" formaction="/x/delete">Search</button></form></body>`);
  assert.equal(describeTarget(document.getElementById('a')!, { probe, pageUrl: PAGE }).form?.method, 'get');
  const b = describeTarget(document.getElementById('b')!, { probe, pageUrl: PAGE });
  assert.equal(b.form?.method, 'post');
  assert.equal(b.form?.action, '/x/delete');
});

test('a form holding a password says so on every control in it, by id too', () => {
  load(`<body><form id="login"><input id="u" name="username"><button id="s">Sign in</button></form><input id="outside" type="password" form="login"></body>`);
  assert.equal(describeTarget(document.getElementById('s')!, { probe, pageUrl: PAGE }).form?.holds, 'password');
  assert.equal(describeTarget(document.getElementById('u')!, { probe, pageUrl: PAGE }).form?.holds, 'password');
});

test('a click on an icon inside a button describes the button', () => {
  load(`<body><form method="post"><button id="b"><span id="icon">Pay now</span></button></form></body>`);
  const d = describeTarget(document.getElementById('icon')!, { probe, pageUrl: PAGE });
  assert.equal(d.role, 'button');
  assert.equal(d.name, 'Pay now');
  assert.equal(d.submits, true);
});

test('a label saying one thing and a control showing another keeps both', () => {
  load(`<body><button id="b" aria-label="Details">Delete account</button><button id="c" aria-label="Same">Same</button></body>`);
  const d = describeTarget(document.getElementById('b')!, { probe, pageUrl: PAGE });
  assert.equal(d.name, 'Details');
  assert.equal(d.text, 'Delete account');
  assert.equal(describeTarget(document.getElementById('c')!, { probe, pageUrl: PAGE }).text, undefined);
});

test('a link describes its absolute target and its path', () => {
  load(`<body><a id="a" href="/account/delete?x=1">Settings</a></body>`);
  assert.deepEqual(describeTarget(document.getElementById('a')!, { probe, pageUrl: PAGE }).link, { href: 'https://shop.example.com/account/delete?x=1', path: '/account/delete' });
});

test('the description of a field holds no value, not even as its text', () => {
  load(`<body><input id="a" value="hunter2-typed" aria-label="Note"><textarea id="b">hunter2-typed</textarea><div id="c" contenteditable>hunter2-typed</div></body>`);
  for (const id of ['a', 'b', 'c']) assert.doesNotMatch(JSON.stringify(describeTarget(document.getElementById(id)!, { probe, pageUrl: PAGE })), /hunter2/, id);
});

test('the signature changes when a control is renamed or rebuilt, and not otherwise', () => {
  const d = load(`<body><form method="post" id="f"><button id="b">Save</button></form></body>`);
  const b = d.getElementById('b')!;
  const sig = () => signatureOf(describeTarget(b, { probe, pageUrl: PAGE }));
  const first = sig();
  assert.equal(sig(), first);
  b.textContent = 'Delete';
  assert.notEqual(sig(), first);
  b.textContent = 'Save';
  assert.equal(sig(), first);
  d.getElementById('f')!.setAttribute('method', 'get');
  assert.notEqual(sig(), first);
});

test('a go step describes where it goes', () => {
  assert.deepEqual(describeGo('/orders?page=2', PAGE).go, { kind: 'url', href: 'https://shop.example.com/orders?page=2', path: '/orders', host: 'shop.example.com' });
  assert.deepEqual(describeGo('back', PAGE).go, { kind: 'back' });
  assert.equal((describeGo('javascript:alert(1)', PAGE).go as { href: string }).href, 'javascript:alert(1)');
});

// ---------- the inventory ----------

test('the inventory nests under landmarks and rows, with refs, state, values and URLs', () => {
  load(`<body>
    <nav aria-label="Pagination"><a href="https://shop.example.com/orders?page=2">Next page</a></nav>
    <table aria-label="Orders"><tr><td>12 Sep</td><td>€89.00</td><td><a href="/orders/1182">View order</a></td><td><button>Buy again</button></td></tr></table>
    <input type="search" aria-label="Search orders">
    <input type="checkbox" checked aria-label="Remember">
    <button disabled>Later</button>
  </body>`);
  const reg = createRegistry(1, { probe });
  const out = operableInventory({ refOf: reg.refFor, probe, pageUrl: PAGE }).replaceAll(reg.prefix, 'k3');
  assert.equal(
    out,
    [
      '- navigation "Pagination"',
      '  - link "Next page" [ref=k3e1] → /orders?page=2',
      '- table "Orders"',
      '  - row "12 Sep · €89.00"',
      '    - link "View order" [ref=k3e2] → /orders/1182',
      '    - button "Buy again" [ref=k3e3]',
      '- searchbox "Search orders" [ref=k3e4] value=(empty)',
      '- checkbox "Remember" [ref=k3e5] [checked]',
      '- button "Later" [ref=k3e6] [disabled]',
    ].join('\n'),
  );
});

test('the inventory never prints a field value, and says whether it holds one', () => {
  load(`<body><input aria-label="Plain" value="hunter2-typed"><input type="password" aria-label="Pass" value="hunter2-typed"><textarea aria-label="Area">hunter2-typed</textarea><div contenteditable aria-label="Rich">hunter2-typed</div><select aria-label="Pick"><option>Express</option></select></body>`);
  const out = operableInventory({ refOf: () => 'k1e1', probe });
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /textbox "Plain" \[ref=k1e1\] value=\(filled\)/);
  assert.match(out, /combobox "Pick" \[ref=k1e1\] value="Express"/, 'a select option is the page\'s own word');
});

test('the inventory lists the viewport first, keeps page order, and counts what it cut', () => {
  const rows = Array.from({ length: 40 }, (_, i) => `<button data-box="0,${2000 + i * 30},100,20">Below ${i}</button>`).join('');
  load(`<body>${rows}<button data-box="0,10,100,20">On screen</button></body>`);
  const out = operableInventory({ refOf: () => 'k1e1', probe, maxChars: 200 });
  const lines = out.split('\n');
  assert.ok(lines.some((l) => l.includes('On screen')), 'the element in view makes the budget however late it is in the page');
  assert.match(lines.at(-1)!, /^… \d+ more below the fold: narrow the scope, or scroll$/);
  assert.ok(out.length < 280, `the budget holds: ${out.length}`);
  assert.ok(lines.findIndex((l) => l.includes('Below 0')) < lines.findIndex((l) => l.includes('On screen')), 'what is kept is printed in page order');
});

test('the inventory can be scoped, and says when there is nothing', () => {
  load(`<body><div id="a"><button>In</button></div><button>Out</button><div id="empty"></div></body>`);
  const scoped = operableInventory({ refOf: () => 'k1e1', probe, scope: document.getElementById('a')! });
  assert.match(scoped, /In/);
  assert.doesNotMatch(scoped, /Out/);
  assert.equal(operableInventory({ refOf: () => 'k1e1', probe, scope: document.getElementById('empty')! }), 'Nothing to operate here.');
});

test('hidden controls and our own UI stay out of the inventory', () => {
  load(`<body><button hidden>Gone</button><button style="display:none">Gone2</button><button data-usermods="bar">Mine</button><button>Here</button></body>`);
  const out = operableInventory({ refOf: () => 'k1e1', probe });
  assert.equal(out, '- button "Here" [ref=k1e1]');
});

test('find_elements carries a ref only when a registry is passed', () => {
  load('<body><button id="a">Go</button></body>');
  assert.doesNotMatch(describeElements('#a', 5, undefined, {}, probe), /ref=/);
  const reg = createRegistry(1, { probe });
  const with_ = describeElements('#a', 5, undefined, { refOf: reg.refFor }, probe);
  assert.match(with_, new RegExp(`^1\\. #a \\[stable: id\\] ref=${reg.prefix}e1 \\[`, 'm'));
});

// ---------- the delta ----------

const el = (html: string) => parseHTML(`<html><body>${html}</body></html>`).document.body.firstChild as unknown as Element;

test('the tally counts by name, as the wrapper does, and leaves our own UI out', () => {
  const reply = el('<div class="reply"></div>');
  const ours = el('<div data-usermods="bar"></div>');
  const body = el('<div id="b"></div>');
  const none = [] as unknown as NodeList;
  const dom = tallyRecords([
    { type: 'childList', target: body, attributeName: null, addedNodes: [reply, reply, ours] as unknown as NodeList, removedNodes: none },
    { type: 'attributes', target: body, attributeName: 'class', addedNodes: none, removedNodes: none },
    { type: 'attributes', target: ours, attributeName: 'class', addedNodes: none, removedNodes: none },
  ]);
  assert.deepEqual([dom.added, dom.removed, dom.attributes], [2, 0, 1]);
  assert.deepEqual(dom.targets?.added, [['div.reply', 2]]);
  assert.deepEqual(dom.targets?.attributes, [['div#b', ['class'], 1]]);
});

test('new controls are named, nested ones too, with a removed one left out', () => {
  const d = load('<body><div id="r"><a href="/1">permalink</a><button>Reply</button></div><div id="s"><button>Reply</button></div></body>');
  const gone = d.createElement('button');
  gone.textContent = 'Gone';
  assert.deepEqual(newOperableAmong([d.getElementById('r')!, d.getElementById('s')!, gone], probe), [['button "Reply"', 2], ['link "permalink"', 1]]);
});

test('the delta reads in one sentence, and says when nothing moved', () => {
  const base: Delta = { dom: { added: 0, removed: 0, attributes: 0 }, urlBefore: PAGE, urlAfter: PAGE, newOperable: [] };
  assert.equal(renderDelta(base), 'DOM: nothing changed. URL unchanged.');
  const out = renderDelta({
    ...base,
    urlAfter: `${PAGE}?p=2`,
    dom: { added: 120, removed: 0, attributes: 0, targets: { added: [['div.reply', 120]], removed: [], attributes: [] } },
    newOperable: [['link "permalink"', 120], ['button "Reply"', 120]],
  });
  assert.equal(out, `DOM: 0 removed, 120 added (div.reply ×120), 0 attributes changed. URL is now ${PAGE}?p=2.\nNew: link "permalink" ×120, button "Reply" ×120. find_elements to get refs.`);
});

// ---------- the action code ----------

/** A clock a repeat's waiting can run on without taking real time. */
function clock() {
  let t = 1000;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

function deps(reg: Registry, over: Partial<ActionDeps> = {}): ActionDeps {
  const c = clock();
  return {
    registry: reg,
    probe,
    pageUrl: PAGE,
    now: c.now,
    sleep: c.sleep,
    nextFrame: async () => {},
    hit: () => null,
    watch: () => ({ finish: () => ({ dom: { added: 0, removed: 0, attributes: 0 }, urlBefore: PAGE, urlAfter: PAGE, newOperable: [] }) }),
    ...over,
  };
}

/** Describe, then act with the signature that came back: the path every real step takes. */
async function act(step: ActStep, d: ActionDeps): Promise<ActResult> {
  const read = describeStep(step, d);
  assert.ok(read.ok, !read.ok ? read.message : '');
  return runStep(step, read.ok ? read.signature : '', d);
}

/** Record every event that reaches `target`, in order. */
function record(target: Element, types: string[]): string[] {
  const seen: string[] = [];
  for (const t of types) target.addEventListener(t, () => seen.push(t));
  return seen;
}

test('a click is the whole pointer sequence, in order, and clicks once', async () => {
  load('<body><button id="b" data-box="100,50,80,20">Go</button></body>');
  const b = document.getElementById('b')!;
  const seen = record(b, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  const reg = createRegistry(1, { probe });
  const r = await act({ target: { ref: reg.refFor(b) }, do: 'click' }, deps(reg));
  assert.deepEqual(seen, ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  assert.ok(r.ok);
  if (r.ok) {
    assert.match(r.text, new RegExp(`^Clicked button "Go" \\(${reg.prefix}e1\\)\\.\\nDOM: nothing changed\\. URL unchanged\\.$`));
    assert.equal(r.clicks, 1);
  }
});

test('an element that is covered is reported by what covers it, and is not clicked', async () => {
  load('<body><button id="b">Apply</button><div id="wall" class="cookie-wall"></div></body>');
  const b = document.getElementById('b')!;
  const seen = record(b, ['click', 'pointerdown']);
  const reg = createRegistry(1, { probe });
  const r = await act({ target: { ref: reg.refFor(b) }, do: 'click' }, deps(reg, { hit: () => document.getElementById('wall') }));
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'covered');
  assert.match(!r.ok ? r.message : '', /covered by div#wall/);
  assert.deepEqual(seen, []);
});

test('a hit on the target, inside it or on its label is the target; our own bar over it is no obstacle', () => {
  load('<body><button id="b"><span id="s">x</span></button><label for="i" id="l">L</label><input id="i"><div id="o"></div><div id="bar" data-usermods="bar"></div></body>');
  const by = (id: string) => document.getElementById(id)!;
  assert.ok(hitIsTarget(by('b'), by('s')));
  assert.ok(hitIsTarget(by('i'), by('l')));
  assert.ok(hitIsTarget(by('b'), by('bar')));
  assert.ok(!hitIsTarget(by('b'), by('o')));
});

test('hidden, disabled and moving elements fail by name, before any event', async () => {
  load('<body><button id="h" hidden>H</button><button id="d" disabled>D</button><button id="m">M</button></body>');
  const reg = createRegistry(1, { probe });
  const fired: string[] = [];
  for (const id of ['h', 'd', 'm']) document.getElementById(id)!.addEventListener('click', () => fired.push(id));
  const code = async (id: string, over: Partial<ActionDeps> = {}) => {
    const r = await act({ target: { ref: reg.refFor(document.getElementById(id)!) }, do: 'click' }, deps(reg, over));
    return r.ok ? 'ok' : r.code;
  };
  assert.equal(await code('h'), 'hidden');
  assert.equal(await code('d'), 'disabled');
  let n = 0;
  const c = clock();
  const moving: Probe = { ...probe, box: () => ({ x: n++, y: 0, w: 10, h: 10 }) };
  assert.equal(await code('m', { probe: moving, now: c.now, nextFrame: () => c.sleep(100) }), 'unstable');
  assert.deepEqual(fired, []);
});

test('a target that changed after it was checked is refused, and nothing fires', async () => {
  load('<body><button id="b">Save</button></body>');
  const b = document.getElementById('b')!;
  const reg = createRegistry(1, { probe });
  const d = deps(reg);
  const step: ActStep = { target: { ref: reg.refFor(b) }, do: 'click' };
  const read = describeStep(step, d);
  assert.ok(read.ok);
  const seen = record(b, ['click']);
  b.textContent = 'Delete account';
  const r = await runStep(step, read.ok ? read.signature : '', d);
  assert.equal(r.ok, false);
  assert.equal(!r.ok && r.code, 'changed');
  assert.match(!r.ok ? r.message : '', /now reads button "Delete account"/);
  assert.deepEqual(seen, []);
});

test('a step with no signature, or a made-up one, does not run', async () => {
  load('<body><button id="b">Save</button></body>');
  const b = document.getElementById('b')!;
  const reg = createRegistry(1, { probe });
  const seen = record(b, ['click']);
  const r = await runStep({ target: { ref: reg.refFor(b) }, do: 'click' }, '', deps(reg));
  assert.equal(!r.ok && r.code, 'changed');
  assert.deepEqual(seen, []);
});

test('the never list holds in the page, whatever the signature says', async () => {
  load(`<body>
    <form id="login"><input id="u" name="username"><input id="p" type="password" value=""><button id="go">Sign in</button></form>
    <input id="otp" autocomplete="one-time-code"><input id="card" autocomplete="cc-number">
  </body>`);
  const reg = createRegistry(1, { probe });
  const by = (id: string) => ({ ref: reg.refFor(document.getElementById(id)!) });
  const code = async (step: ActStep) => {
    const r = await act(step, deps(reg));
    return r.ok ? 'ok' : r.code;
  };
  const submits = record(document.getElementById('go')!, ['click']);
  assert.equal(await code({ target: by('p'), do: 'fill', text: 'hunter2-typed' }), 'never');
  assert.equal((document.getElementById('p') as HTMLInputElement).value, '');
  assert.equal(await code({ target: by('otp'), do: 'fill', text: '123456' }), 'never');
  assert.equal(await code({ target: by('card'), do: 'fill', text: '4242' }), 'never');
  assert.equal(await code({ target: by('p'), do: 'press', text: 'a' }), 'never');
  assert.equal(await code({ target: by('go'), do: 'click' }), 'never');
  assert.equal(await code({ target: by('u'), do: 'press', text: 'Enter' }), 'never');
  assert.deepEqual(submits, []);
  assert.equal(await code({ target: by('u'), do: 'fill', text: 'kenneth' }), 'ok', 'a username beside it is an ordinary field');
});

test('never on a browser or extension page, on any verb', async () => {
  load('<body><button id="b">Go</button></body>');
  const reg = createRegistry(1, { probe });
  for (const pageUrl of ['chrome://settings/', 'chrome-extension://abc/page.html', 'about:blank']) {
    const r = await act({ target: { ref: reg.refFor(document.getElementById('b')!) }, do: 'click' }, deps(reg, { pageUrl }));
    assert.equal(!r.ok && r.code, 'never', pageUrl);
  }
});

test('filling reads back, and what was typed appears in no result', async () => {
  load('<body><input id="e" aria-label="Email"></body>');
  const reg = createRegistry(1, { probe });
  const e = document.getElementById('e') as HTMLInputElement;
  const seen = record(e, ['input', 'change']);
  const r = await act({ target: { ref: reg.refFor(e) }, do: 'fill', text: 'hunter2-typed' }, deps(reg));
  assert.equal(e.value, 'hunter2-typed');
  assert.deepEqual(seen, ['input', 'change']);
  assert.ok(r.ok);
  assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  assert.match(r.ok ? r.text : '', /^Filled textbox "Email"/);
});

test('a field that will not keep the text fails, without saying what the text was', async () => {
  load('<body><input id="e" aria-label="Masked"></body>');
  const reg = createRegistry(1, { probe });
  const e = document.getElementById('e') as HTMLInputElement;
  // A masked input rewriting whatever arrives, which no synthetic route gets past.
  const proto = Object.getPrototypeOf(e) as { value: string };
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')!;
  Object.defineProperty(e, 'value', { get: () => desc.get!.call(e) as string, set: () => {} });
  const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  Object.defineProperty(HTMLInputElement.prototype, 'value', { ...native, set: () => {} });
  try {
    const r = await act({ target: { ref: reg.refFor(e) }, do: 'fill', text: 'hunter2-typed' }, deps(reg));
    assert.equal(!r.ok && r.code, 'readback');
    assert.doesNotMatch(JSON.stringify(r), /hunter2/);
  } finally {
    Object.defineProperty(HTMLInputElement.prototype, 'value', native!);
  }
});

test('fill refuses what is not a text field', async () => {
  load('<body><input id="c" type="checkbox" aria-label="C"><button id="b">B</button></body>');
  const reg = createRegistry(1, { probe });
  for (const id of ['c', 'b']) {
    const r = await act({ target: { ref: reg.refFor(document.getElementById(id)!) }, do: 'fill', text: 'x' }, deps(reg));
    assert.equal(!r.ok && r.code, 'unsupported', id);
  }
});

test('select chooses by label or value, says which, and refuses a custom list', async () => {
  load('<body><select id="s" aria-label="Delivery"><option value="std">Standard</option><option value="exp">Express</option></select><div id="c" role="combobox" aria-label="Fancy"></div></body>');
  const reg = createRegistry(1, { probe });
  const s = document.getElementById('s') as HTMLSelectElement;
  const seen = record(s, ['change']);
  let r = await act({ target: { ref: reg.refFor(s) }, do: 'select', text: 'express' }, deps(reg));
  assert.ok(r.ok);
  assert.equal(s.value, 'exp');
  assert.deepEqual(seen, ['change']);
  assert.match(r.ok ? r.text : '', /^Chose "Express" in combobox "Delivery"/);
  r = await act({ target: { ref: reg.refFor(s) }, do: 'select', text: 'std' }, deps(reg));
  assert.equal(s.value, 'std');
  r = await act({ target: { ref: reg.refFor(s) }, do: 'select', text: 'nope' }, deps(reg));
  assert.equal(!r.ok && r.code, 'unsupported');
  r = await act({ target: { ref: reg.refFor(document.getElementById('c')!) }, do: 'select', text: 'x' }, deps(reg));
  assert.equal(!r.ok && r.code, 'unsupported');
});

test('check presses only when it needs to, and says when the control did not change', async () => {
  load('<body><div id="on" role="checkbox" aria-checked="false" aria-label="T"></div><div id="dead" role="checkbox" aria-checked="false" aria-label="D"></div></body>');
  const reg = createRegistry(1, { probe });
  const on = document.getElementById('on')!;
  let clicks = 0;
  on.addEventListener('click', () => {
    clicks++;
    on.setAttribute('aria-checked', on.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
  const step = (text?: string): ActStep => ({ target: { ref: reg.refFor(on) }, do: 'check', ...(text ? { text } : {}) });
  assert.ok((await act(step(), deps(reg))).ok);
  assert.equal(clicks, 1);
  assert.ok((await act(step(), deps(reg))).ok, 'already on');
  assert.equal(clicks, 1);
  assert.ok((await act(step('off'), deps(reg))).ok);
  assert.equal(on.getAttribute('aria-checked'), 'false');
  const r = await act({ target: { ref: reg.refFor(document.getElementById('dead')!) }, do: 'check' }, deps(reg));
  assert.equal(!r.ok && r.code, 'readback');
});

test('Enter in a form field submits through the form; a page that took the key keeps it', async () => {
  load(`<body><form id="f"><input id="q" aria-label="Search"></form></body>`);
  const reg = createRegistry(1, { probe });
  const f = document.getElementById('f') as HTMLFormElement;
  let submitted = 0;
  Object.getPrototypeOf(f).requestSubmit = function () {
    submitted++;
  };
  const q = document.getElementById('q')!;
  const seen = record(q, ['keydown', 'keyup']);
  const r = await act({ target: { ref: reg.refFor(q) }, do: 'press', text: 'enter' }, deps(reg));
  assert.ok(r.ok);
  assert.equal(submitted, 1);
  assert.deepEqual(seen, ['keydown', 'keyup']);
  assert.match(r.ok ? r.text : '', /^Pressed Enter in textbox "Search"/);
  q.addEventListener('keydown', (e) => e.preventDefault());
  await act({ target: { ref: reg.refFor(q) }, do: 'press', text: 'Enter' }, deps(reg));
  assert.equal(submitted, 1);
  delete Object.getPrototypeOf(f).requestSubmit;
});

test('a new-tab link is retargeted for the click and put back', async () => {
  load('<body><a id="a" href="/x" target="_blank">Open</a></body>');
  const a = document.getElementById('a')!;
  const reg = createRegistry(1, { probe });
  let during: string | null = null;
  a.addEventListener('click', () => (during = a.getAttribute('target')));
  await act({ target: { ref: reg.refFor(a) }, do: 'click' }, deps(reg));
  assert.equal(during, '_self');
  assert.equal(a.getAttribute('target'), '_blank');
});

test('repeat finds the next one with the same name and stops when none is left', async () => {
  load(`<body><ul>${'<li><button class="u">Unsubscribe</button></li>'.repeat(3)}</ul><button>Keep</button></body>`);
  const reg = createRegistry(1, { probe });
  const removeOnClick = (b: Element) => b.addEventListener('click', () => b.parentElement!.remove());
  document.querySelectorAll('button.u').forEach(removeOnClick);
  const first = document.querySelector('button.u')!;
  const r = await act({ target: { ref: reg.refFor(first) }, do: 'click', repeat: 10 }, deps(reg));
  assert.ok(r.ok);
  if (r.ok) {
    assert.equal(r.clicks, 3);
    assert.match(r.text, /^Clicked button "Unsubscribe" \(\w+\), 3 times; none left\./);
  }
  assert.equal(document.querySelectorAll('button.u').length, 0);
  assert.equal(document.querySelectorAll('button').length, 1, 'a button with another name is left alone');
});

test('repeat clicks a control that stays, once the page has had a moment, up to the count', async () => {
  load('<body><button id="m">Show more</button></body>');
  const reg = createRegistry(1, { probe });
  const m = document.getElementById('m')!;
  let n = 0;
  m.addEventListener('click', () => n++);
  const r = await act({ target: { ref: reg.refFor(m) }, do: 'click', repeat: 4 }, deps(reg));
  assert.equal(n, 4);
  assert.match(r.ok ? r.text : '', /4 times\./);
});

test('repeat is capped however many are asked for', async () => {
  load('<body><button id="m">More</button></body>');
  const reg = createRegistry(1, { probe });
  const m = document.getElementById('m')!;
  let n = 0;
  m.addEventListener('click', () => n++);
  await act({ target: { ref: reg.refFor(m) }, do: 'click', repeat: 500 }, deps(reg));
  assert.equal(n, MAX_REPEAT);
});

test('Stop reaches a repeat between clicks', async () => {
  load('<body><button id="m">More</button></body>');
  const reg = createRegistry(1, { probe });
  const m = document.getElementById('m')!;
  let n = 0;
  let cancelled = false;
  m.addEventListener('click', () => {
    if (++n === 2) cancelled = true;
  });
  const r = await act({ target: { ref: reg.refFor(m) }, do: 'click', repeat: 20 }, deps(reg, { isCancelled: () => cancelled }));
  assert.equal(n, 2);
  assert.match(r.ok ? r.text : '', /2 times; stopped\./);
});

test('a step that is cancelled before it starts does nothing', async () => {
  load('<body><button id="b">Go</button></body>');
  const reg = createRegistry(1, { probe });
  const seen = record(document.getElementById('b')!, ['click']);
  const d = deps(reg);
  const step: ActStep = { target: { ref: reg.refFor(document.getElementById('b')!) }, do: 'click' };
  const read = describeStep(step, d);
  const r = await runStep(step, read.ok ? read.signature : '', { ...d, isCancelled: () => true });
  assert.equal(!r.ok && r.code, 'cancelled');
  assert.deepEqual(seen, []);
});

test('a repeat stops rather than click a later one that has moved into a login form', async () => {
  load(`<body>
    <button class="u" id="one">Next</button>
    <form id="f"><input type="password"><button class="u" id="two">Next</button></form>
  </body>`);
  const reg = createRegistry(1, { probe });
  const one = document.getElementById('one')!;
  const two = record(document.getElementById('two')!, ['click']);
  one.addEventListener('click', () => one.remove());
  const r = await act({ target: { ref: reg.refFor(one) }, do: 'click', repeat: 5 }, deps(reg));
  assert.deepEqual(two, []);
  assert.match(r.ok ? r.text : '', /1 time; stopped: it submits a form holding a password field/);
});

test('go leaves after the answer, and a script address is refused', async () => {
  load('<body></body>');
  const reg = createRegistry(1, { probe });
  const went: unknown[] = [];
  const d = deps(reg, { navigate: (g) => went.push(g) });
  let r = await act({ do: 'go', text: '/orders?page=2' }, d);
  assert.ok(r.ok);
  assert.deepEqual(went, [{ kind: 'url', href: 'https://shop.example.com/orders?page=2' }]);
  assert.equal(r.ok && r.navigating, true);
  r = await act({ do: 'go', text: 'reload' }, d);
  assert.deepEqual(went[1], { kind: 'reload' });
  r = await act({ do: 'go', text: 'javascript:alert(1)' }, d);
  assert.equal(!r.ok && r.code, 'never');
  assert.equal(went.length, 2);
});

test('a page that starts to leave is reported as such rather than lost', async () => {
  load('<body><a id="a" href="/next">Next</a></body>');
  const reg = createRegistry(1, { probe });
  const r = await act({ target: { ref: reg.refFor(document.getElementById('a')!) }, do: 'click' }, deps(reg, { leaving: Promise.resolve(), sleep: () => new Promise(() => {}) }));
  assert.equal(r.ok && r.navigating, true);
});

test('a broken target carries its closest matches through act', async () => {
  load('<body><button>Export PDF</button></body>');
  const reg = createRegistry(1, { probe });
  const d = deps(reg);
  const step: ActStep = { target: { at: { css: '#gone' }, role: 'button', name: 'Export' }, do: 'click' };
  const r = await runStep(step, 'anything', d);
  assert.equal(!r.ok && r.code, 'broken');
  if (!r.ok) {
    assert.equal(r.broken, 'none');
    assert.equal(r.closest?.[0]?.name, 'Export PDF');
  }
  const read = describeStep(step, d);
  assert.equal(read.ok, false);
});
