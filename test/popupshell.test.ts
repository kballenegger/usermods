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

test('the Mac has its tabs under the header, and the phone has no navigation bar at all', () => {
  // Under the header on a Mac, in the DOM rather than with CSS `order`, so the tab sequence says
  // what the screen says.
  assert.match(app, /\{layout === 'roomy' && nav\}\s*<div className="popup-body">\{views\}<\/div>/);
  // The phone used to carry the same three across the bottom, permanently, under the composer.
  // On a 844px screen with the keyboard up that row was part of why the transcript had 32px. It
  // is now behind the menu in the compact top bar, and must not come back as a bar.
  assert.doesNotMatch(app, /layout === 'compact' && nav/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /\[data-layout='compact'\] \.popup-nav/);
  assert.match(app, /data-action="menu"/);
  assert.match(app, /data-action="back-to-chat"/);
});

test('the keyboard inset is measured on the phone only', () => {
  // A Mac popup is a fixed window with no on-screen keyboard. Running the visualViewport listener
  // there would subtract a window resize from the body padding for no reason.
  assert.match(app, /if \(surface !== 'popup' \|\| layout !== 'compact'\) return;/);
});

test('every thumb-sized rule is scoped to the phone', () => {
  // The numbers a thumb needs and a mouse does not: Apple's 44px, the 48px nav row, the 48x28
  // switch, the 16px field size that stops iOS zooming, and 100dvh.
  const thumb = /(min-height: (4[48]|52)px|min-width: 44px|\bheight: 44px|width: 4[48]px|max\(16px|\d+dvh)/;
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
  assert.ok(checked >= 20, `only ${checked} thumb-sized rules found; the scan has gone blind`);
});

test('every rule that draws the compact shell is scoped to it', () => {
  // The content-first shell is a different TREE in compact (a top bar, a draft pill, a one-row
  // composer, bottom sheets). None of those elements are mounted anywhere else, but a rule for
  // one of them without the scope is one refactor away from restyling the Mac popover, so the
  // scope is asserted rather than assumed. Same for the rules that tighten the shared views.
  const shell = /\.(cbar|cbtn|sheet|draft-pill|composer-row|composer\.compact|compact-note|steps-fold|note-x|mod-foot|mod-more)\b/;
  const shared = /(\.messages|\.msg\b|\.tool\b|\.card\.hero|\.activity\b|\.artifact|\.model-line|\.modpicker|button\.linklike|(^|[\s,])select\b)/;
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}');
  let checked = 0;
  for (const rule of rules) {
    const head = (rule.split('{')[0] ?? '').replace(/@media[^{]*$/, '');
    for (const selector of head.split(',')) {
      const sel = selector.trim();
      if (!sel || sel.startsWith('@') || sel === 'from' || sel === 'to') continue;
      if (!shell.test(sel) && !shared.test(sel)) continue;
      // `.view, .messages` momentum scrolling is the one shared rule that is for both layouts.
      if (/^\.app\[data-surface='popup'\] \.(view|messages)$/.test(sel)) continue;
      checked += 1;
      assert.match(sel, /\[data-layout='compact'\]/, `compact-shell rule without the compact scope: ${sel}`);
    }
  }
  assert.ok(checked >= 60, `only ${checked} compact-shell selectors found; the scan has gone blind`);
});

test('the compact shell is a different tree only in compact', () => {
  // Chat, Mods and the draft panel branch on `compact` from the shell context, which App only
  // ever sets for the popup on a coarse pointer. The default is the panel's: nothing compact.
  const shellCtx = readFileSync(root + 'entrypoints/sidepanel/shell.ts', 'utf8');
  assert.match(shellCtx, /PANEL_SHELL: Shell = \{ compact: false/);
  assert.match(app, /const compact = surface === 'popup' && layout === 'compact';/);
  assert.match(app, /compact \? \{ compact, barSlot, sheetHost \} : PANEL_SHELL/);
  const sheet = readFileSync(root + 'entrypoints/sidepanel/components/Sheet.tsx', 'utf8');
  // A sheet with nowhere to be portalled (any shell but compact) renders nothing.
  assert.match(sheet, /if \(!sheetHost\) return null;/);
  assert.match(sheet, /role="dialog" aria-modal="true" aria-labelledby=\{titleId\}/);
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

test('the Mac navigation keeps a mouse-sized row', () => {
  const roomy = /\.app\[data-surface='popup'\]\[data-layout='roomy'\] \.popup-nav button \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  // The roomy row is for a mouse in a 560px window. A thumb-sized target there costs the content
  // space and makes the desktop popup read like a shrunk sheet.
  assert.match(roomy, /min-height: 34px/);
  assert.ok(!/min-height: 4[48]px/.test(roomy), 'a phone-sized target leaked into the roomy navigation');
});

test('the Mac navigation is separated from the content by its bottom edge', () => {
  const roomy = /\[data-layout='roomy'\] \.popup-nav \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  assert.match(roomy, /border-bottom: var\(--border-width\)/);
  assert.match(roomy, /border-top: 0/);
});

// ---------------------------------------------------------------------------
// The iPad popover
// ---------------------------------------------------------------------------
//
// Found on the owner's iPad Pro: a tiny popover that could not be resized. Safari on iPad shows the
// popup as a popover sized from the document, as on a Mac, but an iPad has a coarse pointer, so
// the Mac's pre-mount rule never reached it. It has its own, keyed off the SCREEN.

const bare = preMount.replace(/\/\*[\s\S]*?\*\//g, '');
const TABLET = '(pointer: coarse) and (min-device-width: 700px)';

test('the iPad gets a size before anything runs, from the screen and nothing else', () => {
  assert.ok(bare.includes(`@media ${TABLET} {`), 'popup-size.css has no iPad rule');
  const block = /@media \(pointer: coarse\) and \(min-device-width: 700px\) \{([\s\S]*?)\n\}/.exec(bare)?.[1] ?? '';
  for (const sel of ['html', 'body', '#root']) assert.ok(new RegExp(`(^|[,{\\s])${sel}\\s*[,{]`).test(block), `${sel} is not sized by the iPad rule`);
  assert.match(block, /--popover-w: 440px/);
  assert.match(block, /width: var\(--popover-w\)/);
  assert.match(block, /height: var\(--popover-h\)/);
  // Nothing in the whole file may depend on the viewport: inside a content-sized popover every
  // viewport unit and every width query is the document's own output coming back round.
  assert.doesNotMatch(bare, /\d(vw|vh|dvh|dvw|svh|lvh)\b/);
  assert.doesNotMatch(bare, /@media[^{]*\((min|max)-(width|height)\b/);
});

test('the iPad rule never reaches a phone, and never reaches a fine pointer', () => {
  // Every rule in the file that is not the Mac's names a coarse pointer AND a tablet's screen.
  const queries = [...bare.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1]!.trim());
  assert.ok(queries.length >= 4);
  for (const q of queries) {
    if (q === '(pointer: fine)') continue;
    assert.match(q, /^\(pointer: coarse\) and \(min-device-width: (\d+)px\)$/, `unexpected query: ${q}`);
    const floor = Number(/min-device-width: (\d+)px/.exec(q)![1]);
    // The widest iPhone screen is 440pt and the narrowest iPad (mini) is 744pt.
    assert.ok(floor > 440 && floor >= 700, `${q} would match an iPhone`);
  }
  // And the first tier has to admit the iPad mini.
  assert.ok(700 <= 744);
});

test('the iPad heights rise with the screen and stay under it', () => {
  const tiers = [...bare.matchAll(/min-device-width: (\d+)px\) \{[\s\S]*?--popover-h: (\d+)px/g)].map((m) => ({ screen: Number(m[1]), height: Number(m[2]) }));
  assert.deepEqual(tiers.map((t) => t.height), [600, 660, 720]);
  for (const t of tiers) {
    // device-width is the portrait width, which is the landscape HEIGHT: the popover has to fit
    // under Safari's toolbar on a screen that tall.
    assert.ok(t.height <= t.screen - 100, `${t.height}px does not fit a ${t.screen}px-tall landscape screen`);
  }
});

test('the app keeps the iPad size the stylesheet stated, and marks the device the same way', () => {
  const tablet = /html:has\(\.app\[data-surface='popup'\]\[data-layout='compact'\]\[data-device='tablet'\]\)[\s\S]*?\{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
  // The same custom properties, so the two cannot drift; --tablet-* is the post-mount adoption.
  assert.match(tablet, /width: var\(--tablet-w, var\(--popover-w, 440px\)\)/);
  assert.match(tablet, /height: var\(--tablet-h, var\(--popover-h, 660px\)\)/);
  // The hook's query is the stylesheet's, to the letter.
  assert.ok(pointer.includes(`'${TABLET}'`), 'usePointer.ts and popup-size.css disagree about what an iPad is');
  assert.match(app, /data-device=\{compact && pointer\.tablet \? 'tablet' : undefined\}/);
  // It is still the compact layout: thumb-sized targets and the content-first shell.
  assert.doesNotMatch(readFileSync(root + 'lib/mobile.ts', 'utf8'), /'tablet'/);
});
