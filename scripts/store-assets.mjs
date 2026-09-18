#!/usr/bin/env node
// Builds the Chrome Web Store image set into docs/store/assets/, at the exact sizes the store
// requires — it rejects anything off by a pixel.
//
//   npm run store-assets
//
//   01..05-*.png   1280x800   screenshots
//   promo-tile.png  440x280   small promo tile
//   marquee.png    1400x560   marquee (optional listing image)
//
// ---------------------------------------------------------------------------
// How the screenshots are made
// ---------------------------------------------------------------------------
//
// The store wants a picture of the product in use, at a fixed size that matches neither a side
// panel nor a web page. So each screenshot is a COMPOSITE, assembled in three steps:
//
//   1. Drive the real extension exactly as scripts/screenshots.mjs does — real build, real
//      content script, real page inspection, scripted mock LLM on localhost. See the long note
//      at the top of that file for why the side panel is opened as a tab and why the site tab
//      has to hold focus. Everything there applies here.
//   2. Capture two rasters per subject: the site tab at 860x800 and the panel tab at 420x800,
//      both at deviceScaleFactor 1 so they land as literal pixels in the composite.
//   3. Lay them out side by side on a plain HTML page (composite()) with a thin window chrome
//      and a caption bar, and screenshot THAT at exactly 1280x800.
//
// Step 3 is a separate browser page with no extension loaded: it only draws two PNGs and some
// text, so nothing about the product is faked — the pixels inside the window frame are the real
// extension's own output.
//
// 860 + 420 = 1280, so the two panes tile the frame exactly with no scaling.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const OUT_DIR = path.join(ROOT, 'docs', 'store', 'assets');
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8793);
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;

/** Store-mandated sizes. Verified against the PNG headers at the end of the run. */
const SHOT = { width: 1280, height: 800 };
const TILE = { width: 440, height: 280 };
const MARQUEE = { width: 1400, height: 560 };

/** The two panes of a screenshot composite. They sum to SHOT.width. */
const SITE = { width: 860, height: 800 };
const PANEL = { width: 420, height: 800 };

/** Chrome fakes a real window; the caption bar explains the shot. Both come out of SHOT.height. */
const CHROME_H = 34;
const CAPTION_H = 56;
const PANE_H = SHOT.height - CHROME_H - CAPTION_H;

const WIKI = 'https://en.wikipedia.org/wiki/Common_kingfisher';
const GREASY_FORK_URL =
  'https://update.greasyfork.org/scripts/478687/GitHub%20Custom%20Global%20Navigation.user.js';

/**
 * What the store captures mask. See note 4 in scripts/screenshots.mjs, and HIDE_SETUP_NOTICE /
 * HIDE_UNTESTED_LINE there:
 *
 *  - the first-run "Allow User Scripts" setup notice, a first-run instruction rather than the
 *    steady state;
 *  - the proposal card's "not tested on this page · …" line, which appears only because
 *    chrome.userScripts is unavailable in an automated profile, so the scripted conversations must
 *    pass untested_reason to get past propose_mod's (correct, and deliberately strict) refusal of
 *    untested scripts. A real session with the toggle on tests the script and shows no such line.
 *
 * Both are artefacts of automation rather than of the product, so showing them in the store assets
 * would misrepresent it. This file only ever captures — it asserts nothing — so unlike
 * screenshots.mjs it needs no capture-only gate around the second selector.
 */
const MASK = '.app > .notice, .card .label.untested { display: none !important; }';

const log = (...a) => console.log('[store-assets]', ...a);

// ---------------------------------------------------------------------------
// PNG header verification
// ---------------------------------------------------------------------------

/**
 * Read width/height out of a PNG's IHDR, which is always the first chunk: 8-byte signature,
 * then a 4-byte length, "IHDR", then width and height as big-endian uint32. Cheap enough that
 * every asset is checked rather than trusted.
 */
function pngSize(file) {
  const buf = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(sig)) throw new Error(`${file} is not a PNG`);
  if (buf.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error(`${file} has no IHDR`);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function expectSize(file, want) {
  const got = pngSize(file);
  if (got.width !== want.width || got.height !== want.height) {
    throw new Error(
      `${path.basename(file)} is ${got.width}x${got.height}, expected ${want.width}x${want.height}`,
    );
  }
  return got;
}

// ---------------------------------------------------------------------------
// Mock backend (same scripted server the README screenshots and smoke test use)
// ---------------------------------------------------------------------------

async function startMock() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm.mjs'), String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock-llm did not start in time')), 10_000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`mock-llm exited early with code ${code}`)));
  });
  log(`mock backend on ${BASE_URL}`);
  return child;
}

// ---------------------------------------------------------------------------
// Extension browser
// ---------------------------------------------------------------------------

async function launch() {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    throw new Error(`No build at ${EXT_DIR}. Run "npm run build" first.`);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-store-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    colorScheme: 'light',
    viewport: PANEL,
    // Literal pixels: the captures are placed into a fixed-size composite, so no scaling.
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
  return {
    ctx,
    extId: new URL(sw.url()).host,
    async close() {
      await ctx.close().catch(() => {});
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

async function openPanel(ctx, extId, { settings = {}, storage = {} } = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: PANEL.width, height: PANE_H });
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.evaluate(
    async ([s, extra]) => {
      // consent: the first-run data notice, acknowledged. Without it the notice stands in for the
      // chat and there is no composer to drive — the same seeding scripts/screenshots.mjs does.
      await chrome.storage.local.set({ settings: s, consent: { version: 1, acceptedAt: Date.now() }, ...extra });
    },
    [{ provider: 'openai-compatible', baseUrl: BASE_URL, apiKey: '', model: 'demo', ...settings }, storage],
  );
  // 'domcontentloaded', not the default 'load': the caller drives the panel through its own waits
  // from here, and 'load' also waits on this page's webfonts, which can hang on a loaded host.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: MASK });
  return page;
}

/** Open the site tab and focus it, so the panel targets it rather than itself. */
async function openSite(ctx, url) {
  const site = await ctx.newPage();
  await site.setViewportSize({ width: SITE.width, height: PANE_H });
  await site.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await site.bringToFront();
  return site;
}

/**
 * Wait until the panel has found its target tab and the composer is live. The composer is disabled
 * until the panel's tab query returns a real web page, and a flat sleep is a bet on how fast the
 * host is: when it loses, the send lands on a disabled control and the proposal card never comes.
 * See the same helper in scripts/screenshots.mjs.
 */
async function waitForComposer(panel, timeout = 30_000) {
  await panel.locator('textarea:not([disabled])').waitFor({ state: 'visible', timeout });
}

async function runConversation(panel, text) {
  await waitForComposer(panel);
  await panel.locator('textarea').fill(text);
  await panel.locator('.composer button.btn.primary').click();
  await panel.locator('.messages .card h4').first().waitFor({ timeout: 60_000 });
  await panel.waitForTimeout(700);
}

/** The same seeded library the README screenshots use, so both sets tell one story. */
function seedMods() {
  const now = Date.now();
  const mk = (over) => ({
    id: crypto.randomUUID(),
    description: '',
    version: '1.0.0',
    matches: [],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    allFrames: false,
    grants: [],
    requires: [],
    resources: [],
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  });
  const header = (name, desc, match, grants = []) =>
    [
      '// ==UserScript==',
      `// @name         ${name}`,
      `// @version      1.0.0`,
      `// @description  ${desc}`,
      `// @match        ${match}`,
      ...grants.map((g) => `// @grant        ${g}`),
      '// ==/UserScript==',
    ].join('\n');

  return [
    mk({
      name: 'Wikipedia: full-width article',
      description: 'Hides the pinned table of contents and lets the article body use the whole window.',
      matches: ['*://*.wikipedia.org/wiki/*'],
      source: `${header('Wikipedia: full-width article', 'Hides the pinned table of contents and lets the article body use the whole window.', '*://*.wikipedia.org/wiki/*')}\n\nconst style = document.createElement('style');\nstyle.textContent = \`\n  #vector-toc-pinned-container, .vector-column-start { display: none !important; }\n  .mw-page-container, .vector-body { max-width: none !important; }\n\`;\ndocument.head.appendChild(style);\n`,
    }),
    mk({
      name: 'Hacker News dark',
      description: 'A dark theme for Hacker News: dark surfaces, dimmed orange header, readable link colors.',
      matches: ['*://news.ycombinator.com/*'],
      source: `${header('Hacker News dark', 'A dark theme for Hacker News.', '*://news.ycombinator.com/*')}\n\nconst style = document.createElement('style');\nstyle.textContent = \`\n  body, #hnmain { background: #16181c !important; color: #c9ccd1 !important; }\n\`;\ndocument.documentElement.appendChild(style);\n`,
    }),
    mk({
      name: 'GitHub: wider diffs',
      description: 'Lets pull-request diffs use the full width of the window.',
      matches: ['*://github.com/*'],
      grants: ['GM_addStyle'],
      enabled: false,
      source: `${header('GitHub: wider diffs', 'Lets pull-request diffs use the full width of the window.', '*://github.com/*', ['GM_addStyle'])}\n\nGM_addStyle('.container-xl { max-width: none !important; }');\n`,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Compositing
// ---------------------------------------------------------------------------

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const b64 = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

/**
 * Lay a site capture and a panel capture into one 1280x800 frame: a thin window chrome with the
 * page's URL, the two panes, and a caption bar under them.
 *
 * `left` and `right` are paths to PNGs captured at SITE/PANEL width and PANE_H height. When
 * `right` is null the left capture spans the full frame width (used for the install page, which
 * is a full tab rather than a panel).
 */
async function composite(browser, { left, right, url, title, caption, out }) {
  const page = await browser.newPage({ viewport: SHOT, deviceScaleFactor: 1 });
  const panes = right
    ? `<img class="pane" src="${b64(left)}" style="width:${SITE.width}px">
       <img class="pane divider" src="${b64(right)}" style="width:${PANEL.width}px">`
    : `<img class="pane" src="${b64(left)}" style="width:${SHOT.width}px">`;

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;width:${SHOT.width}px;height:${SHOT.height}px;overflow:hidden;
                font-family:${FONT};background:#fff}
      .chrome{height:${CHROME_H}px;display:flex;align-items:center;gap:8px;padding:0 12px;
              background:#e7e5e4;border-bottom:1px solid #d6d3d1}
      .dot{width:10px;height:10px;border-radius:50%}
      .omni{flex:1;margin-left:6px;height:20px;border-radius:10px;background:#fafaf9;
            border:1px solid #d6d3d1;display:flex;align-items:center;padding:0 10px;
            font-size:11px;color:#78716c;overflow:hidden;white-space:nowrap}
      .panes{height:${PANE_H}px;display:flex;overflow:hidden;background:#fff}
      .pane{display:block;height:${PANE_H}px;object-fit:cover;object-position:top left}
      .divider{border-left:1px solid #d6d3d1}
      /* The caption bar is usermods speaking, so it wears the app's own charcoal and volt. */
      .caption{height:${CAPTION_H}px;display:flex;flex-direction:column;justify-content:center;
               padding:0 24px;background:#0A0D0B;color:#E8EDE8}
      .caption b{font-size:15px;font-weight:600}
      .caption span{font-size:12.5px;color:#8A948B;margin-top:2px}
    </style></head><body>
      <div class="chrome">
        <div class="dot" style="background:#f87171"></div>
        <div class="dot" style="background:#fbbf24"></div>
        <div class="dot" style="background:#4ade80"></div>
        <div class="omni">${url}</div>
      </div>
      <div class="panes">${panes}</div>
      <div class="caption"><b>${title}</b><span>${caption}</span></div>
    </body></html>`);

  const file = path.join(OUT_DIR, out);
  await page.screenshot({ path: file });
  await page.close();
  expectSize(file, SHOT);
  log(`${out} ${SHOT.width}x${SHOT.height}`);
  return file;
}

// ---------------------------------------------------------------------------
// The five screenshots
// ---------------------------------------------------------------------------

const tmp = (name) => path.join(os.tmpdir(), `usermods-store-${name}-${process.pid}.png`);

/** 01 — chat proposing a mod on Wikipedia. */
async function shotChat(b, composer) {
  const panel = await openPanel(b.ctx, b.extId);
  const site = await openSite(b.ctx, WIKI);
  await waitForComposer(panel);
  await runConversation(panel, 'hide the sidebar and make the article full width');

  const l = tmp('chat-site');
  const r = tmp('chat-panel');
  await site.screenshot({ path: l });
  await panel.screenshot({ path: r });
  return composite(composer, {
    left: l,
    right: r,
    url: 'en.wikipedia.org/wiki/Common_kingfisher',
    title: 'Describe the change. It writes the userscript.',
    caption: 'The model reads the page, checks its selectors against the live DOM, and proposes a mod you can Try before you Save.',
    out: '01-chat.png',
  });
}

/** 02 — pointing at an element, which drops an @reference chip in the composer. */
async function shotRefs(b, composer) {
  const panel = await openPanel(b.ctx, b.extId);
  const site = await openSite(b.ctx, WIKI);
  await waitForComposer(panel);
  await runConversation(panel, 'hide the sidebar and make the article full width');

  // The genuine element picker: the panel starts it, the content script broadcasts the pick.
  await panel.locator('.composer button.btn', { hasText: 'Point at element' }).click();
  await panel.waitForTimeout(400);
  const target = site.locator('.infobox, #mw-content-text table').first();
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('could not find an element to point at');
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 120);
  await site.mouse.move(x, y);
  await site.waitForTimeout(250);
  await site.mouse.click(x, y);
  await panel.locator('.composer .chip').first().waitFor({ timeout: 10_000 });
  await panel
    .locator('textarea')
    .fill((await panel.locator('textarea').inputValue()).trim() + ' should open full size when I click it');
  await panel.waitForTimeout(400);

  const l = tmp('refs-site');
  const r = tmp('refs-panel');
  await site.screenshot({ path: l });
  await panel.screenshot({ path: r });
  return composite(composer, {
    left: l,
    right: r,
    url: 'en.wikipedia.org/wiki/Common_kingfisher',
    title: 'Point at anything and say "this".',
    caption: 'Clicking an element on the page drops an @reference into your message, so the model knows exactly what you mean.',
    out: '02-point.png',
  });
}

/** 03 — the Mods view, split by what matches the page in view. */
async function shotMods(b, composer) {
  const panel = await openPanel(b.ctx, b.extId, { storage: { mods: seedMods() } });
  const site = await openSite(b.ctx, WIKI);
  await panel.waitForTimeout(1000);
  await panel.locator('.tabs button', { hasText: 'Mods' }).click();
  await panel.waitForTimeout(700);

  const l = tmp('mods-site');
  const r = tmp('mods-panel');
  await site.screenshot({ path: l });
  await panel.screenshot({ path: r });
  return composite(composer, {
    left: l,
    right: r,
    url: 'en.wikipedia.org/wiki/Common_kingfisher',
    title: 'Your mods, running on every page load.',
    caption: 'Saved scripts split by whether they match this site. Toggle, run, export or delete each one.',
    out: '03-mods.png',
  });
}

/**
 * 04 — the install preview for a real Greasy Fork script.
 *
 * This one is a full tab rather than a side panel, so it spans the whole frame width.
 */
async function shotInstall(b, composer) {
  const page = await b.ctx.newPage();
  await page.setViewportSize({ width: SHOT.width, height: PANE_H });
  await page.goto(`chrome-extension://${b.extId}/install.html#${GREASY_FORK_URL}`);
  await page.locator('.card h4, .card .error').first().waitFor({ timeout: 45_000 });
  const err = await page.locator('.card .error').first().textContent().catch(() => null);
  if (err) throw new Error(`install preview failed: ${err}`);
  await page.waitForTimeout(600);

  // The install page is a centered column, so on a PANE_H-tall viewport the bottom is empty
  // background. Center the column vertically instead, so the pane is filled by content.
  const contentH = await page.evaluate(
    () => document.querySelector('.page').getBoundingClientRect().height,
  );
  if (contentH < PANE_H) {
    // Sits a little above true center, which reads as centered to the eye.
    const pad = Math.round((PANE_H - contentH) * 0.42);
    await page.addStyleTag({ content: `.page { padding-top: ${pad}px !important; }` });
    await page.waitForTimeout(150);
  }

  const l = tmp('install');
  await page.screenshot({ path: l });
  return composite(composer, {
    left: l,
    right: null,
    url: 'Install — GitHub Custom Global Navigation',
    title: 'Install userscripts from anywhere.',
    caption: 'A .user.js link shows what it matches, what it is granted and what it loads, before anything is saved.',
    out: '04-install.png',
  });
}

/** 05 — the Migrate from Tampermonkey card, expanded. */
async function shotMigrate(b, composer) {
  const panel = await openPanel(b.ctx, b.extId, { storage: { mods: seedMods() } });
  const site = await openSite(b.ctx, WIKI);
  await panel.waitForTimeout(900);
  await panel.locator('.tabs button', { hasText: 'Mods' }).click();
  await panel
    .locator('.card', { hasText: 'Migrate from Tampermonkey' })
    .locator('button.btn', { hasText: 'Show' })
    .click();
  await panel.waitForTimeout(500);

  const l = tmp('migrate-site');
  const r = tmp('migrate-panel');
  await site.screenshot({ path: l });
  await panel.screenshot({ path: r });
  return composite(composer, {
    left: l,
    right: r,
    url: 'en.wikipedia.org/wiki/Common_kingfisher',
    title: 'Bring your Tampermonkey library across.',
    caption: 'One backup file imports every script, with its on/off state and its stored values.',
    out: '05-migrate.png',
  });
}

// ---------------------------------------------------------------------------
// Promo tile and marquee — typography and the icon, no third-party sites.
// ---------------------------------------------------------------------------

/**
 * Both promo images are the same composition at two aspect ratios: the icon, the name, the
 * tagline. `scale` moves every dimension together so the 440x280 tile is not just the marquee
 * with smaller text in a big empty field.
 *
 * These wear the BBS Underground brand (docs/branding.md), not the app's charcoal-and-volt UI:
 * they sit next to docs/banner.png in the listing, and the store is the one place the brand
 * speaks before the product does. That means the electric blue field, lime wordmark, a cyan
 * lower edge and a hard offset ink shadow — the same construction as the icon's own "u", scaled
 * up. Deliberately:
 *
 *  - The ICON IS DRAWN AT A WHOLE MULTIPLE OF 16px and gets image-rendering:pixelated, for the
 *    reason spelled out in scripts/render-icons.mjs. A promo tile with a softened icon on it
 *    would undo the whole point of rendering the icon crisply in the first place.
 *  - The background is the brand blue with a faint square-pixel grid rather than a smooth glow.
 *    A radial gradient is the one thing that reads as "not pixel art" at any size, and the grid
 *    does the same job of keeping the field from going flat.
 *  - Body copy stays white-ish on blue rather than lime. Lime on #1008C8 is a vibrating pair at
 *    small sizes; it carries the wordmark and the rule, and nothing that has to be read as a
 *    sentence.
 */
async function promo(browser, { size, out, scale, tagline, sub }) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  const px = (n) => `${Math.round(n * scale)}px`;
  // Whole multiples of the 16-unit grid, so the mark never lands on a half block. Rounded UP:
  // at the tile's 0.52 scale, rounding to nearest gives 48px, and a 48px mark under a 32px
  // wordmark reads as an afterthought rather than as the logo. 64 and 128 balance the type.
  const icon = Math.max(32, Math.ceil((116 * scale) / 16) * 16);
  const shadow = Math.max(2, Math.round(4 * scale));
  // The background grid is drawn in real pixels, not scaled ones: tying it to `scale` makes the
  // tile's mesh half the size of the marquee's, which reads as noise at 440x280.
  const mesh = 32;

  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      *{box-sizing:border-box}
      html,body{margin:0;padding:0;width:${size.width}px;height:${size.height}px;overflow:hidden}
      /* Electric blue field. The grid is two 1px repeating-linear-gradients at the pixel scale of
         the artwork: texture that is made of squares, so it belongs to the same language. */
      body{font-family:${FONT};background:#1008C8;color:#EAF3FF;display:grid;place-items:center;
           background-image:
             repeating-linear-gradient(0deg, rgba(0,229,242,0.07) 0 1px, transparent 1px ${mesh}px),
             repeating-linear-gradient(90deg, rgba(0,229,242,0.07) 0 1px, transparent 1px ${mesh}px);}
      .stack{display:flex;flex-direction:column;align-items:center;text-align:center;
             padding:0 ${px(28)}}
      img{width:${icon}px;height:${icon}px;display:block;margin-bottom:${px(20)};
          image-rendering:pixelated}
      /* Lime wordmark with the icon's own ink shadow, offset square — no blur radius. */
      h1{margin:0;font-size:${px(62)};font-weight:700;letter-spacing:-0.02em;line-height:1;
         color:#AEFF24;text-shadow:${shadow}px ${shadow}px 0 #030B16}
      /* The cyan rule echoes the cyan underside of the "u". */
      .rule{width:${px(120)};height:${Math.max(2, Math.round(5 * scale))}px;background:#00E5F2;
            margin:${px(16)} 0 ${px(14)}}
      p{margin:0;font-size:${px(26)};font-weight:500;color:#FFF345;line-height:1.25;
        max-width:${px(860)}}
      small{display:block;margin-top:${px(14)};font-size:${px(17)};color:#BFD4F5;line-height:1.45;
            max-width:${px(680)}}
    </style></head><body>
      <div class="stack">
        <img src="${b64(path.join(ROOT, 'public', 'icon', '128.png'))}">
        <h1>usermods</h1>
        <div class="rule"></div>
        <p>${tagline}</p>
        ${sub ? `<small>${sub}</small>` : ''}
      </div>
    </body></html>`);

  const file = path.join(OUT_DIR, out);
  await page.screenshot({ path: file });
  await page.close();
  expectSize(file, size);
  log(`${out} ${size.width}x${size.height}`);
  return file;
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mock = await startMock();
  const composer = await chromium.launch({ channel: 'chromium' });
  const made = [];
  try {
    // Each screenshot gets a fresh profile, so seeded storage from one never leaks into the next.
    for (const shot of [shotChat, shotRefs, shotMods, shotInstall, shotMigrate]) {
      const b = await launch();
      try {
        made.push(await shot(b, composer));
      } finally {
        await b.close();
      }
    }

    made.push(
      await promo(composer, {
        size: TILE,
        out: 'promo-tile.png',
        scale: 0.52,
        tagline: 'Vibe-code userscripts in place',
      }),
    );
    made.push(
      await promo(composer, {
        size: MARQUEE,
        out: 'marquee.png',
        scale: 1.25,
        tagline: 'Vibe-code userscripts in place',
        sub: 'Customize any website by chatting with the LLM of your choice. Your key, your machine, no account.',
      }),
    );
  } finally {
    await composer.close();
    mock.kill();
  }

  // Re-verify every file from disk at the end, so the summary is read back rather than assumed.
  console.log('');
  for (const file of made) {
    const { width, height } = pngSize(file);
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`  ${path.relative(ROOT, file).padEnd(36)} ${width}x${height}  ${kb} KB`);
  }
  log(`wrote ${made.length} store assets to ${path.relative(ROOT, OUT_DIR)}/`);
}

await main();
