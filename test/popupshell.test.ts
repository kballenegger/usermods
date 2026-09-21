// The popup is one shell in two shapes: a phone sheet and a Mac window. Which one is drawn is a
// pure decision, covered in test/mobile.test.ts. What that decision is spent on is markup and CSS,
// and this reads both real files to check the parts that would fail quietly.
//
// The failure worth catching: a rule sized for a thumb that is not scoped to the phone, which on a
// Mac gives a 420px popup 44px controls and 16px fields and looks like a shrunken phone. That
// renders, so nothing catches it but eyes.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const app = readFileSync(root + 'entrypoints/sidepanel/App.tsx', 'utf8');
const css = readFileSync(root + 'entrypoints/popup/mobile.css', 'utf8');
const html = readFileSync(root + 'entrypoints/popup/index.html', 'utf8');
const preMount = readFileSync(root + 'entrypoints/popup/popup-size.css', 'utf8');
const pointer = readFileSync(root + 'entrypoints/sidepanel/usePointer.ts', 'utf8');

test('the popup shell publishes the layout it picked', () => {
  // Every rule below keys off this attribute, so it is the one thing the markup owes the CSS.
  assert.match(app, /data-surface="popup" data-layout=\{layout\}/);
  assert.match(app, /const layout = popupLayout\(pointer\)/);
});

test('the navigation moves in the DOM, not with CSS order', () => {
  // Under the header on a Mac, across the bottom on a phone. Reordering visually with `order`
  // would leave the tab sequence saying something different from the screen.
  assert.match(app, /\{layout === 'roomy' && nav\}\s*<div className="popup-body">\{views\}<\/div>\s*\{layout === 'compact' && nav\}/);
});

test('the keyboard inset is measured on the phone only', () => {
  // A Mac popup is a fixed window with no on-screen keyboard. Running the visualViewport listener
  // there would subtract a window resize from the body padding for no reason.
  assert.match(app, /if \(surface !== 'popup' \|\| layout !== 'compact'\) return;/);
});

test('every thumb-sized rule is scoped to the phone', () => {
  // The numbers a thumb needs and a mouse does not: Apple's 44px, the 48px nav row, the 48x28
  // switch, the 16px field size that stops iOS zooming, and 100dvh.
  const thumb = /(min-height: 4[48]px|min-width: 44px|width: 48px|max\(16px|100dvh)/;
  // Comments first: they quote these numbers while explaining them, and a comment is not a rule.
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}');
  let checked = 0;
  for (const rule of rules) {
    const [head, body] = rule.split('{');
    if (!body || !thumb.test(body)) continue;
    const selector = head ?? '';
    checked += 1;
    assert.match(selector, /data-layout='compact'/, `unscoped thumb sizing on: ${selector.trim()}`);
  }
  // A typo in the regex above would pass this file while checking nothing.
  assert.ok(checked >= 6, `only ${checked} thumb-sized rules found; the scan has gone blind`);
});

test('the Mac popup has a window size, because there is no viewport to fill', () => {
  // Safari sizes the popover to the document and caps it at 800x600. A document with no size of
  // its own collapses to its content and the window jumps on every tab change.
  const roomy = /html:has\(\.app\[data-surface='popup'\]\[data-layout='roomy'\]\)[\s\S]*?\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(roomy, /width: \d+px/);
  assert.match(roomy, /height: \d+px/);
});

// ---------------------------------------------------------------------------
// The size the popover is measured from, which exists before React does
// ---------------------------------------------------------------------------
//
// This block is the regression guard for the bug that shipped: a macOS popover collapsed to a
// ~470x90 sliver. Safari sizes a toolbar popover FROM the document, so any size that arrives after
// the app mounts is too late, and a size gated on the measured width is a deadlock — the width it
// reads is the width it was supposed to produce.

/** The declarations inside the `(pointer: fine)` block of the pre-mount stylesheet. */
function preMountBlock(): string {
  const body = /@media\s*\(pointer:\s*fine\)\s*\{([\s\S]*)\}\s*$/.exec(preMount.replace(/\/\*[\s\S]*?\*\//g, ''))?.[1];
  assert.ok(body, 'popup-size.css has no (pointer: fine) block');
  return body;
}

test('the popup document states its own size before anything runs', () => {
  // Render-blocking and synchronous: a <link rel=stylesheet> in <head>, not a module import, not a
  // style written by script. Safari's first layout pass has to see it.
  assert.match(html, /<link rel="stylesheet" href="\.\/popup-size\.css" \/>/);
  // Ahead of the app's own entry, and inside <head>.
  const head = html.slice(0, html.indexOf('</head>'));
  assert.ok(head.includes('popup-size.css'), 'the pre-mount size sheet is not in <head>');

  const block = preMountBlock();
  // html, body and #root all, or the chain from the viewport down to the app has a gap in it and
  // the innermost box collapses anyway.
  for (const sel of ['html', 'body', '#root']) {
    assert.ok(new RegExp(`(^|[,{\\s])${sel.replace('#', '#')}\\s*[,{]`).test(block), `${sel} is not sized by the pre-mount rule`);
  }
  assert.match(block, /width: \d+px/);
  assert.match(block, /height: \d+px/);
});

test('the pre-mount size and the roomy size are the same numbers', () => {
  // They must agree to the pixel. If they do not, the popover is measured at one size and then
  // resizes itself the instant React puts data-layout on, which is a visible jump on every open.
  const roomy = /html:has\(\.app\[data-surface='popup'\]\[data-layout='roomy'\]\)[\s\S]*?\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  const size = (block: string) => ({
    width: /width: (\d+)px/.exec(block)?.[1],
    height: /height: (\d+)px/.exec(block)?.[1],
  });
  const early = size(preMountBlock());
  const late = size(roomy);
  assert.ok(early.width && early.height, 'the pre-mount rule has no size');
  assert.deepEqual(early, late, `popup-size.css says ${early.width}x${early.height}, mobile.css says ${late.width}x${late.height}`);
  assert.deepEqual(early, { width: '420', height: '560' });
});

test('the pre-mount size never reaches a touch screen', () => {
  // iPhone and iPad report a coarse primary pointer, trackpad or not. Pinning either to a desktop
  // window size would take away 100dvh, the safe areas and the sheet's own sizing.
  assert.match(preMount, /@media \(pointer: fine\)/);
  assert.doesNotMatch(preMountBlock(), /dvh|coarse|safe-area/);
  // And nothing in there may depend on a measured width, which is the deadlock this file guards.
  assert.doesNotMatch(preMount.replace(/\/\*[\s\S]*?\*\//g, ''), /@media[^{]*(min-width|max-width)/);
});

test('the layout decision does not read a width the layout itself produces', () => {
  // popupLayout takes the pointer and nothing else; the cases are in test/mobile.test.ts. What is
  // checked here is that the hook feeding it has not grown a width back.
  assert.doesNotMatch(pointer, /innerWidth/);
  // The first value is read during render, not in an effect: a setState-on-mount would give a Mac
  // one painted frame of the compact sheet, which is the frame Safari sizes the popover from.
  assert.match(pointer, /useState<PointerEnvironment>\(read\)/);
});

test('the Mac navigation is shorter than the phone navigation', () => {
  const compact = /\.app\[data-surface='popup'\]\[data-layout='compact'\] \.popup-nav button \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  const roomy = /\.app\[data-surface='popup'\]\[data-layout='roomy'\] \.popup-nav button \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  // The roomy row is for a mouse in a 560px window. If it inherits the phone's 48px target, the
  // content loses space and the desktop popup reads like a shrunk sheet.
  assert.match(compact, /min-height: 48px/);
  assert.match(roomy, /min-height: 34px/);
  assert.ok(!/min-height: 48px/.test(roomy), 'phone navigation height leaked into roomy layout');
});

test('the two navigation positions each carry their own hairline', () => {
  // A bar at the bottom is separated by its top edge and one under the header by its bottom edge.
  // Both borders at once is a boxed-in strip; neither is a row of buttons floating in the body.
  const compact = /\[data-layout='compact'\] \.popup-nav \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  const roomy = /\[data-layout='roomy'\] \.popup-nav \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(compact, /border-top: var\(--border-width\)/);
  assert.match(compact, /border-bottom: 0/);
  assert.match(roomy, /border-bottom: var\(--border-width\)/);
  assert.match(roomy, /border-top: 0/);
});
