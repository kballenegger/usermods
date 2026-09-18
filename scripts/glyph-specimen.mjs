#!/usr/bin/env node
// Regenerates docs/design/explorations/glyph-pairs.png — the specimen that decided the display
// face.
//
//   node scripts/glyph-specimen.mjs
//
// It renders the ambiguous glyph pairs and the product's own most-clicked labels at every size the
// type scale uses, in both themes, in the shipped face and in the four that lost. It reads the
// real tokens.css, so the sizes it shows are the sizes that ship; if the scale changes, rerun it.
//
// Why this exists as a committed capture rather than a note: the defect it documents ("CHAT" set
// in Pixelify Sans reads as "OHAT") is invisible in prose and obvious in a picture. The pairs are
// the ones that actually collide in a pixel face — a closed-counter C against O, a spurless G
// against C, an unslashed 0 against O, 8 against B, the 1/I/l trio, 5 against S, E against F, U
// against V, and the lowercase a/o/e that set the wordmark.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'design', 'explorations', 'glyph-pairs.png');

/** The faces, in the order the trial ran them. Only the winner is a project dependency. */
const FACES = [
  ['Jersey 10', '@fontsource/jersey-10/files/jersey-10-latin-400-normal.woff2', 400, 'chosen'],
  ['Pixelify Sans', 'TRIAL/pixelify-sans-latin-700-normal.woff2', 700, 'rejected — the C is a closed O'],
  ['VT323', 'TRIAL/vt323-latin-400-normal.woff2', 400, 'rejected — too light for the bold rule'],
  ['Silkscreen', 'TRIAL/silkscreen-latin-700-normal.woff2', 700, 'rejected — no lowercase'],
  ['DotGothic16', 'TRIAL/dotgothic16-latin-400-normal.woff2', 400, 'rejected — too light, too wide'],
];

/** The pairs a pixel face gets wrong, and the product's own labels. */
const PAIRS = 'CO GC 0O 8B 1Il 5S EF UV aoe';
const WORDS = 'CHAT ARCHIVE SETTINGS SELECT ALL RUN ONCE CHATGPT SUBSCRIPTION';

/** Read the shipped display sizes out of tokens.css, so the specimen cannot drift from the scale. */
function displaySizes() {
  const css = fs.readFileSync(path.join(ROOT, 'entrypoints', 'sidepanel', 'tokens.css'), 'utf8');
  const get = (name) => {
    const m = css.match(new RegExp(`${name}:\\s*(\\d+)px`));
    return m ? Number(m[1]) : null;
  };
  return [
    ['--fs-label', get('--fs-label'), 'tab + section labels'],
    ['--fs-btn', get('--fs-btn'), 'button labels'],
    ['--fs-ui', get('--fs-ui'), 'card titles'],
    ['--fs-stat', get('--fs-stat'), 'stat numbers'],
    ['--fs-title', get('--fs-title'), 'page titles, the wordmark'],
  ].filter(([, px]) => px);
}

/** Only the winner is installed; the losers are rendered if a sibling trial dir still has them. */
function faceSrc(rel) {
  if (!rel) return null;
  const p = rel.startsWith('TRIAL/')
    ? path.join(process.env.TRIAL_FONTS || '', rel.slice(6))
    : path.join(ROOT, 'node_modules', rel);
  return fs.existsSync(p) ? 'file://' + p : null;
}

const sizes = displaySizes();
const faces = FACES.map(([name, rel, weight, verdict]) => ({
  name,
  weight,
  verdict,
  src: faceSrc(rel),
})).filter((f) => f.src || f.name !== 'Jersey 10');

const THEMES = [
  ['night', '#041325', '#F2F6FF', '#AEBED1', '#1C3350'],
  ['day', '#FFFFFF', '#081A2D', '#44596F', '#D6E0F2'],
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
${faces
  .filter((f) => f.src)
  .map(
    (f) =>
      `@font-face{font-family:'${f.name}';font-weight:${f.weight};src:url('${f.src}') format('woff2');}`,
  )
  .join('\n')}
body{margin:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0A0F18}
.theme{padding:20px 22px}
h1{font-size:15px;margin:0 0 3px;letter-spacing:.02em}
.sub{font-size:11px;margin:0 0 16px}
h2{font-size:12px;margin:16px 0 5px;font-weight:600}
.r{display:flex;align-items:baseline;gap:12px;padding:5px 0;border-bottom:1px solid var(--hair)}
.t{font-size:10px;width:230px;flex:none;line-height:1.3}
.t b{font-weight:600;display:block}
.spec{letter-spacing:.08em}
</style></head><body>
${THEMES.map(
  ([theme, bg, fg, dim, hair]) => `
<div class="theme" style="--hair:${hair};background:${bg};color:${fg}">
  <h1>usermods display face — glyph pairs · ${theme}</h1>
  <p class="sub" style="color:${dim}">Every pair below must be told apart at a glance, at every
    size the system uses. Set at the shipped tracking of 0.08em.</p>
  ${sizes
    .map(
      ([token, px, use]) => `
  <h2 style="color:${dim}">${px}px — ${token} · ${use}</h2>
  ${faces
    .map(
      (f) => `<div class="r">
      <div class="t" style="color:${dim}"><b>${f.name}</b>${f.verdict}</div>
      <div class="spec" style="font-family:'${f.name}',ui-monospace,monospace;font-weight:${f.weight};font-size:${px}px">${PAIRS} · ${WORDS}</div>
    </div>`,
    )
    .join('')}`,
    )
    .join('')}
  <h2 style="color:${dim}">The structural reason, at 44px — where the C's aperture either exists or does not</h2>
  ${faces
    .map(
      (f) => `<div class="r">
    <div class="t" style="color:${dim}"><b>${f.name}</b>${f.verdict}</div>
    <div style="font-family:'${f.name}',ui-monospace,monospace;font-weight:${f.weight};font-size:44px;letter-spacing:.05em">C O G Q 0 8 B · usermods</div>
  </div>`,
    )
    .join('')}
</div>`,
).join('')}
</body></html>`;

// Written to a file and navigated to, rather than handed to setContent: a page created by
// setContent has an "about:blank" origin, and Chromium refuses to load a file:// @font-face from
// one — every face silently falls back to the monospace default and the specimen shows five
// identical rows.
const tmp = path.join(ROOT, 'docs', 'design', 'explorations', '.glyph-specimen.tmp.html');
fs.mkdirSync(path.dirname(tmp), { recursive: true });
fs.writeFileSync(tmp, html);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1120, height: 900 }, deviceScaleFactor: 2 });
await page.goto('file://' + tmp);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
await page.screenshot({ path: OUT, fullPage: true });
await browser.close();
fs.rmSync(tmp, { force: true });
console.log('wrote', path.relative(ROOT, OUT));
