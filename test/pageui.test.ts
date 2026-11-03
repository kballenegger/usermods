// The bar and the outline (lib/pageui.ts): what a page can and cannot do to usermods' mark on it. The
// closed root and real clicks are checked in a browser by the `interact` smoke flow; what is decided
// without one is here.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { barIsUp, clearOutline, holdOutline, removeBar, setBarHidden, showBar, showHint, trustedOnly } from '../lib/pageui.ts';

function page(): Document {
  const w = parseHTML('<html><body><button id="site">Site</button></body></html>');
  Object.assign(globalThis, {
    document: w.document,
    window: { addEventListener() {}, removeEventListener() {}, innerWidth: 1000, innerHeight: 800 },
    MutationObserver: w.MutationObserver,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  });
  return w.document as unknown as Document;
}

/** The roots attachShadow hands out, for a test to look inside the closed one a page cannot. */
function withRoots(run: (roots: ShadowRoot[], fire: (b: Element) => void) => void): void {
  const d = page();
  const roots: ShadowRoot[] = [];
  const div = d.createElement('div');
  let proto = Object.getPrototypeOf(div);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'attachShadow')) proto = Object.getPrototypeOf(proto);
  const original = proto.attachShadow;
  proto.attachShadow = function (init: ShadowRootInit) {
    const r = original.call(this, init);
    roots.push(r);
    return r;
  };
  try {
    run(roots, (b) => b.dispatchEvent(new (d.defaultView as unknown as { Event: typeof Event }).Event('click', { bubbles: true })));
  } finally {
    proto.attachShadow = original;
    removeBar();
  }
}

const handlers = (log: string[] = []) => ({ onStop: () => log.push('stop'), onDone: () => log.push('done') });

test('a click only counts when a real person pressed', () => {
  let pressed = 0;
  const listener = trustedOnly(() => pressed++);
  listener({ isTrusted: false });
  assert.equal(pressed, 0);
  listener({ isTrusted: true });
  assert.equal(pressed, 1);
});

test('the bar has a closed root, so the page has no way in', () => {
  const d = page();
  const el = showBar({ status: 'usermods is driving this page · step 1' }, handlers());
  assert.equal(el.shadowRoot, null);
  assert.equal(el.getAttribute('data-usermods'), 'bar');
  assert.equal(el.parentElement, d.documentElement);
  removeBar();
});

test('the hint and the banner stay open, as the share flow reads them', () => {
  page();
  const hint = showHint({ text: 'x' });
  assert.ok(hint.el.shadowRoot);
  hint.remove();
});

test('the bar carries status, Stop and I have done it, and never anything that answers a permission', () => {
  withRoots((roots) => {
    showBar({ status: 'usermods · your turn: sign in', handoff: true }, handlers());
    const root = roots[0]!;
    const labels = [...root.querySelectorAll('button')].map((b) => b.textContent);
    assert.deepEqual(labels, ['I HAVE DONE IT', 'STOP']);
    assert.equal(root.querySelector('[role="status"]')!.textContent, 'usermods · your turn: sign in');
    showBar({ status: 'usermods is driving this page' }, handlers());
    const done = root.querySelector('[data-testid="usermods-bar-done"]') as HTMLElement;
    assert.equal(done.style.display, 'none', 'I have done it shows only during a handoff');
    assert.equal(root.querySelector('[role="status"]')!.textContent, 'usermods is driving this page');
    assert.equal(roots.length, 1, 'one bar: a second call changes what it says');
  });
});

test('an untrusted click on the bar does nothing', () => {
  withRoots((roots, fire) => {
    const log: string[] = [];
    showBar({ status: 's', handoff: true }, handlers(log));
    for (const b of roots[0]!.querySelectorAll('button')) fire(b);
    assert.deepEqual(log, []);
  });
});

test('the bar can be taken down, hidden for a screenshot, and reports whether it is up', () => {
  page();
  assert.equal(barIsUp(), false);
  const el = showBar({ status: 's' }, handlers());
  assert.equal(barIsUp(), true);
  setBarHidden(true);
  assert.equal(el.style.display, 'none');
  setBarHidden(false);
  assert.equal(el.style.display, '');
  el.remove();
  assert.equal(barIsUp(), false, 'a page that removed it is what the run reads before its next step');
  removeBar();
  assert.equal(barIsUp(), false);
});

test('an outline is drawn in a root of its own and never on the element', () => {
  const d = page();
  const site = d.getElementById('site')!;
  (site as unknown as { getBoundingClientRect: () => DOMRect }).getBoundingClientRect = () => ({ left: 1, top: 2, width: 3, height: 4, bottom: 6 }) as DOMRect;
  const before = site.outerHTML;
  holdOutline(site, 'Cancel');
  assert.equal(site.outerHTML, before);
  assert.ok(d.querySelector('[data-usermods="outline"]'));
  clearOutline();
  assert.equal(d.querySelector('[data-usermods="outline"]'), null);
});
