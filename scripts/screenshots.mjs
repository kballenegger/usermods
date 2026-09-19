#!/usr/bin/env node
// Regenerates docs/screenshots/*.png with Playwright, driving the real extension against the
// scripted mock backend in scripts/mock-llm.mjs. No API key and no network model call.
//
//   npm run screenshots      capture everything into docs/screenshots/
//   npm run smoke            headless: the chat, guardrails, activity, chats, isolation,
//                            compaction, dashboard, theme, tab bar and wait flows, all asserted
//   npm run smoke:chats      headless: the chats flow alone (restore, New chat, archive/unarchive)
//   npm run smoke:isolation  headless: the isolation flow alone (two chats running at once, no bleed)
//   npm run smoke:compaction headless: the compaction flow alone (both tiers, on a shrunken budget)
//   npm run smoke:dashboard  headless: the dashboard flow alone (grouping, search, handoff, mods)
//   npm run smoke:tabbar     headless: the top bar alone, at 320/360/420/640 in both themes
//   npm run smoke:wait       headless: the wait flow alone (every wait_for condition, a deliberate
//                            timeout, Stop mid-wait), against a fixture page the mock server serves
//   node scripts/screenshots.mjs --dashboard-capture   that flow, also writing 07-dashboard.png
//   node scripts/screenshots.mjs --tabbar-capture      the bar flow, also writing the bar at 360
//                                                      and 640 into $TABBAR_SHOT_DIR
//
// Every flow ends by asserting that the mock backend received zero structurally invalid requests
// (see "History validity" below).
//
// ---------------------------------------------------------------------------
// How this works, and why it is shaped this way
// ---------------------------------------------------------------------------
//
// 1. Branded Chrome 137+ ignores --load-extension, so this uses Playwright's bundled Chromium
//    via `channel: 'chromium'` and a persistent context.
//
// 2. The side panel cannot be opened by automation (chrome.sidePanel.open needs a real user
//    gesture), but sidepanel.html is an ordinary extension page, so it is loaded in a normal tab
//    sized to side-panel proportions (420x820). It looks the same because it is the same page.
//
// 3. The panel finds its target through chrome.tabs.query({active: true, currentWindow: true}).
//    If the panel tab is itself the active tab, it targets itself, reads no host, and the
//    composer stays disabled. So the order is: open the panel tab, open the site tab, then
//    bringToFront() the SITE tab. The panel then sees the site and enables. A backgrounded tab
//    still renders and screenshots correctly in Chromium, so the panel is driven and captured
//    while the site tab holds focus the whole time. Nothing is patched in the extension.
//
// 4. chrome.userScripts is undefined in an automated profile: "Allow User Scripts" is a per-
//    extension toggle in chrome://extensions that cannot be set programmatically or by a flag.
//    The panel correctly shows a setup notice about it. That notice is real, but it is a
//    first-run instruction rather than the normal state, so it is hidden with injected CSS for
//    the screenshots only (HIDE_SETUP_NOTICE / MASK below). The consequence for the scripted
//    conversations is that run_script and screenshot would fail, so the mock never calls them;
//    get_page, find_elements and get_styles go through the content script and work for real
//    against the live pages. It also means every scripted propose_mod must pass untested_reason
//    to get past the propose-time check, which puts a "not tested on this page" line on the card
//    — masked in the captures only, see HIDE_UNTESTED_LINE.
//
// 5. Settings are seeded by evaluating chrome.storage.local.set from an extension page, which
//    has the same storage as the side panel.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { COMPACT_MARKER, FAST_MARKER, IMAGES_MARKER, SLOW_MARKER, SUMMARY_MARKER, WAIT_MARKER } from './mock-llm.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, '.output', 'chrome-mv3');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8791);
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;

/** Side-panel proportions. Chrome's own side panel is around 400-450 CSS px wide. */
const PANEL = { width: 420, height: 820 };
const SCALE = 2;

const SMOKE = process.argv.includes('--smoke');
const CHATS = process.argv.includes('--chats');
const ISOLATION = process.argv.includes('--isolation');
const COMPACTION = process.argv.includes('--compaction');
const DASHBOARD = process.argv.includes('--dashboard');
/** The dashboard flow, asserted AND capturing 07-dashboard.png, without re-running the other flows. */
const DASHBOARD_SHOT = process.argv.includes('--dashboard-capture');
const THEME = process.argv.includes('--theme');
const TABBAR = process.argv.includes('--tabbar');
const WAIT = process.argv.includes('--wait');
const IMAGES = process.argv.includes('--images');

/**
 * Where the tab bar's captures go when --tabbar is asked to write them (`--tabbar-capture`). These
 * are not README assets — they are for looking at the bar while working on it — so they land in a
 * scratch directory rather than in docs/screenshots.
 */
const TABBAR_SHOT_DIR = process.env.TABBAR_SHOT_DIR ?? path.join(os.tmpdir(), 'usermods-tabbar');
const TABBAR_SHOT = process.argv.includes('--tabbar-capture');

/** Capture the living specimen (entrypoints/styleguide) into docs/design/ for docs/design.md. */
const STYLEGUIDE = process.argv.includes('--styleguide');

/** True when this run is capturing screenshots rather than asserting behaviour (see MASK below). */
const CAPTURING =
  !SMOKE && !CHATS && !ISOLATION && !COMPACTION && !DASHBOARD && !DASHBOARD_SHOT && !THEME &&
  !TABBAR && !TABBAR_SHOT && !WAIT && !IMAGES && !STYLEGUIDE;

/** See note 4: a first-run setup instruction, not the steady state the README should show. */
const HIDE_SETUP_NOTICE = '.app > .notice, .dash-inner > .notice { display: none !important; }';

/**
 * The "not tested on this page · …" line on the proposal card, hidden for the captures ONLY.
 *
 * chrome.userScripts is unavailable in an automated profile (note 4), so the scripted
 * conversations must pass untested_reason to get past propose_mod's refusal of untested scripts.
 * That refusal is correct product behaviour and stays strict; the line it produces is an artefact
 * of automation, not of the product — a real session with the toggle on tests the script and shows
 * no such line — so leaving it in the README and store captures would misrepresent the normal
 * product.
 *
 * This is deliberately NOT part of HIDE_SETUP_NOTICE, because that constant is injected by the
 * shared openPanel/shot/reopenPanel helpers, which every asserting flow also goes through. Hiding
 * the line there would quietly disarm the smoke and guardrails flows, which assert that the line
 * IS shown to the user.
 */
const HIDE_UNTESTED_LINE = '.card .label.untested { display: none !important; }';

/** Everything the capture path masks: the setup notice always, the untested line only when capturing. */
const MASK = CAPTURING ? `${HIDE_SETUP_NOTICE}\n${HIDE_UNTESTED_LINE}` : HIDE_SETUP_NOTICE;

/**
 * A real, popular Greasy Fork script, fetched live for the install screenshot: it has a @require
 * library and GM permissions, so the preview shows everything it can show.
 */
const GREASY_FORK_URL = 'https://update.greasyfork.org/scripts/478687/GitHub%20Custom%20Global%20Navigation.user.js';

const log = (...a) => console.log('[screenshots]', ...a);

// ---------------------------------------------------------------------------
// Mock backend
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
// Browser
// ---------------------------------------------------------------------------

async function launch(colorScheme = 'light') {
  if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
    throw new Error(`No build at ${EXT_DIR}. Run "npm run build" first.`);
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-shots-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    colorScheme,
    viewport: PANEL,
    deviceScaleFactor: SCALE,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
  const extId = new URL(sw.url()).host;

  return {
    ctx,
    extId,
    async close() {
      await ctx.close().catch(() => {});
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

/**
 * Open the panel page, seed settings and storage, and return the page.
 *
 * The theme comes from the stored setting, not from the emulated OS scheme: `theme` defaults to
 * 'system', so a capture that only set colorScheme would be at the mercy of the default. Pass
 * `settings: { theme: 'light' | 'dark' }` to pin it, or 'system' to exercise the OS path on purpose.
 */
async function openPanel(ctx, extId, { settings = {}, storage = {} } = {}) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.evaluate(
    async ([s, extra]) => {
      // consent: the first-run data notice, acknowledged, so the panel opens straight into the chat.
      await chrome.storage.local.set({ settings: s, consent: { version: 1, acceptedAt: Date.now() }, ...extra });
    },
    [{ provider: 'openai-compatible', baseUrl: BASE_URL, apiKey: '', model: 'demo', ...settings }, storage],
  );
  // 'domcontentloaded', not the default 'load': see reopenPanel. The caller drives the panel
  // through its own waits from here, and 'load' also waits on this page's webfonts.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.addStyleTag({ content: MASK });
  return page;
}

/**
 * Open a site tab and make it the active one, so the panel targets it (note 3).
 * The panel tab stays open and fully renderable behind it.
 */
async function openSite(ctx, url) {
  const site = await ctx.newPage();
  await site.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await site.bringToFront();
  return site;
}

async function shot(page, name) {
  await page.addStyleTag({ content: MASK }).catch(() => {});
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file });
  const kb = Math.round(fs.statSync(file).size / 1024);
  log(`${name} (${kb} KB)`);
  return file;
}

/**
 * Reload the panel and wait until it is usable again, without trusting the reload's own promise.
 *
 * A reload issued while a run is still streaming into the panel can navigate — the call log shows
 * "navigated to sidepanel.html" — and yet never resolve its wait, so both the default 'load' and
 * 'domcontentloaded' time out at 30s on a page that is plainly up and serving. Every caller
 * establishes real readiness immediately afterwards (a transcript row, the switcher, the composer,
 * or a chrome.storage read), so the navigation promise buys nothing beyond starting the reload.
 *
 * Instead: kick the reload off, then prove the document is live and the extension APIs are bound.
 */
async function reloadPanel(panel) {
  await panel.reload({ waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
  await panel.waitForFunction(() => typeof chrome !== 'undefined' && !!chrome.storage?.local, null, { timeout: 30_000 });
  await panel.addStyleTag({ content: MASK }).catch(() => {});
}

/**
 * Wait until the panel has found its target tab and the composer is live.
 *
 * The composer is `disabled={unsupported}` until the panel's tab query comes back with a real web
 * page (note 3). Every flow used to cover that with a flat waitForTimeout(1200), which is a bet on
 * how fast the host is: when it lost, `fill()` resolved the textarea and then sat on a disabled
 * element for the full 30s timeout — the failure read "locator resolved to <textarea …>" with the
 * ENABLED placeholder, because it had enabled a moment after the fill gave up. Waiting for the
 * element to be editable tests the thing that actually matters and is immune to host speed.
 */
async function waitForComposer(panel, timeout = 30_000) {
  await panel.locator('textarea:not([disabled])').waitFor({ state: 'visible', timeout });
}

/** Send a message in the panel and wait for the proposal card. */
async function runConversation(panel, text, { refreshTitle = false } = {}) {
  await waitForComposer(panel);
  await panel.locator('textarea').fill(text);
  await panel.locator('.composer button.btn.primary').click();
  await panel.locator('.messages .card h4').first().waitFor({ timeout: 60_000 });
  // Let the last streamed text settle before capturing.
  await panel.waitForTimeout(600);

  // The chat's title is derived from the first message by the background worker, which writes it
  // just after the panel has already refetched the switcher — so a freshly created chat still
  // reads "New chat" until the next refresh. Nudging the list here shows the real title, which is
  // what the switcher looks like any time after the first turn.
  if (refreshTitle) {
    await reloadPanel(panel);
    // The restored transcript, and the switcher now showing the real title rather than "New chat".
    await panel.locator('.messages .card h4').first().waitFor({ timeout: 20_000 });
    await panel
      .locator('.chatbar select')
      .filter({ hasNotText: /New chat · / })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(() => {});
    await panel.waitForTimeout(500);
  }
}

// ---------------------------------------------------------------------------
// History validity
// ---------------------------------------------------------------------------
//
// The mock backend checks every chat-completions body it receives against the shape the real API
// requires — tool_call ids answered exactly once, no orphan tool messages, no empty content where
// the API forbids it, a tools array whenever the history has tool calls — and records anything
// wrong at /__violations. A dangling tool call is a 400 from a real provider and an error row for
// the user, but against a permissive mock it is invisible, so every flow below ends by asserting
// that the server saw none. Compaction rewrites old messages, which makes this the assertion that
// keeps it honest.

const CONTROL_BASE = BASE_URL.replace(/\/v1$/, '');

/** Ask the mock what it thinks of the requests it has seen. Run from node, not the browser. */
async function fetchViolations() {
  const res = await fetch(`${CONTROL_BASE}/__violations`);
  return (await res.json()).violations ?? [];
}

async function clearViolations() {
  await fetch(`${CONTROL_BASE}/__violations`, { method: 'DELETE' }).catch(() => {});
}

/** Fail with the whole list, because the first violation is rarely the only one. */
async function assertNoViolations(flow) {
  const found = await fetchViolations();
  if (!found.length) return;
  const lines = found.map((v) => `  ${v.script}: ${v.kind} — ${v.detail}`).join('\n');
  throw new Error(`${flow}: the backend received ${found.length} structurally invalid request(s):\n${lines}`);
}

/** Every chat-completions body the mock recorded, so a flow can measure how big they got. */
async function fetchRequests() {
  const res = await fetch(`${CONTROL_BASE}/__requests`);
  return (await res.json()).requests ?? [];
}

// ---------------------------------------------------------------------------
// The captures
// ---------------------------------------------------------------------------

/**
 * 01 — a finished conversation with the proposal card, in one theme.
 *
 * The theme is forced through the stored setting rather than by emulating the OS, so the shot shows
 * the palette it is named after whatever the default happens to be. The OS scheme is emulated to
 * match, so native controls and any prefers-color-scheme rule agree with it.
 */
async function chatProposal(theme, name) {
  const b = await launch(theme);
  try {
    const panel = await openPanel(b.ctx, b.extId, { settings: { theme } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);
    await runConversation(panel, 'hide the sidebar and make the article full width', { refreshTitle: true });
    const proposal = await panel.locator('.messages .card h4').first().textContent();
    await shot(panel, name);
    return proposal;
  } finally {
    await b.close();
  }
}

/**
 * 02 — the composer holding a real @element chip.
 *
 * The chip comes from the genuine element picker: the panel's "Point at element" button asks the
 * content script to start picking, and the content script broadcasts the pick over runtime
 * messaging when the user clicks. Both halves are driven for real here — the button is clicked in
 * the panel, then Playwright's mouse moves over and clicks an actual element on the page (the
 * picker tracks the element under the cursor on mousemove, so the move matters).
 *
 * Picking happens on the site tab, which has to be focused for the mouse to land; the panel is
 * brought to front afterwards only so the shot is of a settled panel.
 */
async function chatRefs() {
  const b = await launch('light');
  try {
    const panel = await openPanel(b.ctx, b.extId);
    const site = await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);

    // A first exchange, so the shot shows a conversation in progress rather than an empty panel.
    await runConversation(panel, 'hide the sidebar and make the article full width', { refreshTitle: true });

    // Start the picker, then click a real element: the article's infobox image.
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

    // The chip lands in the composer once the content script's message reaches the panel.
    await panel.locator('.composer .chip').first().waitFor({ timeout: 10_000 });
    await panel.locator('textarea').fill((await panel.locator('textarea').inputValue()).trim() + ' should open full size when I click it');
    await panel.waitForTimeout(300);
    return await shot(panel, '02-chat-refs.png');
  } finally {
    await b.close();
  }
}

/** A couple of saved mods, one of which matches the site in view. */
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
    ['// ==UserScript==', `// @name         ${name}`, `// @version      1.0.0`, `// @description  ${desc}`, `// @match        ${match}`, ...grants.map((g) => `// @grant        ${g}`), '// ==/UserScript=='].join('\n');

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
      source: `${header('Hacker News dark', 'A dark theme for Hacker News.', '*://news.ycombinator.com/*')}\n\nconst style = document.createElement('style');\nstyle.textContent = \`\n  body, #hnmain { background: #16181c !important; color: #c9ccd1 !important; }\n  .titleline > a { color: #e6e8ea !important; }\n\`;\ndocument.documentElement.appendChild(style);\n`,
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

/** 03 — the Mods view with saved mods, one matching the page in view. */
async function mods(theme = 'dark', name = '03-mods.png') {
  const b = await launch(theme);
  try {
    const panel = await openPanel(b.ctx, b.extId, { settings: { theme }, storage: { mods: seedMods() } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1000);
    await panel.locator('.tab-group [data-view="mods"]').click();
    await panel.waitForTimeout(600);
    return await shot(panel, name);
  } finally {
    await b.close();
  }
}

/** 04 — Settings, provider presets and the ChatGPT subscription card, not signed in. */
async function settings(theme = 'dark', name = '04-settings.png') {
  const b = await launch(theme);
  try {
    const panel = await openPanel(b.ctx, b.extId, {
      settings: { provider: 'chatgpt', baseUrl: '', apiKey: '', model: '', theme },
    });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(800);
    await panel.locator('[data-action="settings"]').click();
    await panel.waitForTimeout(600);
    return await shot(panel, name);
  } finally {
    await b.close();
  }
}

/** 05 — the install page for a real Greasy Fork script, fetched live. */
async function install(theme = 'dark', name = '05-install.png') {
  const b = await launch(theme);
  try {
    // The install page is a full page, not a panel, so give it a page-sized viewport.
    const page = await b.ctx.newPage();
    await page.setViewportSize({ width: 860, height: 900 });
    // The install page reads the same stored setting the panel does, so pin it there too. Seeded
    // from the panel page rather than this one: install.html with no fragment renders its "no
    // script URL" error, which the preview check below would then pick up.
    const seed = await b.ctx.newPage();
    await seed.goto(`chrome-extension://${b.extId}/sidepanel.html`);
    await seed.evaluate(async (t) => {
      await chrome.storage.local.set({ settings: { theme: t } });
    }, theme);
    await seed.close();
    // The script URL travels in the fragment, taken verbatim, the way the .user.js redirect rule
    // writes it — a query parameter would let the fetched URL smuggle its own `url=` past us.
    await page.goto(`chrome-extension://${b.extId}/install.html#${GREASY_FORK_URL}`);
    // Wait for the fetched preview (or an error, which should fail the run rather than be shot).
    await page.locator('.card h4, .card .error').first().waitFor({ timeout: 45_000 });
    const err = await page.locator('.card .error').first().textContent().catch(() => null);
    if (err) throw new Error(`install preview failed: ${err}`);
    await page.waitForTimeout(500);
    // The page is a centered column on a tall viewport; crop to the content so the shot is not
    // mostly empty background.
    const height = await page.evaluate(() => Math.ceil(document.querySelector('.page').getBoundingClientRect().bottom + 24));
    await page.setViewportSize({ width: 860, height: Math.max(360, Math.min(height, 1200)) });
    await page.waitForTimeout(200);
    return await shot(page, name);
  } finally {
    await b.close();
  }
}

/** 06 — the Migrate from Tampermonkey card, expanded. */
async function migrate(theme = 'dark') {
  const b = await launch(theme);
  try {
    const panel = await openPanel(b.ctx, b.extId, { settings: { theme }, storage: { mods: seedMods() } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(800);
    await panel.locator('.tab-group [data-view="mods"]').click();
    await panel.locator('.card', { hasText: 'Migrate from Tampermonkey' }).locator('button.btn', { hasText: 'Show' }).click();
    await panel.waitForTimeout(400);
    return await shot(panel, '06-migrate.png');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Smoke test: the same chat loop, asserting the proposal card appears.
// ---------------------------------------------------------------------------

async function smoke() {
  const b = await launch('light');
  try {
    await clearViolations();
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);
    await runConversation(panel, 'hide the sidebar and make the article full width');

    const fail = (m) => {
      throw new Error(`smoke: ${m}`);
    };

    const title = (await panel.locator('.messages .card h4').first().textContent())?.trim();
    if (title !== 'Wikipedia: full-width article') fail(`proposal title was ${JSON.stringify(title)}`);

    const match = (await panel.locator('.messages .card .chip').first().textContent())?.trim();
    if (match !== '*://*.wikipedia.org/wiki/*') fail(`match pattern was ${JSON.stringify(match)}`);

    // Under automation nothing can be run, so the scripted propose_mod passes untested_reason and
    // the card must tell the user so — visibly. The capture path masks this line with injected CSS
    // (MASK above); asserting visibility here is what keeps that mask out of the asserting flows.
    const untested = panel.locator('.messages .card .label.untested');
    if ((await untested.count()) !== 1) fail(`expected 1 untested line on the card, got ${await untested.count()}`);
    if (!(await untested.first().isVisible())) fail('the untested line is in the DOM but not visible to the user');
    const untestedText = (await untested.first().textContent()) ?? '';
    if (!untestedText.includes('not tested on this page · chrome.userScripts is unavailable')) {
      fail(`untested line read ${JSON.stringify(untestedText)}`);
    }

    // The tools really ran against the page through the content script.
    const tools = await panel.locator('.messages .tool summary').allTextContents();
    for (const name of ['get_page', 'find_elements', 'get_styles', 'propose_mod']) {
      if (!tools.some((t) => t.includes(name))) fail(`no ${name} row in the transcript (rows: ${tools.join(' | ')})`);
    }
    // A failed call is a coral dot on its row, not a glyph in the text.
    const failed = await panel.locator('.messages .tool summary .dot.error').count();
    if (failed) fail(`${failed} tool call(s) failed`);
    const stillRunning = await panel.locator('.messages .tool summary .dot.running').count();
    if (stillRunning) fail(`${stillRunning} tool call(s) never returned`);

    // The generated code is present and is the real script, not a placeholder.
    const code = await panel.locator('.messages .card pre').first().textContent();
    if (!code?.includes('vector-toc-pinned-container')) fail('proposal code did not contain the expected selector');

    // Saving it puts a real mod in storage.
    await panel.locator('.messages .card button.btn.primary').click();
    await panel.locator('.messages .card button.btn.primary', { hasText: 'Saved · enabled' }).waitFor({ timeout: 10_000 });
    const saved = await panel.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? []);
    if (saved.length !== 1) fail(`expected 1 saved mod, got ${saved.length}`);
    if (!saved[0].source.includes('==UserScript==')) fail('saved mod has no userscript header');

    await assertNoViolations('smoke');
    console.log('smoke: OK — streamed reply, 3 page-inspection tools, proposal card, save to storage, zero invalid requests');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Wait test: the agent can wait for the page instead of polling it.
// ---------------------------------------------------------------------------
//
// The owner's report was "it's not handling waiting for things well". This drives every kind of
// condition wait_for offers against a fixture page the mock server serves (/__fixture/async.html),
// and reads back, from /__requests, the exact tool result the model received for each one — not
// the transcript row, which is a truncated summary, but the text that actually went into the
// model's context and decides what it does next.
//
// The four things it proves that a unit test cannot:
//   1. an already-true condition costs ~nothing, so waiting stays cheap enough to keep choosing;
//   2. a style-only reveal is seen at all (the MutationObserver misses it; the polling floor is
//      what catches it), and late content and a pushState route change are seen too;
//   3. a timeout comes back as a diagnostic statement and is NOT flagged as an error;
//   4. Stop ends a 20s wait promptly and leaves no observer behind on the user's page.
//
// run_script and then_wait are absent on purpose: chrome.userScripts is unavailable in an
// automated profile (note 4 at the top of this file), so the page is driven through Playwright
// instead and then_wait's composition is covered in test/wait.test.ts.

const WAIT_PROMPT = 'test the waiting behaviour on this page';
const WAIT_STOP_PROMPT = 'wait a really long time for something';

/** The fixture page, served by the mock backend itself. */
const FIXTURE_URL = `${CONTROL_BASE}/__fixture/async.html`;

/**
 * Every wait_for result the model was handed, in order, read out of the recorded request bodies.
 *
 * The Nth request carries the results of every tool call made before it, so walking the requests
 * and collecting each `tool` message in order reconstructs exactly what the model saw. This is the
 * assertion surface that matters: a transcript row is a 160-character summary, and the whole point
 * of a timeout's diagnostics is the part that gets truncated away.
 */
async function waitToolResults() {
  const requests = await fetchRequests();
  const seen = new Map();
  for (const req of requests) {
    const byId = new Map();
    for (const m of req.messages ?? []) {
      if (m.role === 'assistant') {
        for (const call of m.tool_calls ?? []) byId.set(call.id, call.function?.name);
      }
      if (m.role === 'tool' && byId.get(m.tool_call_id) === 'wait_for' && !seen.has(m.tool_call_id)) {
        seen.set(m.tool_call_id, typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
      }
    }
  }
  return [...seen.values()];
}

async function waitFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`wait: ${m}`);
  };
  try {
    await clearViolations();
    await fetch(`${CONTROL_BASE}/__requests`, { method: 'DELETE' }).catch(() => {});

    const panel = await openPanel(b.ctx, b.extId);
    const site = await openSite(b.ctx, FIXTURE_URL);
    await waitForComposer(panel);

    // Turn on the content script's leftover-observer counter before anything waits, so the Stop
    // assertion below has a baseline. It is a test-only flag: an ordinary page never gets it.
    await site.evaluate(() => (globalThis.__usermodsWaitDebug = true));

    // The fixture only does anything when it is driven, and each wait in the scripted conversation
    // is waiting for one of these. They are fired on a timer rather than in lockstep with the
    // conversation because the point is that the agent copes with things happening on the page's
    // schedule, not on its own — and every one of them is slower than the step that waits for it.
    // The reveal is deliberately fired on its own, with a quiet gap on either side. It is the one
    // step whose whole point is that NOTHING mutates while it happens: if it were fired next to the
    // #load click, the .result insertion would wake the MutationObserver, the observer would
    // re-check every condition and find #fade visible, and the flow would pass with the polling
    // floor removed — which is exactly what it did before the gaps were put in.
    // How long the style-only reveal took to be noticed: the gap between the page flipping the CSS
    // rule and the wait's transcript row completing. Measured rather than inferred, because the
    // reported elapsed is relative to when the wait started, not to when the reveal happened.
    let revealLatency = null;

    const drive = (async () => {
      await site.waitForTimeout(400);
      await site.locator('#load').click(); // three .result items, 800ms later
      await site.waitForTimeout(2000); // let that settle completely

      // The reveal runs alone, with a quiet gap on either side. If it were fired next to the #load
      // click, the .result insertion would wake the MutationObserver, the observer would re-check
      // every condition and find #fade visible, and this step would pass with the polling floor
      // removed — which is exactly what it did before the gaps and this measurement went in.
      await site.locator('#reveal').click();
      const revealPoll = (async () => {
        // Wait for the page to actually flip the rule, then time how long until the row settles.
        await site.waitForFunction(() => globalThis.__revealedAt !== null, null, { timeout: 10_000 });
        const flippedAt = Date.now();
        await panel.waitForFunction(
          () => {
            const rows = [...document.querySelectorAll('.messages .tool summary')].filter((r) => r.textContent?.includes('#fade'));
            // A finished row has lost its amber "running" dot.
            return rows.length > 0 && rows.every((r) => !r.querySelector('.dot.running'));
          },
          null,
          { timeout: 15_000 },
        );
        revealLatency = Date.now() - flippedAt;
      })().catch(() => {});
      await revealPoll;
      await site.waitForTimeout(1200); // …and nothing else may touch the DOM while it lands
      await site.locator('#route').click(); // pushState to ?step=2, 300ms later
      await site.waitForTimeout(800);
      await site.locator('#churnstart').click(); // 1.5s of mutation, then quiet
    })();

    await panel.locator('textarea').fill(WAIT_PROMPT);
    await panel.locator('.composer button.btn.primary').click();

    // The conversation ends with a text-only step carrying the marker.
    await panel
      .locator('.messages .msg.assistant', { hasText: WAIT_MARKER })
      .waitFor({ timeout: 90_000 })
      .catch(async () => {
        const rows = await panel.locator('.messages .tool summary').allTextContents();
        fail(`the wait conversation never finished. Transcript rows: ${rows.join(' | ') || 'none'}`);
      });
    await drive.catch(() => {});

    // --- What the model was actually told, condition by condition.
    const results = await waitToolResults();
    if (results.length !== 7) fail(`expected 7 wait_for results, got ${results.length}:\n${results.join('\n---\n')}`);
    const [ready, late, faded, text, routed, settled, timedOut] = results;

    /** The elapsed time a "matched after N,NNNms" result reports. */
    const matchedMs = (s) => {
      const m = /matched after ([\d,]+)ms/.exec(s ?? '');
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };

    // 1. Already true: the condition holds before anything is installed, so this is the result that
    // decides whether waiting is cheap. An observer tick or a poll interval would show up here.
    const readyMs = matchedMs(ready);
    if (readyMs === null) fail(`the already-true condition did not report a match: ${JSON.stringify(ready)}`);
    if (readyMs >= 100) fail(`an already-true condition took ${readyMs}ms; it must return immediately, or the model learns waiting is expensive`);
    if (!/#ready/.test(ready)) fail(`the match did not name what matched: ${JSON.stringify(ready)}`);

    // 2. Content that arrives 800ms after a click, which is the case the model used to poll for.
    if (matchedMs(late) === null) fail(`the lazy-loaded results were never matched: ${JSON.stringify(late)}`);
    if (!/3 elements match \.result/.test(late)) fail(`the match did not report the count: ${JSON.stringify(late)}`);
    if (!/first: <li class="result"/.test(late)) fail(`the match did not describe the first element: ${JSON.stringify(late)}`);

    // 3. A reveal that mutates nothing at all — the page edits the CSS rule, not the element — so a
    // MutationObserver is structurally blind to it and only the polling floor can see it.
    //
    // The assertion is on LATENCY, not on the fact of a match. Any later mutation anywhere on the
    // page wakes the observer, which re-checks every condition and finds #fade visible, so "it
    // matched" passes even with the poll removed. What the floor actually guarantees is that the
    // reveal is noticed within a poll interval of happening, while nothing else is going on — and
    // the fixture records the moment it flipped the rule so that can be measured.
    if (matchedMs(faded) === null) fail(`the style-only reveal was never seen: ${JSON.stringify(faded)}`);
    const revealedAt = await site.evaluate(() => globalThis.__revealedAt ?? null);
    if (revealedAt === null) fail('the fixture never performed the style-only reveal, so this step proved nothing');
    if (revealLatency === null) fail('the flow did not record when the reveal was noticed');
    if (revealLatency > 1_000) {
      fail(`the style-only reveal took ${revealLatency}ms to be noticed — the polling floor under the MutationObserver is gone`);
    }

    // 4. Page text.
    if (matchedMs(text) === null) fail(`the page text was never matched: ${JSON.stringify(text)}`);
    if (!/Loaded three results/.test(text)) fail(`the text match did not name the text: ${JSON.stringify(text)}`);

    // 5. A pushState route change: no navigation, so only a URL watched from the background sees it.
    if (matchedMs(routed) === null) fail(`the SPA route change was never seen: ${JSON.stringify(routed)}`);
    if (!/step=2/.test(routed)) fail(`the url match did not report the new URL: ${JSON.stringify(routed)}`);

    // 6. "Wait until it stops changing."
    if (matchedMs(settled) === null) fail(`the DOM never settled: ${JSON.stringify(settled)}`);
    if (!/quiet/.test(settled)) fail(`the idle match did not say the DOM went quiet: ${JSON.stringify(settled)}`);

    // 7. The deliberate timeout — the outcome this whole design turns on.
    if (matchedMs(timedOut) !== null) fail(`the impossible condition somehow matched: ${JSON.stringify(timedOut)}`);
    if (!/^Timed out after/.test(timedOut)) fail(`the timeout did not state itself plainly: ${JSON.stringify(timedOut)}`);
    if (!/This is not an error/.test(timedOut)) fail(`the timeout did not tell the model it was not a failure: ${JSON.stringify(timedOut)}`);
    // The diagnostics are what let the model tell "never going to happen" from "still loading".
    if (!/0 elements match \.never-going-to-exist/.test(timedOut)) fail(`the timeout carried no element diagnostics: ${JSON.stringify(timedOut)}`);
    if (!/readyState=/.test(timedOut)) fail(`the timeout did not report the document state: ${JSON.stringify(timedOut)}`);

    // …and it is not painted as a failure. The transcript row takes the amber waiting dot, which is
    // the same dot a running row uses — never the coral error dot.
    const errorDots = await panel.locator('.messages .tool summary .dot.error').count();
    if (errorDots) fail(`${errorDots} wait row(s) were painted as errors; a timeout is a result, not a failure`);
    const rows = await panel.locator('.messages .tool summary').allTextContents();
    const waitRows = rows.filter((r) => r.includes('wait_for'));
    if (waitRows.length !== 7) fail(`expected 7 wait_for rows in the transcript, got ${waitRows.length}: ${rows.join(' | ')}`);
    // The row says WHAT was waited for, not just the tool name.
    if (!waitRows.some((r) => r.includes('.result'))) fail(`no transcript row named its condition: ${waitRows.join(' | ')}`);
    if (!waitRows.some((r) => r.includes('url '))) fail(`the url condition was not named in its row: ${waitRows.join(' | ')}`);

    // The page is left clean: every wait tore its observer down.
    const leftover = await site.evaluate(() => globalThis.__usermodsWaitObservers ?? 0);
    if (leftover !== 0) fail(`${leftover} observer(s) left behind on the page after the run finished`);

    // --- Stop during a long wait ends the run promptly, and leaves nothing behind.
    await panel.locator('textarea').fill(WAIT_STOP_PROMPT);
    await panel.locator('.composer button.btn.primary').click();
    // Wait until the run is genuinely inside the 20s wait before pressing Stop, so this measures
    // the cancellation and not the round trip to get there.
    await panel
      .locator('.activity', { hasText: 'waiting for' })
      .waitFor({ timeout: 30_000 })
      .catch(async () => fail(`the activity line never showed the wait (it said ${JSON.stringify(await panel.locator('.activity').textContent().catch(() => null))})`));

    // The line names the condition rather than going silent for 20s, and does NOT accuse the
    // provider of being stuck while a wait is legitimately in progress.
    const waitingLine = (await panel.locator('.activity').textContent())?.trim() ?? '';
    if (!/waiting for/.test(waitingLine)) fail(`the activity line did not name the wait: ${JSON.stringify(waitingLine)}`);
    if (/stuck/.test(waitingLine)) fail(`the panel called a legitimate wait a stall: ${JSON.stringify(waitingLine)}`);

    const stoppedAt = Date.now();
    await panel.locator('.composer button.btn.danger', { hasText: 'Stop' }).click();
    await panel.locator('.activity').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
    const stopTook = Date.now() - stoppedAt;
    // The whole complaint behind this work is an agent that sits there; a Stop that waits out a
    // 20s timeout is the same failure wearing a different hat.
    if (stopTook > 500) fail(`Stop took ${stopTook}ms to end a wait — it must not sit through the timeout`);

    const leftoverAfterStop = await site.evaluate(() => globalThis.__usermodsWaitObservers ?? 0);
    if (leftoverAfterStop !== 0) fail(`${leftoverAfterStop} observer(s) survived a cancelled wait`);

    await assertNoViolations('wait');
    console.log(
      `wait: OK — already-true in <100ms, lazy-loaded content, style-only reveal seen in ${revealLatency}ms, page text, pushState route change, DOM settle, a timeout with diagnostics and no error flag, Stop inside ${stopTook}ms, no leftover observers, zero invalid requests`,
    );
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Theme test: the default follows the OS, the toggle cycles and persists, and nothing flashes.
// ---------------------------------------------------------------------------
//
// The three things that can only be checked in a real browser:
//
//   1. A fresh profile follows the emulated OS scheme. That is the changed default ('system'), and
//      it is the one behaviour a unit test cannot see, because it depends on the media query.
//   2. The toggle cycles, persists across a reload, and the reloaded page paints the right palette
//      on its FIRST frame. The flash is the whole point: an init script samples the computed
//      background before any of the page's own script has run, so a panel that started dark and
//      corrected itself would be caught rather than looking fine by the time we screenshot it.
//   3. `color-scheme` follows the theme, which is what makes native selects, checkboxes, date
//      inputs and scrollbars render light rather than staying dark on a light panel.

/** What the document is actually wearing, by the tokens the theme sets. */
async function themeState(page) {
  return await page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return {
      attr: document.documentElement.getAttribute('data-theme'),
      colorScheme: cs.colorScheme,
      // --bg-app is the clearest single tell: near-black in dark, near-white in light.
      bgApp: cs.getPropertyValue('--bg-app').trim(),
      toggleTitle: document.querySelector('.theme-toggle')?.getAttribute('title') ?? null,
    };
  });
}

/** 'dark' or 'light', read from --bg-app rather than from what we asked for. */
function paletteOf(bgApp) {
  const m = /^#?([0-9a-f]{6})$/i.exec(bgApp.replace(/\s/g, ''));
  if (!m) throw new Error(`--bg-app is not a plain hex colour: ${JSON.stringify(bgApp)}`);
  const n = parseInt(m[1], 16);
  const lum = ((n >> 16) & 255) * 0.299 + ((n >> 8) & 255) * 0.587 + (n & 255) * 0.114;
  return lum < 128 ? 'dark' : 'light';
}

async function themeFlow() {
  const fail = (m) => {
    throw new Error(`theme: ${m}`);
  };

  // --- 1. A fresh profile follows the OS, both ways -------------------------
  for (const os of ['light', 'dark']) {
    const b = await launch(os);
    try {
      const page = await b.ctx.newPage();
      await page.goto(`chrome-extension://${b.extId}/sidepanel.html`);
      // Nothing seeded: this is what someone sees the first time they open the panel.
      const s = await themeState(page);
      if (paletteOf(s.bgApp) !== os) {
        fail(`a fresh profile on a ${os} OS painted the ${paletteOf(s.bgApp)} palette (--bg-app ${s.bgApp})`);
      }
      if (s.attr !== null) fail(`a fresh profile should leave data-theme off (System), got ${JSON.stringify(s.attr)}`);
      // On System the right answer is either the resolved scheme or the literal `light dark` that
      // defers to the OS — both make native controls follow it. What would be wrong is the
      // opposite scheme pinned.
      if (s.colorScheme !== os && s.colorScheme !== 'light dark') {
        fail(`color-scheme on a ${os} OS was ${JSON.stringify(s.colorScheme)}`);
      }
    } finally {
      await b.close();
    }
  }
  log('theme: a fresh profile follows the OS, light and dark');

  // --- 2. The toggle cycles, persists, and does not flash -------------------
  const b = await launch('dark');
  try {
    const panel = await openPanel(b.ctx, b.extId, { settings: { theme: 'dark' } });
    await panel.waitForTimeout(400);

    const toggle = panel.locator('.theme-toggle');
    if (!(await toggle.count())) fail('no theme toggle in the side panel tab bar');
    if (!(await themeState(panel)).toggleTitle?.includes('Dark')) fail('the toggle does not name the current theme');

    // Dark -> Light -> System -> Dark, checking the palette really changes under the click.
    for (const [from, to] of [['dark', 'light'], ['light', 'system'], ['system', 'dark']]) {
      const before = await themeState(panel);
      if (before.attr !== (from === 'system' ? null : from)) {
        fail(`expected to be on ${from}, data-theme is ${JSON.stringify(before.attr)}`);
      }
      await toggle.click();
      await panel.waitForTimeout(250);
      const after = await themeState(panel);
      const wanted = to === 'system' ? null : to;
      if (after.attr !== wanted) fail(`clicking from ${from} gave data-theme ${JSON.stringify(after.attr)}, wanted ${JSON.stringify(wanted)}`);
      const stored = await panel.evaluate(async () => (await chrome.storage.local.get('settings')).settings?.theme);
      if (stored !== to) fail(`clicking from ${from} stored ${JSON.stringify(stored)}, wanted ${to}`);
    }
    log('theme: the toggle cycles Dark -> Light -> System and persists each step');

    // Settle on light, then reload and sample the very first paint.
    await toggle.click(); // dark -> light
    await panel.waitForTimeout(250);
    if ((await themeState(panel)).attr !== 'light') fail('expected to be on light before the reload check');

    // The init script runs before any page script, so this is the first frame's background.
    await panel.addInitScript(() => {
      // An init script runs before the document has an element, and before the stylesheet has been
      // applied, so sampling immediately would read nothing. requestAnimationFrame fires just
      // before the browser paints: whatever is computed then is what the user's first frame shows.
      const sample = () => {
        try {
          const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim();
          if (v) window.__firstPaintBg ??= v;
        } catch {
          /* nothing to read yet */
        }
      };
      requestAnimationFrame(() => {
        sample();
        requestAnimationFrame(sample);
      });
      document.addEventListener('DOMContentLoaded', sample, { once: true });
    });
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await panel.waitForTimeout(400);

    const first = await panel.evaluate(() => window.__firstPaintBg ?? null);
    if (!first) fail('could not sample the first paint background');
    if (paletteOf(first) !== 'light') {
      fail(`the panel painted the ${paletteOf(first)} palette on its first frame after a reload on light (--bg-app ${first}) — that is the dark flash`);
    }
    const afterReload = await themeState(panel);
    if (afterReload.attr !== 'light') fail(`the choice did not survive a reload: data-theme ${JSON.stringify(afterReload.attr)}`);
    log('theme: the choice survives a reload and the first paint is already light — no flash');

    // --- 3. Native controls follow the theme -------------------------------
    if (afterReload.colorScheme !== 'light') {
      fail(`color-scheme on a light panel was ${JSON.stringify(afterReload.colorScheme)} — native selects and scrollbars would stay dark`);
    }
    // And the other way, so this is not just a light-only assertion.
    await toggle.click(); // light -> system
    await toggle.click(); // system -> dark
    await panel.waitForTimeout(250);
    const dark = await themeState(panel);
    if (dark.colorScheme !== 'dark') fail(`color-scheme on a dark panel was ${JSON.stringify(dark.colorScheme)}`);
    log('theme: color-scheme matches the theme in both directions');

    // The install page is a second entry point and reads the same setting.
    const install = await b.ctx.newPage();
    await install.goto(`chrome-extension://${b.extId}/install.html`);
    await install.waitForTimeout(400);
    const ip = await themeState(install);
    if (ip.attr !== 'dark') fail(`the install page ignored the saved choice: data-theme ${JSON.stringify(ip.attr)}`);
    if (!(await install.locator('.theme-toggle').count())) fail('no theme toggle on the install page');
    log('theme: the install page wears the same saved choice and carries the toggle');

    // --- 4. The dashboard is the third entry point, and the one a flash costs most -----------
    //
    // It is a full tab rather than a 420px strip, so a frame of the wrong palette is a whole
    // screen of it. It gets the same three checks the panel does: the saved choice on the first
    // paint, the toggle, and color-scheme for its native selects and scrollbars.
    const dash = await b.ctx.newPage();
    await dash.addInitScript(() => {
      const sample = () => {
        try {
          const v = getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim();
          if (v) window.__firstPaintBg ??= v;
        } catch {
          /* nothing to read yet */
        }
      };
      requestAnimationFrame(() => {
        sample();
        requestAnimationFrame(sample);
      });
      document.addEventListener('DOMContentLoaded', sample, { once: true });
    });
    await dash.goto(`chrome-extension://${b.extId}/dashboard.html`);
    await dash.locator('[data-testid="overview"]').waitFor({ timeout: 15_000 });
    const dashFirst = await dash.evaluate(() => window.__firstPaintBg ?? null);
    if (!dashFirst) fail('could not sample the dashboard first paint background');
    if (paletteOf(dashFirst) !== 'dark') {
      fail(`the dashboard painted the ${paletteOf(dashFirst)} palette on its first frame with dark saved (--bg-app ${dashFirst}) — that is the flash, a full tab of it`);
    }
    const ds = await themeState(dash);
    if (ds.attr !== 'dark') fail(`the dashboard ignored the saved choice: data-theme ${JSON.stringify(ds.attr)}`);
    if (ds.colorScheme !== 'dark') fail(`color-scheme on the dark dashboard was ${JSON.stringify(ds.colorScheme)}`);
    const dashToggle = dash.locator('.theme-toggle');
    if (!(await dashToggle.count())) fail('no theme toggle in the dashboard header');

    // And it cycles there too, restyling the page under the cursor rather than after a reload.
    await dashToggle.click(); // dark -> light
    await dash.waitForTimeout(300);
    const dsLight = await themeState(dash);
    if (dsLight.attr !== 'light') fail(`the dashboard toggle gave data-theme ${JSON.stringify(dsLight.attr)}`);
    if (paletteOf(dsLight.bgApp) !== 'light') fail(`the dashboard did not repaint light (--bg-app ${dsLight.bgApp})`);
    if (dsLight.colorScheme !== 'light') fail(`color-scheme on the light dashboard was ${JSON.stringify(dsLight.colorScheme)}`);
    log('theme: the dashboard wears the saved choice with no flash, and its toggle repaints the page');

    console.log('theme: OK — OS default, cycling toggle, persistence with no first-paint flash, color-scheme both ways, all three entry points');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Guardrails test: the loop pushes back on over-investigation and on an untested proposal.
// ---------------------------------------------------------------------------
//
// Both fixes work by putting text into the conversation, so the panel is only half the evidence:
// the assertions that matter read what the extension actually SENT, which mock-llm.mjs records at
// GET /__requests. The scripted conversation is `guardrails` in scripts/mock-llm.mjs.

/**
 * Every message body the extension has sent to the mock so far, flattened to one string. The
 * nudges and the propose_mod refusal are text the loop appends to a tool-results message, so this
 * is the only place they become observable — the panel shows the tool row, not what was sent.
 */
async function sentToModel() {
  const res = await fetch(`http://127.0.0.1:${PORT}/__requests`);
  if (!res.ok) throw new Error(`mock /__requests returned ${res.status}`);
  const { requests } = await res.json();
  return requests
    .flatMap((r) => r.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => p.text ?? '').join('\n') : ''))
    .join('\n---\n');
}

async function guardrails() {
  // Start from an empty log so nothing asserted here can be satisfied by a previous flow's traffic.
  await fetch(`http://127.0.0.1:${PORT}/__requests`, { method: 'DELETE' });
  await clearViolations();
  const b = await launch('light');
  try {
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);
    await runConversation(panel, 'tidy up the references section');

    const fail = (m) => {
      throw new Error(`guardrails: ${m}`);
    };

    const sent = await sentToModel();

    // FIX 4: four reads with nothing acted on, and the nudge reached the model in a later request.
    if (!/You have made 4 page reads without running or proposing anything/.test(sent)) {
      fail('the read-budget nudge never reached the mock');
    }
    if (!/Act now: test with run_script or ask the user one question/.test(sent)) {
      fail('the read-budget nudge reached the mock without its instruction');
    }

    // FIX 6: the first propose_mod had no run_script behind it, so the loop refused it and said so.
    if (!/Test the script with run_script before proposing it/.test(sent)) {
      fail('propose_mod without a test was not refused, or the refusal never reached the mock');
    }

    // The refusal was a recoverable tool error, not the end of the turn: the second propose_mod,
    // carrying untested_reason, was accepted and the card names the reason for the user.
    const cards = await panel.locator('.messages .card h4').count();
    if (cards !== 1) fail(`expected exactly one proposal card, got ${cards}`);
    // Asserted on the line itself, not just the card's text, because the capture path masks this
    // line with CSS (HIDE_UNTESTED_LINE). This flow must see it RENDERED: if the mask ever leaked
    // out of the capture path into the asserting flows, isVisible() is what would catch it.
    const untested = panel.locator('.messages .card .label.untested');
    if ((await untested.count()) !== 1) fail(`expected 1 untested line on the card, got ${await untested.count()}`);
    if (!(await untested.first().isVisible())) fail('the untested line is in the DOM but not visible to the user');
    const untestedText = (await untested.first().textContent()) ?? '';
    if (!untestedText.includes('not tested on this page')) fail(`untested line read ${JSON.stringify(untestedText)}`);
    if (!untestedText.includes('scripts cannot be run in this browser profile')) {
      fail('the proposal card does not show the untested reason');
    }

    // The refused call is visible in the transcript as a failed tool row, which is how the user
    // sees that the agent corrected itself rather than silently doing the wrong thing.
    const refused = await panel.locator('.messages details.tool.error summary', { hasText: 'propose_mod' }).count();
    if (refused !== 1) fail(`expected 1 refused propose_mod row, got ${refused}`);

    // This flow is the one that most needs the check: a refused propose_mod is a tool ERROR, and
    // the nudges are extra text parts appended to the same tool-results message. Both are exactly
    // the shapes that can separate a tool call from its result if anything mishandles them.
    await assertNoViolations('guardrails');

    console.log('guardrails: OK — read-budget nudge and propose-time refusal both reached the model, override accepted, zero invalid requests');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Activity test: the panel says what it is doing while it is doing it.
// ---------------------------------------------------------------------------
//
// The owner's complaint was that a run gave no sign of life, so this asserts the sign of life is
// there: it appears at once, it names the phase, its timer moves, it follows the run into a tool
// call, and it is gone the moment the run ends. The 'take your time' script in mock-llm.mjs holds
// its first byte for ~3s so there is a real waiting window to observe.

const THINKING_PROMPT = 'take your time and tell me what this page is';

async function activityFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`activity: ${m}`);
  };
  try {
    await clearViolations();
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);

    const indicator = panel.locator('.activity');
    if (await indicator.count()) fail('the activity line was showing before anything had been sent');

    // A tool phase can be over in a few milliseconds, so sampling the DOM from here would be a
    // coin flip. Record every distinct value the line takes instead, from inside the page.
    await installActivityRecorder(panel);

    // --- 1. It appears on SEND, not on the first byte from the backend. The mock deliberately
    // stays silent for 3s (firstByteDelay in scripts/mock-llm.mjs), so the whole content of this
    // check is that the line is up well before the backend has said anything.
    //
    // The bound is 1.5s rather than a few hundred ms on purpose. What is being timed from here is
    // not the render: it is a Playwright click round-trip, plus the port connect, plus waking the
    // extension's service worker, which on a cold profile is most of the budget and scales with
    // how loaded the host is. A tighter bound measures the machine rather than the product — it
    // failed here at 534ms, 850ms and 957ms on an unchanged build, including at 2b2796c before any
    // of this branch's work. 1.5s is still only half the mock's silence, so a line that genuinely
    // waited for the backend fails this as loudly as it ever did.
    const APPEAR_BUDGET_MS = 1_500;
    await panel.locator('textarea').fill(THINKING_PROMPT);
    const sentAt = Date.now();
    await panel.locator('.composer button.btn.primary').click();
    await indicator.waitFor({ timeout: 5_000 });
    const appearedIn = Date.now() - sentAt;
    if (appearedIn > APPEAR_BUDGET_MS) {
      fail(`the activity line took ${appearedIn}ms to appear, longer than the ${APPEAR_BUDGET_MS}ms it promises`);
    }

    // --- 2. During the delay it says it is waiting for the model, and its timer ticks.
    //
    // Both facts are read from ONE snapshot of the line. Reading the label and then re-reading the
    // DOM for the timer is a race: the run can leave the model phase between the two reads, and
    // the tool label carries no "Ns", so readTimer came back null while the message printed the
    // stale label — "the line showed no elapsed timer (it said "waiting for model·0s")", which
    // accuses the timer of being absent and then quotes it.
    const waitingText = (await indicator.textContent())?.trim() ?? '';
    if (!/waiting for model/i.test(waitingText)) fail(`the line did not say it was waiting for the model (it said ${JSON.stringify(waitingText)})`);

    const firstTimer = parseTimer(waitingText);
    if (firstTimer === null) fail(`the line showed no elapsed timer (it said ${JSON.stringify(waitingText)})`);

    // Wait for the timer to actually advance rather than sampling twice across a fixed sleep. The
    // line renders WHOLE seconds, so a fixed window only reliably shows a change if it is safely
    // longer than a second of real time — and under load the two reads landed inside the same
    // second and both said "0s", failing a timer that was ticking perfectly well. Polling for the
    // change tests the same property (it advances) without betting on the host's timing.
    let secondTimer = firstTimer;
    const tickDeadline = Date.now() + 8_000;
    while (Date.now() < tickDeadline) {
      await panel.waitForTimeout(250);
      const t = await readTimer(panel);
      if (t !== null && t > firstTimer) {
        secondTimer = t;
        break;
      }
    }
    if (secondTimer <= firstTimer) {
      fail(`the elapsed timer did not tick: it read ${firstTimer}s and was still ${secondTimer}s 8s later`);
    }

    // --- 3. It follows the run into the tool call. A tool phase can be short, so rather than poll
    // and hope to sample inside it, the recorder installed above has every value the line took.
    const sawTool = await waitForRecorded(panel, /get_page|find_elements/, 30_000);
    if (!sawTool) {
      const seen = await recorded(panel);
      const tools = await panel.locator('.messages .tool summary').allTextContents();
      fail(`the line never showed the tool it was running. It showed: ${JSON.stringify(seen)}; transcript rows: ${tools.join(' | ') || 'none'}`);
    }

    // --- 4. It is gone once the run is over. The second scripted step is text-only, so 'done'
    // follows it; the line must not linger.
    await indicator.waitFor({ state: 'detached', timeout: 60_000 }).catch(() => {});
    if (await indicator.count()) {
      fail(`the activity line was still on screen after the run finished (it said ${JSON.stringify((await indicator.textContent())?.trim())})`);
    }
    // And the run really did finish, rather than the line vanishing for some other reason.
    const replies = await panel.locator('.messages .msg.assistant').allTextContents();
    if (!replies.some((t) => t.includes('article title'))) fail(`the scripted conversation did not finish (assistant said: ${replies.join(' | ')})`);

    if (process.env.ACTIVITY_VERBOSE) console.log('[activity] the line showed:', await recorded(panel));
    await assertNoViolations('activity');
    console.log('activity: OK — appears on send, waiting label with a ticking timer, tool label, gone after done');

  } finally {
    await b.close();
  }
}

/** The elapsed seconds in one already-read line of activity text, or null if it shows none. */
function parseTimer(text) {
  const m = text?.match(/(\d+)s(?!\w)/);
  return m ? Number(m[1]) : null;
}

/** The elapsed seconds the line is showing right now, or null if it is not showing one. */
async function readTimer(panel) {
  return parseTimer(await panel.locator('.activity').textContent().catch(() => null));
}

/**
 * Watch the panel's DOM and keep every distinct string the activity line has shown. A tool phase
 * can last a couple of milliseconds, which no amount of polling from the test process would catch
 * reliably; a MutationObserver inside the page sees all of them.
 */
async function installActivityRecorder(panel) {
  await panel.evaluate(() => {
    const seen = [];
    globalThis.__activitySeen = seen;
    const sample = () => {
      const el = document.querySelector('.activity');
      const text = el?.textContent?.trim();
      if (text && seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, childList: true, characterData: true });
    sample();
  });
}

/** Everything the activity line has shown since the recorder was installed. */
async function recorded(panel) {
  return panel.evaluate(() => globalThis.__activitySeen ?? []);
}

/** Wait until the line has shown something matching, at any point since the recorder went in. */
async function waitForRecorded(panel, re, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const seen = await recorded(panel).catch(() => []);
    const hit = seen.find((t) => re.test(t));
    if (hit) return hit;
    await panel.waitForTimeout(100);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Chats test: the panel always comes back to the last chat, and archiving is what takes it away.
// ---------------------------------------------------------------------------

const PROMPT = 'hide the sidebar and make the article full width';
const PROPOSAL_TITLE = 'Wikipedia: full-width article';

/**
 * What the mock replies to the title call, once lib/title.ts has stripped the quotes and the
 * trailing period the mock deliberately wraps it in. Kept as a literal rather than imported from
 * mock-llm.mjs, because importing that file starts a second server on the same port.
 */
const MODEL_TITLE = 'Full-width Wikipedia articles';

/** The label of the option the switcher currently has selected. */
function selectedLabel(panel) {
  return panel.locator('.chatbar select option:checked').textContent();
}

/** Wait until the switcher's selected option contains `text`, or give up and return what it says. */
async function waitForSwitcherLabel(panel, text, timeout = 25_000) {
  const until = Date.now() + timeout;
  let label = '';
  while (Date.now() < until) {
    label = (await selectedLabel(panel).catch(() => '')) ?? '';
    if (label.includes(text)) return label;
    await panel.waitForTimeout(250);
  }
  return label;
}

/** Reload the panel tab the way a user reopening the side panel would (reloadPanel), and settle. */
async function reopenPanel(panel) {
  await reloadPanel(panel);
  // Long enough for the host lookup, the chat lookup and the transcript read to all resolve.
  await panel.waitForTimeout(2500);
}

/** The switcher's options, as "<group>/<label>" so the Archived group can be asserted on. */
async function switcherOptions(panel) {
  return panel.locator('.chatbar select').evaluate((sel) =>
    [...sel.querySelectorAll('option')].map((o) => `${o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : ''}/${o.textContent}`),
  );
}

/**
 * Put the chat switcher into rename mode, and prove it got there.
 *
 * Rename and Save are the same slot in the chatbar: whichever one React renders depends on
 * `renaming`, so entering and leaving rename mode replaces that button element rather than
 * changing it. Playwright resolves the locator, then clicks — and when the swap lands in between,
 * it clicks a node that is no longer in the document and retries until the 30s timeout, with a log
 * that ends at "performing click action" and never says why. (That is a real failure this flow hit
 * on the second rename, the one that follows an Escape.)
 *
 * So: click, and if the input did not appear, click again. The button is idempotent — it only ever
 * sets rename mode on — so a retry costs nothing and the wait is on the state that matters.
 */
async function startRename(panel, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    await panel.locator('.chatbar button.btn', { hasText: 'Rename' }).click({ timeout: 10_000 }).catch(() => {});
    try {
      await panel.locator('.chatbar input.rename').waitFor({ timeout: 3000 });
      return;
    } catch {
      /* the button was swapped out from under the click; try again */
    }
  }
  throw new Error('chats: the switcher never entered rename mode');
}

async function chatsFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`chats: ${m}`);
  };
  try {
    await clearViolations();
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);

    // --- 1. A real conversation, so there is something to come back to.
    await runConversation(panel, PROMPT);
    const firstTitle = (await panel.locator('.messages .card h4').first().textContent())?.trim();
    if (firstTitle !== PROPOSAL_TITLE) fail(`the conversation did not produce the expected proposal (got ${JSON.stringify(firstTitle)})`);

    // The switcher must show a real title straight away — the background writes the first-message
    // one while the run starts, and the panel used to keep saying "New chat" until the next reload.
    // By now the model's title may already have replaced it (that is asserted next), so either the
    // truncated first message or the model's name counts; "New chat" does not.
    const liveLabel = await selectedLabel(panel);
    const namedAtAll = liveLabel?.includes(PROMPT.slice(0, 20)) || liveLabel?.includes(MODEL_TITLE);
    if (!namedAtAll) fail(`the switcher still showed ${JSON.stringify(liveLabel)} instead of the chat's title right after the first send`);

    // --- 1b. …and once the turn is done, the model's own title replaces it, live, over the port.
    const named = await waitForSwitcherLabel(panel, MODEL_TITLE);
    if (!named.includes(MODEL_TITLE)) fail(`the switcher never took the model's title: it still reads ${JSON.stringify(named)}`);
    const namedRecord = await panel.evaluate(async () => ((await chrome.storage.local.get('chats')).chats ?? [])[0]);
    if (namedRecord?.title !== MODEL_TITLE) fail(`the model title was not stored (chat record title: ${JSON.stringify(namedRecord?.title)})`);
    if (namedRecord?.titleSource !== 'auto-model') fail(`the stored titleSource was ${JSON.stringify(namedRecord?.titleSource)}, not "auto-model"`);

    // --- 1c. The chat is finished, so the composer says so. The naming call posts its title AFTER
    // 'done', and the panel used to read any event as proof the chat was running again — which put
    // Stop and Queue back on screen permanently, next to an activity line that had correctly gone
    // away. A chat that has stopped must offer Send.
    await panel.waitForTimeout(400);
    const settled = await panel.locator('.composer .btn').allTextContents();
    if (settled.includes('Stop')) fail(`the composer still offered Stop after the run finished and was renamed: ${settled.join(' | ')}`);
    if (!settled.includes('Send')) fail(`the composer did not go back to Send after the run finished: ${settled.join(' | ')}`);
    if (await panel.locator('.activity').count()) fail('the activity line was still up after the run finished');

    // --- 2. Reopening the panel restores that chat with no click at all.
    await reopenPanel(panel);
    const restoredUser = await panel.locator('.messages .msg.user').first().textContent();
    if (!restoredUser?.includes(PROMPT)) fail(`after reopening, the user message was not restored (messages pane held ${JSON.stringify(restoredUser)})`);
    const restoredCard = (await panel.locator('.messages .card h4').first().textContent())?.trim();
    if (restoredCard !== PROPOSAL_TITLE) fail(`after reopening, the proposal card was not restored (got ${JSON.stringify(restoredCard)})`);
    if (await panel.locator('.messages .empty').count()) fail('the empty state was showing even though a chat was restored');

    // --- 3. New chat is the only thing that empties the composer...
    await panel.locator('.composer button.btn', { hasText: 'New chat' }).click();
    await panel.waitForTimeout(400);
    if (await panel.locator('.messages .msg.user').count()) fail('New chat left the previous transcript on screen');
    if (!(await panel.locator('.messages .empty').count())) fail('New chat did not show the empty state');

    // --- 4. ...and an unsent new chat is not persisted: reopening returns to the real one.
    await reopenPanel(panel);
    const afterNew = await panel.locator('.messages .msg.user').first().textContent();
    if (!afterNew?.includes(PROMPT)) fail(`reopening after an unsent New chat did not return to the last real chat (got ${JSON.stringify(afterNew)})`);
    const stored = await panel.evaluate(async () => (await chrome.storage.local.get('chats')).chats ?? []);
    if (stored.length !== 1) fail(`an unsent New chat was persisted: the index holds ${stored.length} chats`);

    // --- 5. Archiving takes it out of the default view, into an Archived group.
    const archiveBtn = panel.locator('.chatbar button.btn', { hasText: 'Archive' });
    if (!(await archiveBtn.count())) fail('the switcher had no Archive button');
    await archiveBtn.click();
    await panel.waitForTimeout(600);
    if (!(await panel.locator('.messages .empty').count())) fail('archiving the only chat did not leave the empty state');
    if (await panel.locator('.messages .msg.user').count()) fail('the archived chat was still on screen after archiving');

    // The chat is identified by whatever it is now called — by this point the model has named it,
    // so matching on the raw prompt would only ever find the option before the first turn finished.
    let options = await switcherOptions(panel);
    if (!options.some((o) => o.startsWith('Archived/') && o.includes(MODEL_TITLE))) {
      fail(`the archived chat was not under an "Archived" group (options: ${JSON.stringify(options)})`);
    }
    if (options.some((o) => o.startsWith('/') && o.includes(MODEL_TITLE))) {
      fail(`the archived chat was still in the main list (options: ${JSON.stringify(options)})`);
    }

    // It stays archived across a reopen: the panel must not resurrect it.
    await reopenPanel(panel);
    if (await panel.locator('.messages .msg.user').count()) fail('reopening restored an archived chat, which the owner asked it never to do');

    // --- 6. Selecting the archived chat opens it read-write, with Unarchive and Delete.
    const archivedValue = await panel.locator('.chatbar select optgroup[label="Archived"] option').first().getAttribute('value');
    if (!archivedValue) fail('no archived option to select');
    await panel.locator('.chatbar select').selectOption(archivedValue);
    await panel.waitForTimeout(1200);
    const openedUser = await panel.locator('.messages .msg.user').first().textContent();
    if (!openedUser?.includes(PROMPT)) fail(`selecting the archived chat did not open its transcript (got ${JSON.stringify(openedUser)})`);
    if (!(await panel.locator('.chatbar button.btn', { hasText: 'Unarchive' }).count())) fail('an open archived chat offered no Unarchive button');
    if (!(await panel.locator('.chatbar button.btn.danger', { hasText: 'Delete' }).count())) fail('an open archived chat offered no Delete button');

    // --- 7. Renaming by hand: the select becomes an input, Escape abandons it, Enter commits.
    const MY_NAME = 'Kingfisher reading layout';
    await startRename(panel);
    await panel.locator('.chatbar input.rename').fill('this one is abandoned');
    await panel.locator('.chatbar input.rename').press('Escape');
    await panel.waitForTimeout(400);
    if (await panel.locator('.chatbar input.rename').count()) fail('Escape did not take the switcher out of rename mode');
    const afterEscape = await selectedLabel(panel);
    if (afterEscape?.includes('abandoned')) fail(`Escape saved the abandoned name anyway (switcher reads ${JSON.stringify(afterEscape)})`);

    await startRename(panel);
    await panel.locator('.chatbar input.rename').fill(MY_NAME);
    await panel.locator('.chatbar input.rename').press('Enter');
    await panel.waitForTimeout(600);
    if (await panel.locator('.chatbar input.rename').count()) fail('Enter did not take the switcher out of rename mode');
    const renamed = await selectedLabel(panel);
    if (!renamed?.includes(MY_NAME)) fail(`the rename did not reach the switcher (it reads ${JSON.stringify(renamed)})`);
    const userNamed = await panel.evaluate(async () => ((await chrome.storage.local.get('chats')).chats ?? [])[0]);
    if (userNamed?.titleSource !== 'user') fail(`a hand-typed rename stored titleSource ${JSON.stringify(userNamed?.titleSource)} instead of "user"`);

    // --- 8. Sending in an archived chat brings it back to life — and the user's name survives it.
    await panel.locator('textarea').fill('and dim the images a little');
    await panel.locator('.composer button.btn.primary').click();
    await panel.waitForTimeout(1500);
    await panel.locator('.chatbar button.btn', { hasText: 'Archive' }).waitFor({ timeout: 20_000 }).catch(() => {});
    // Long enough for a title call to have landed, had the chat been eligible for one.
    await panel.waitForTimeout(3000);
    await reopenPanel(panel);
    const revived = await panel.locator('.messages .msg.user').first().textContent();
    if (!revived?.includes(PROMPT)) fail(`sending in an archived chat did not unarchive it: reopening showed ${JSON.stringify(revived)}`);
    options = await switcherOptions(panel);
    if (options.some((o) => o.startsWith('Archived/'))) fail(`the chat was still in the Archived group after a send (options: ${JSON.stringify(options)})`);

    const survived = await selectedLabel(panel);
    if (!survived?.includes(MY_NAME)) fail(`a later turn overwrote the name the user chose: the switcher reads ${JSON.stringify(survived)}`);
    const finalRecord = await panel.evaluate(async () => ((await chrome.storage.local.get('chats')).chats ?? [])[0]);
    if (finalRecord?.title !== MY_NAME) fail(`the stored title was changed after a user rename (now ${JSON.stringify(finalRecord?.title)})`);
    if (finalRecord?.titleSource !== 'user') fail(`titleSource fell back to ${JSON.stringify(finalRecord?.titleSource)} after a later turn`);

    await assertNoViolations('chats');
    console.log('chats: OK — model title live on the port, user rename sticks through a later turn, last chat restored on reopen, New chat not persisted, archive hides and unarchives on send');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Isolation test: two chats, two tabs, two hosts, one side panel — and no bleed between them.
//
// This is the regression test for the bug the owner reported with a screenshot: a run started in
// one chat kept streaming into whatever chat was on screen, so a GitHub conversation answered with
// another site's output. The background used to keep ONE session per panel port (one `running`
// flag, one queue, one AbortController) and events carried no chat id, so the panel had nothing to
// route on and simply appended everything to the visible transcript — and then saved it there.
//
// What is asserted, in order of how badly each one bit:
//   1. B's transcript contains B's marker and never A's, while A is still running.
//   2. A's transcript, on switching back, holds A's FULL output — including the part that streamed
//      while B was on screen — and never B's text.
//   3. Both survive a panel reload, i.e. what was persisted is clean, not just what was rendered.
//   4. Over /__requests: no request for conversation A carries B's user text, and vice versa. This
//      is the invisible half — B's message used to be pushed onto A's queue and injected into A's
//      model conversation, which no transcript would show.
//   5. Stop pressed in B does not abort A.
// ---------------------------------------------------------------------------

const SLOW_PROMPT = 'walk the ancestry of the slow marker on this page';
const FAST_PROMPT = 'name the fast marker for this site';

/** The panel's transcript as plain text, for "contains / does not contain" assertions. */
async function transcriptText(panel) {
  return (await panel.locator('.messages').innerText()).trim();
}

/** Every chat's stored transcript, straight out of chrome.storage.local. */
async function storedTranscripts(panel) {
  return panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('chat:') && k.endsWith(':items')) out[k.slice(5, -6)] = JSON.stringify(v);
    }
    return out;
  });
}

/** Every chat's stored MODEL history, which is what actually went to the provider. */
async function storedMessages(panel) {
  return panel.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith('chat:') && k.endsWith(':messages')) out[k.slice(5, -9)] = JSON.stringify(v);
    }
    return out;
  });
}

async function isolationFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`isolation: ${m}`);
  };
  try {
    await clearViolations();
    const panel = await openPanel(b.ctx, b.extId);

    // --- Tab 1: the slow chat, A.
    const tab1 = await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);
    await panel.locator('textarea').fill(SLOW_PROMPT);
    await panel.locator('.composer button.btn.primary').click();

    // The Stop button is the panel saying "the chat you are looking at is running".
    await panel.locator('.composer button.btn.danger', { hasText: 'Stop' }).waitFor({ timeout: 10_000 });

    // --- Tab 2 on a DIFFERENT host, while A is still waiting for its first byte.
    const tab2 = await openSite(b.ctx, 'https://example.com/');
    await panel.waitForTimeout(1500);

    const afterSwitch = await transcriptText(panel);
    if (afterSwitch.includes(SLOW_PROMPT)) fail(`switching hosts left chat A's message on screen: ${JSON.stringify(afterSwitch.slice(0, 200))}`);
    if (await panel.locator('.composer button.btn.danger', { hasText: 'Stop' }).count()) {
      fail('the new, empty chat B showed a Stop button: "busy" is still panel-wide rather than per chat');
    }

    // Stop in B must not touch A. There is nothing running in B, so this is the clean version of
    // the old bug where the button aborted whatever the port last started.
    await panel.locator('textarea').fill(FAST_PROMPT);
    await panel.locator('.composer button.btn.primary').click();
    // .first(): B's reply can render as more than one assistant bubble while it streams, and this
    // is only a wait for the answer to have arrived — the bleed assertions below do the real work.
    await panel.locator('.messages .msg.assistant', { hasText: FAST_MARKER }).first().waitFor({ timeout: 30_000 });
    // B has answered; pressing Stop here is the user tidying up their own chat.
    const stopInB = panel.locator('.composer button.btn.danger', { hasText: 'Stop' });
    if (await stopInB.count()) await stopInB.click();

    const bText = await transcriptText(panel);
    if (!bText.includes(FAST_MARKER)) fail(`chat B did not get its own answer (transcript: ${JSON.stringify(bText.slice(0, 300))})`);
    if (bText.includes(SLOW_MARKER)) fail(`chat A's output bled into chat B's transcript: ${JSON.stringify(bText.slice(0, 400))}`);
    if (bText.includes(SLOW_PROMPT)) fail(`chat A's user message appeared in chat B: ${JSON.stringify(bText.slice(0, 400))}`);

    // --- Let A finish while B is on screen, then go back to it.
    //
    // Wait for A's run to actually be over rather than sleeping a fixed 12s and hoping. A is
    // offscreen here, so the only honest signal is what the background has PERSISTED for it: poll
    // until some stored transcript carries A's "step two". A flat sleep made this assertion fail
    // spuriously under load — the transcript came back ending at `get_page`, i.e. A was simply
    // still running, which reads exactly like the real bug this check exists to catch.
    const tailDeadline = Date.now() + 60_000;
    let aFinished = false;
    while (Date.now() < tailDeadline) {
      const snapshot = await storedTranscripts(panel).catch(() => ({}));
      if (Object.values(snapshot).some((v) => v.includes(`${SLOW_MARKER} step two`))) {
        aFinished = true;
        break;
      }
      await panel.waitForTimeout(500);
    }
    if (!aFinished) fail(`chat A never finished: no stored transcript reached "${SLOW_MARKER} step two" within 60s`);

    await tab1.bringToFront();
    await panel.waitForTimeout(3000);

    const aText = await transcriptText(panel);
    if (!aText.includes(SLOW_PROMPT)) fail(`switching back did not restore chat A (transcript: ${JSON.stringify(aText.slice(0, 300))})`);
    if (!aText.includes(`${SLOW_MARKER} step one`)) fail(`chat A lost the output that streamed before the switch: ${JSON.stringify(aText.slice(0, 400))}`);
    if (!aText.includes(`${SLOW_MARKER} step two`)) {
      fail(`chat A lost the output that streamed WHILE chat B was visible — the run's tail went missing: ${JSON.stringify(aText.slice(0, 600))}`);
    }
    if (aText.includes(FAST_MARKER)) fail(`chat B's output bled into chat A's transcript: ${JSON.stringify(aText.slice(0, 400))}`);
    if (aText.includes(FAST_PROMPT)) fail(`chat B's user message appeared in chat A: ${JSON.stringify(aText.slice(0, 400))}`);

    // --- What was PERSISTED is clean too, not just what was on screen.
    await reopenPanel(panel);
    const stored = await storedTranscripts(panel);
    const ids = Object.keys(stored);
    if (ids.length !== 2) fail(`expected two stored transcripts, got ${ids.length}: ${JSON.stringify(ids)}`);
    const slowStored = Object.values(stored).filter((v) => v.includes(SLOW_MARKER));
    const fastStored = Object.values(stored).filter((v) => v.includes(FAST_MARKER));
    if (slowStored.length !== 1) fail(`${SLOW_MARKER} appears in ${slowStored.length} stored transcripts; it belongs to exactly one`);
    if (fastStored.length !== 1) fail(`${FAST_MARKER} appears in ${fastStored.length} stored transcripts; it belongs to exactly one`);
    if (slowStored[0].includes(FAST_MARKER)) fail("the stored transcript for chat A also holds chat B's output");
    if (fastStored[0].includes(SLOW_MARKER)) fail("the stored transcript for chat B also holds chat A's output");
    if (slowStored[0].includes(FAST_PROMPT)) fail("chat A's stored transcript holds chat B's user message");
    if (fastStored[0].includes(SLOW_PROMPT)) fail("chat B's stored transcript holds chat A's user message");

    // --- The model histories, which is where an injected message would hide.
    const messages = await storedMessages(panel);
    for (const [id, json] of Object.entries(messages)) {
      const hasSlow = json.includes(SLOW_PROMPT);
      const hasFast = json.includes(FAST_PROMPT);
      if (hasSlow && hasFast) fail(`chat ${id}'s model history holds BOTH users' messages — one was injected into the other's conversation`);
    }

    // --- The requests the provider actually received. A transcript can look clean while the model
    //     was handed the other chat's text; only the wire shows that.
    const recorded = await panel.evaluate(async (url) => (await (await fetch(url)).json()).requests, `${BASE_URL.replace(/\/v1$/, '')}/__requests`);
    if (!recorded.length) fail('the mock backend recorded no requests at all');
    let sawSlow = false;
    let sawFast = false;
    for (const r of recorded) {
      const text = JSON.stringify(r.messages);
      const hasSlow = text.includes(SLOW_PROMPT);
      const hasFast = text.includes(FAST_PROMPT);
      if (hasSlow && hasFast) {
        fail(`a single request carried BOTH conversations' user text (script ${r.script}) — one chat's message was injected into the other's conversation`);
      }
      sawSlow ||= hasSlow;
      sawFast ||= hasFast;
    }
    if (!sawSlow || !sawFast) fail(`the recorded requests did not cover both conversations (slow: ${sawSlow}, fast: ${sawFast})`);

    // --- Stop in B while A runs must not abort A. Run it again, for real this time.
    await tab2.bringToFront();
    await panel.waitForTimeout(1500);
    await panel.locator('.composer button.btn', { hasText: 'New chat' }).click();
    await panel.waitForTimeout(400);
    await tab1.bringToFront();
    await panel.waitForTimeout(2000);
    await panel.locator('.composer button.btn', { hasText: 'New chat' }).click();
    await panel.waitForTimeout(400);
    await panel.locator('textarea').fill(SLOW_PROMPT);
    await panel.locator('.composer button.btn.primary').click();
    await panel.locator('.composer button.btn.danger', { hasText: 'Stop' }).waitFor({ timeout: 10_000 });

    await tab2.bringToFront();
    await panel.waitForTimeout(1500);
    await panel.locator('textarea').fill(FAST_PROMPT);
    await panel.locator('.composer button.btn.primary').click();
    // .first(): B's reply can render as more than one assistant bubble while it streams, and this
    // is only a wait for the answer to have arrived — the bleed assertions below do the real work.
    await panel.locator('.messages .msg.assistant', { hasText: FAST_MARKER }).first().waitFor({ timeout: 30_000 });
    const stopB = panel.locator('.composer button.btn.danger', { hasText: 'Stop' });
    if (await stopB.count()) await stopB.click();
    await panel.waitForTimeout(1000);

    // Back to A: it must have run to completion despite the Stop pressed in B.
    await tab1.bringToFront();
    await panel.waitForTimeout(12_000);
    const aAfterStop = await transcriptText(panel);
    if (!aAfterStop.includes(`${SLOW_MARKER} step two`)) {
      fail(`Stop pressed in chat B aborted chat A's run (chat A holds: ${JSON.stringify(aAfterStop.slice(0, 600))})`);
    }

    await assertNoViolations('isolation');
    console.log('isolation: OK — two chats ran at once with no bleed on screen, in storage, or on the wire; Stop in B left A alone');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Compaction test: a long conversation that crosses the context budget, forcing both tiers.
//
// The budget is shrunk through storage rather than by sending more turns, because six get_page
// reads of a real Wikipedia article at max_chars is already hundreds of thousands of characters —
// enough to cross a small budget the way a genuinely long session crosses the default one. What is
// asserted:
//   1. the 'compacted' note appears in the transcript, for both tiers;
//   2. the summary the mock returned really reached the model history;
//   3. requests got SMALLER after compaction, which is the whole point;
//   4. the backend saw zero structurally invalid requests — compaction rewrites old messages, so
//      this is where a broken tool_call/tool_result pairing would show up;
//   5. the conversation still completes, with its proposal card.
// ---------------------------------------------------------------------------

/**
 * Four user TURNS, not one long one. Tier 2 cuts only at user-turn boundaries, so a single turn —
 * however many tools it calls — can only ever be elided; forcing the summariser to run takes a
 * conversation with a real history of turns behind it.
 */
const COMPACT_PROMPTS = [
  'trace every heading on this page',
  'now check the infobox too',
  'and the references section',
  'now write the mod',
];

/**
 * The last thing the mock says in each turn. Waiting for this exact line is how the flow knows a
 * turn finished: the Stop button stays mounted while the post-turn title call is in flight, and the
 * turn's earlier rows would match anything looser.
 */
const COMPACT_TURN_ENDS = [
  'the headings are h2 inside .mw-heading.',
  'turn 2: got it.',
  'references live under #References.',
  'done — here is the mod.',
];

/** A budget small enough that a handful of full-page reads cross it, in lib/agent/compact.ts's units. */
const SMALL_BUDGET = 12_000;

async function compactionFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`compaction: ${m}`);
  };
  try {
    await clearViolations();
    await fetch(`${CONTROL_BASE}/__requests`, { method: 'DELETE' }).catch(() => {});

    // The budget is a normal setting, so shrinking it is exactly what a user could do.
    const panel = await openPanel(b.ctx, b.extId, { settings: { contextBudget: SMALL_BUDGET } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);

    // Each turn ends with a distinct text-only reply, so waiting for that line is how we know the
    // turn is over — more reliable than watching the Stop button, which the panel keeps mounted
    // while the post-turn title call is still in flight.
    for (let i = 0; i < COMPACT_PROMPTS.length; i++) {
      await panel.locator('textarea').fill(COMPACT_PROMPTS[i]);
      await panel.locator('.composer button.btn.primary').click();
      await panel.locator('.messages .msg.assistant', { hasText: COMPACT_TURN_ENDS[i] }).last().waitFor({ timeout: 180_000 });
      await panel.waitForTimeout(1000);
    }
    await panel.locator('.messages .card h4').first().waitFor({ timeout: 30_000 });
    await panel.waitForTimeout(1500);

    // --- 1. The note is in the transcript, and says what it did.
    // Matched on the note's TEXT, not its class: the transcript's styling is restyled from time to
    // time, and a flow that silently stops finding the note is worse than one that breaks loudly.
    const rows = (await panel.locator('.messages > *').allTextContents()).map((t) => t.trim());
    const compacted = rows.filter((t) => /earlier (tool output trimmed|conversation summarised)/.test(t));
    if (!compacted.length) fail(`no compaction note in the transcript (rows: ${JSON.stringify(rows.slice(0, 20))})`);
    if (!compacted.some((t) => t.includes('earlier tool output trimmed'))) {
      fail(`tier 1 never ran, or its note is missing: ${JSON.stringify(compacted)}`);
    }
    if (!compacted.some((t) => t.includes('earlier conversation summarised'))) {
      fail(`tier 2 never ran, or its note is missing: ${JSON.stringify(compacted)}`);
    }
    for (const note of compacted) {
      if (!/\d+k? → \d+k? tokens/.test(note)) fail(`a compaction note carries no sizes: ${JSON.stringify(note)}`);
    }

    // --- 2. The summary the mock wrote reached the stored model history.
    const stored = Object.values(await storedMessages(panel));
    if (stored.length !== 1) fail(`expected one chat's history, got ${stored.length}`);
    if (!stored[0].includes(SUMMARY_MARKER)) fail("the compaction summary never reached the chat's model history");
    if (!stored[0].includes('elided ·')) fail('no elided stub survived into the stored history');

    // --- 3. The requests really got smaller.
    // The history grows within a turn and shrinks when compaction fires, so the thing to look for
    // is a DROP between consecutive requests — not a smaller last request, which would only happen
    // if the final turn happened to compact on its last round.
    const recorded = (await fetchRequests()).filter((r) => r.script.startsWith('compaction'));
    if (recorded.length < 6) fail(`expected several rounds across four turns, got ${recorded.length}`);
    const sizes = recorded.map((r) => JSON.stringify(r.messages).length);
    let biggestDrop = 0;
    let dropAt = -1;
    for (let i = 1; i < sizes.length; i++) {
      const drop = sizes[i - 1] - sizes[i];
      if (drop > biggestDrop) {
        biggestDrop = drop;
        dropAt = i;
      }
    }
    if (biggestDrop <= 0) fail(`the request history never got smaller: ${sizes.join(' → ')}`);
    // A meaningful drop, not a turn that merely sent a shorter user message.
    if (biggestDrop < sizes[dropAt - 1] * 0.2) {
      fail(`the biggest drop was only ${biggestDrop} chars, which is noise rather than compaction: ${sizes.join(' → ')}`);
    }
    log(`compaction: request sizes ${sizes.join(' → ')} (biggest drop ${biggestDrop} chars)`);

    // --- 4. Nothing invalid went over the wire.
    await assertNoViolations('compaction');

    // --- 5. The conversation still finished.
    const title = (await panel.locator('.messages .card h4').first().textContent())?.trim();
    if (title !== 'Wikipedia: numbered headings') fail(`proposal title was ${JSON.stringify(title)}`);
    const text = await transcriptText(panel);
    if (!text.includes(`${COMPACT_MARKER} done`)) fail('the conversation did not reach its final step');

    console.log(`compaction: OK — both tiers ran, summary landed in history, biggest drop ${biggestDrop} chars, zero invalid requests`);
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Dashboard: the full-tab page — grouping, search, rename, archive, mod toggle,
// mod source editing, and the "open this chat on its page with the sidebar" handoff.
// ---------------------------------------------------------------------------

/** Chat records and their stored transcripts, on two hosts, for the dashboard flow. */
function seedChats() {
  const now = Date.now();
  const mk = (id, host, title, updatedAt, over = {}) => ({
    id,
    host,
    title,
    createdAt: updatedAt - 60_000,
    updatedAt,
    turns: 1,
    ...over,
  });
  const chats = [
    mk('chat-wiki-1', 'en.wikipedia.org', 'hide the sidebar and widen the article', now - 5 * 60_000, {
      url: 'https://en.wikipedia.org/wiki/Common_kingfisher',
    }),
    mk('chat-wiki-2', 'en.wikipedia.org', 'dim the infobox images', now - 40 * 60_000, {
      url: 'https://en.wikipedia.org/wiki/Common_kingfisher',
    }),
    mk('chat-hn-1', 'news.ycombinator.com', 'make the comment threads readable', now - 2 * 60 * 60_000, {
      url: 'https://news.ycombinator.com/news',
    }),
  ];
  // The panel transcript each chat's preview pane renders, and which search reads for message text.
  const items = {
    'chat:chat-wiki-1:items': [
      { kind: 'user', id: 'u1', text: 'hide the sidebar and widen the article' },
      { kind: 'assistant', text: 'Hiding the pinned table of contents and letting the body use the window.' },
    ],
    'chat:chat-wiki-2:items': [
      { kind: 'user', id: 'u2', text: 'dim the infobox images' },
      { kind: 'assistant', text: 'Reducing the opacity of images inside the infobox.' },
    ],
    'chat:chat-hn-1:items': [
      { kind: 'user', id: 'u3', text: 'make the comment threads readable' },
      { kind: 'assistant', text: 'Widening the indentation and raising the contrast on replies.' },
    ],
  };
  return { chats, ...items };
}

/** Open dashboard.html with chats and mods already in storage. */
async function openDashboard(ctx, extId, { storage = {}, settings = {} } = {}) {
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 1280, height: 950 });
  await page.goto(`chrome-extension://${extId}/dashboard.html`);
  await page.evaluate(
    async ([s, extra]) => {
      await chrome.storage.local.set({ settings: s, consent: { version: 1, acceptedAt: Date.now() }, ...extra });
    },
    [{ provider: 'openai-compatible', baseUrl: BASE_URL, apiKey: '', model: 'demo', ...settings }, storage],
  );
  await page.reload();
  await page.locator('[data-testid="overview"]').waitFor({ timeout: 15_000 });
  return page;
}

/**
 * Type a new source into the mod editor and save it, waiting on the states that actually gate the
 * save rather than on a fixed number of milliseconds.
 *
 * Two real waits. Save is disabled until React has seen an onChange, so a fill() followed by a
 * sleep and a click can land on a disabled button and save nothing — the assertion that follows
 * then blames the feature for a timing miss. And the click starts an async round trip through the
 * background (re-parse, maybe refetch dependencies, re-register), during which the button reads
 * "Saving…"; waiting for it to stop saying that is what "the save finished" actually means.
 *
 * `settle` is the grace after that for the storage write to land and the list to re-render.
 */
async function editAndSave(page, source, { settle = 600 } = {}) {
  const editor = page.locator('[data-testid="mod-editor-source"]');
  const save = page.locator('[data-testid="mod-editor-save"]');
  await editor.fill(source);
  await save.waitFor({ state: 'visible', timeout: 10_000 });
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="mod-editor-save"]');
        return b && !b.disabled;
      },
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => {
      throw new Error('dashboard: Save never became enabled after an edit — the editor did not register the new text');
    });
  await save.click();
  // The save is over when the button stops reporting it, whether it succeeded or threw.
  await page
    .waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="mod-editor-save"]');
        return b && !/Saving/.test(b.textContent ?? '');
      },
      undefined,
      { timeout: 30_000 },
    )
    .catch(() => {
      throw new Error('dashboard: the editor was still saving after 30s');
    });
  await page.waitForTimeout(settle);
}

async function dashboardFlow({ capture = false } = {}) {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`dashboard: ${m}`);
  };
  try {
    // Theme pinned rather than left to resolveTheme's old-profile rule: the capture below shoots
    // dark and then light from this page, so which one it starts on has to be stated, not inferred.
    const page = await openDashboard(b.ctx, b.extId, {
      storage: { ...seedChats(), mods: seedMods() },
      settings: { theme: 'dark' },
    });

    // --- 1. Chats are grouped by host, newest site first, with per-group counts.
    const groups = page.locator('[data-testid="hostgroup"]');
    if ((await groups.count()) !== 2) fail(`expected 2 host groups, got ${await groups.count()}`);
    const hosts = await groups.evaluateAll((els) => els.map((e) => e.dataset.host));
    if (hosts[0] !== 'en.wikipedia.org') fail(`the most recently used site was not first (order: ${hosts.join(', ')})`);
    const wikiCount = await groups.first().locator('[data-testid="hostgroup-count"]').textContent();
    if (!wikiCount?.includes('2 chats')) fail(`the wikipedia group did not count its 2 chats (said ${JSON.stringify(wikiCount)})`);
    if ((await page.locator('[data-testid="chat-row"]').count()) !== 3) fail('not every chat was listed');

    // The overview strip counts what is actually in storage.
    const overviewText = await page.locator('[data-testid="overview"]').textContent();
    if (!overviewText?.includes('2/3')) fail(`the overview did not show 2 of 3 mods enabled (said ${JSON.stringify(overviewText)})`);

    // --- 2. Search narrows the list, including on message text from a stored transcript.
    await page.locator('[data-testid="chat-search"]').fill('infobox');
    await page.waitForTimeout(700);
    let titles = await page.locator('[data-testid="chat-title"]').allTextContents();
    if (titles.length !== 1 || !titles[0].includes('infobox')) fail(`searching for a title left ${JSON.stringify(titles)}`);

    await page.locator('[data-testid="chat-search"]').fill('ycombinator');
    await page.waitForTimeout(700);
    titles = await page.locator('[data-testid="chat-title"]').allTextContents();
    if (titles.length !== 1 || !titles[0].includes('comment threads')) fail(`searching by host left ${JSON.stringify(titles)}`);

    // Message text lives in a separate storage key and is read lazily; "indentation" appears only
    // inside the HN transcript, in neither title nor host.
    await page.locator('[data-testid="chat-search"]').fill('indentation');
    await page.waitForTimeout(1200);
    titles = await page.locator('[data-testid="chat-title"]').allTextContents();
    if (titles.length !== 1 || !titles[0].includes('comment threads')) fail(`searching message text left ${JSON.stringify(titles)}`);

    await page.locator('[data-testid="chat-search"]').fill('');
    await page.waitForTimeout(500);

    // --- 3. Clicking a chat opens a read-only transcript preview.
    const firstRow = page.locator('[data-testid="chat-row"]').first();
    await firstRow.locator('[data-testid="chat-title"]').click();
    // The pane appears first and fills once the transcript read lands, so wait for the content
    // rather than the container — asserting on the container races the storage read.
    await page
      .locator('[data-testid="chat-preview"] .msg.assistant')
      .filter({ hasText: 'Hiding the pinned table of contents' })
      .first()
      .waitFor({ timeout: 10_000 })
      .catch(async () => {
        const held = await page.locator('[data-testid="chat-preview"]').textContent();
        fail(`the preview pane did not render the stored transcript (it held ${JSON.stringify(held)})`);
      });

    // --- 4. Rename is inline and persists to storage.
    await firstRow.locator('[data-testid="chat-rename"]').click();
    const renameBox = page.locator('[data-testid="chat-rename-input"]');
    await renameBox.waitFor({ timeout: 5_000 });
    await renameBox.fill('renamed by the dashboard');
    await renameBox.press('Enter');
    await page.waitForTimeout(800);
    const storedTitle = await page.evaluate(async () => {
      const { chats } = await chrome.storage.local.get('chats');
      return chats.find((c) => c.id === 'chat-wiki-1')?.title;
    });
    if (storedTitle !== 'renamed by the dashboard') fail(`the rename did not persist (storage holds ${JSON.stringify(storedTitle)})`);
    const shownTitle = await page.locator('[data-testid="chat-row"]').first().locator('[data-testid="chat-title"]').textContent();
    if (shownTitle?.trim() !== 'renamed by the dashboard') fail(`the renamed chat still showed ${JSON.stringify(shownTitle)}`);

    // --- 5. Archiving badges the chat and writes archivedAt.
    const hnRow = page.locator('[data-testid="chat-row"][data-chat-id="chat-hn-1"]');
    await hnRow.locator('[data-testid="chat-archive"]').click();
    await page.waitForTimeout(800);
    if (!(await hnRow.locator('[data-testid="chat-archived"]').count())) fail('the archived chat had no archived badge');
    const archivedAt = await page.evaluate(async () => {
      const { chats } = await chrome.storage.local.get('chats');
      return chats.find((c) => c.id === 'chat-hn-1')?.archivedAt;
    });
    if (typeof archivedAt !== 'number') fail('archiving did not write archivedAt to the index');
    const hnGroupCount = await page
      .locator('[data-testid="hostgroup"][data-host="news.ycombinator.com"] [data-testid="hostgroup-count"]')
      .textContent();
    if (!hnGroupCount?.includes('1 archived')) fail(`the host group did not report the archived chat (said ${JSON.stringify(hnGroupCount)})`);

    // --- 5b. Finding 9: a bulk delete closes the preview of a chat it deleted.
    //
    // There used to be two mechanisms racing here: an explicit "if the ids I just sent include the
    // open one, clear it" in the bulk handler, and an effect watching `chats`. The explicit one
    // reasoned about the filtered selection rather than about what the data now says, so a chat
    // that left the index by any other route (deleted from the side panel, evicted by the cap) kept
    // its pane open on content that no longer exists. One rule now: the open chat is looked up in
    // the current data, and when it is not there the pane closes.
    {
      const victim = page.locator('[data-testid="chat-row"][data-chat-id="chat-wiki-2"]');
      await victim.locator('[data-testid="chat-title"]').click();
      await page.locator('[data-testid="chat-preview"]').waitFor({ timeout: 10_000 });
      // Delete it out from under the open preview, the way the side panel would — no click on this
      // page at all, so nothing but the derived rule can close the pane. The record is handed back
      // so the steps after this one still see three chats.
      const removed = await page.evaluate(async () => {
        const { chats } = await chrome.storage.local.get('chats');
        await chrome.storage.local.set({ chats: chats.filter((c) => c.id !== 'chat-wiki-2') });
        return chats.find((c) => c.id === 'chat-wiki-2');
      });
      if (!removed) fail('the chat this step deletes was not in storage to begin with');
      await page
        .locator('[data-testid="chat-preview"]')
        .waitFor({ state: 'detached', timeout: 10_000 })
        .catch(async () => {
          const held = await page.locator('[data-testid="chat-preview"] h3').textContent();
          fail(`the preview stayed open on a chat that no longer exists (showing ${JSON.stringify(held)})`);
        });
      if ((await page.locator('[data-testid="chat-row"]').count()) !== 2) fail('the deleted chat is still in the list');
      // Put it back for the steps that follow, which expect three chats.
      await page.evaluate(async (restored) => {
        const { chats } = await chrome.storage.local.get('chats');
        await chrome.storage.local.set({ chats: [...chats, restored] });
      }, removed);
      await page.waitForTimeout(600);
      if ((await page.locator('[data-testid="chat-row"]').count()) !== 3) fail('restoring the deleted chat did not bring the list back');
    }

    // --- 5c. Finding 7: a chat being written to still becomes searchable, and is read once.
    //
    // The transcript-search effect used to depend on the `chats` ARRAY, which Dashboard replaces on
    // every storage change (it refreshes on any write to chats or mods), and it only claimed an id
    // in haveRef AFTER the read resolved. So under sustained writes — a chat running in the side
    // panel touches the index several times a turn — the effect was torn down and restarted before
    // its read landed, the id was never claimed, and the same transcript was fetched again and
    // again without the chat ever entering the searchable set.
    //
    // The observable that separates the two implementations regardless of how the timing falls is
    // the number of reads: keyed on a stable string and claiming the id before the read, a
    // transcript is fetched ONCE per search however many unrelated writes go past. So this counts
    // chats.transcript requests from inside the page while it churns the chats key.
    {
      await page.locator('[data-testid="chat-search"]').fill('');
      await page.waitForTimeout(400);
      // Close the preview pane first. It reads chats.transcript too — legitimately, once per chat
      // it opens — and the assertion below is "no id was read twice", so a pane left open on the
      // chat step 5b restored would put a second, innocent read of it in the tally and fail a
      // correct implementation. Clicking the open row's title toggles it shut.
      const stillOpen = page.locator('[data-testid="chat-preview"]');
      if (await stillOpen.count()) {
        await page.locator('[data-testid="chat-row"][data-chat-id="chat-wiki-2"] [data-testid="chat-title"]').click();
        await stillOpen.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
      }
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        window.__transcriptReads = [];
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, ...rest) => {
          if (msg && msg.type === 'chats.transcript') window.__transcriptReads.push(msg.id);
          return send(msg, ...rest);
        };
      });
      // Rewrite the chats key faster than a transcript read can resolve, for long enough that the
      // old effect could not have got one through. updatedAt is untouched: nothing here is a real
      // change, only a new array identity, which is exactly what an unrelated write produces.
      // The rejection is swallowed at creation, not at the await. Any assertion between here and
      // `await churn` throws, the finally closes the browser, and this in-page loop rejects with
      // "target closed" — as an UNHANDLED rejection, which takes the process down and prints its
      // own message instead of the assertion that actually failed. Catching it here keeps the real
      // failure visible; the await below still waits for the loop to finish on the happy path.
      const churn = page
        .evaluate(async () => {
          const until = Date.now() + 5000;
          while (Date.now() < until) {
            const { chats } = await chrome.storage.local.get('chats');
            await chrome.storage.local.set({ chats: chats.map((c) => ({ ...c })) });
            await new Promise((r) => setTimeout(r, 15));
          }
        })
        .catch(() => {});
      await page.waitForTimeout(300);
      // "indentation" appears only inside the HN transcript, in neither a title nor a host, so the
      // only way this chat can match is a transcript read that landed and stuck.
      await page.locator('[data-testid="chat-search"]').fill('indentation');
      // Wait for the list to have NARROWED to exactly the one chat, not merely for that chat's row
      // to exist. All three rows are on screen when the query is typed, and the box is debounced by
      // 200ms, so "chat-hn-1 is present" is true before the filter has run at all — the assertion
      // that followed it was reading the unfiltered list and could only pass by luck. Waiting on
      // the end state makes this step about what the search did rather than about how fast it did
      // it, which is the whole point when the page is being churned underneath.
      await page
        .waitForFunction(
          () => document.querySelectorAll('[data-testid="chat-row"]').length === 1,
          undefined,
          { timeout: 8_000 },
        )
        .catch(async () => {
          const ids = await page.locator('[data-testid="chat-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-chat-id')));
          const stored = await page.evaluate(async () => {
            const { chats } = await chrome.storage.local.get('chats');
            return chats.map((c) => `${c.id}|${c.title}`);
          });
          fail(
            `the message-text search did not settle on the one chat whose transcript holds the word ` +
              `(rows ${JSON.stringify(ids)}, storage ${JSON.stringify(stored)})`,
          );
        });
      if (!(await page.locator('[data-testid="chat-row"][data-chat-id="chat-hn-1"]').count())) {
        const shown = await page.locator('[data-testid="chat-title"]').allTextContents();
        fail(`a chat under sustained writes never became searchable by its message text (list held ${JSON.stringify(shown)})`);
      }
      await churn;
      await page.waitForTimeout(500);
      const reads = await page.evaluate(() => window.__transcriptReads);
      const perChat = new Map();
      for (const id of reads) perChat.set(id, (perChat.get(id) ?? 0) + 1);
      const repeated = [...perChat].filter(([, n]) => n > 1);
      if (repeated.length) {
        fail(
          `the same transcript was read ${repeated.map(([id, n]) => `${n}x for ${id}`).join(', ')} during ~5s of unrelated writes — ` +
            'the search effect is restarting on every write instead of on a real change',
        );
      }
      await page.locator('[data-testid="chat-search"]').fill('');
      await page.waitForTimeout(500);
    }

    // --- 6. Open: the handoff, then the tab.
    //
    // Note what actually happens here. chrome.sidePanel.open({windowId}) SUCCEEDS from this
    // extension page — Playwright's click is a trusted gesture — so the real side panel opens, sees
    // the handoff for the host it lands on, opens that chat and DELETES the handoff. Measured at
    // roughly 300ms. So this cannot poll for the handoff after a fixed wait: it has to catch the
    // write. It watches chrome.storage.onChanged from inside the page, which sees the write whether
    // or not the panel consumes it a moment later.
    //
    // The handoff being consumed is the feature working, not a failure — but a test that asserted
    // on it after the fact would read an empty key and call the feature broken.
    const before = b.ctx.pages().length;
    const openRow = page.locator('[data-testid="chat-row"]').first();
    if ((await openRow.getAttribute('data-chat-id')) !== 'chat-wiki-1') fail('the row under test was not the renamed wikipedia chat');
    await page.evaluate(() => {
      window.__handoffSeen = null;
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'session' && changes.openChat?.newValue) window.__handoffSeen = changes.openChat.newValue;
      });
    });
    await openRow.locator('[data-testid="chat-open"]').click();
    await page.waitForFunction(() => window.__handoffSeen !== null, { timeout: 10_000 }).catch(() => {});
    const handoff = await page.evaluate(() => window.__handoffSeen);
    if (!handoff) fail('clicking Open wrote no handoff to session storage');
    if (handoff.chatId !== 'chat-wiki-1') fail(`the handoff named ${JSON.stringify(handoff.chatId)}`);
    if (handoff.host !== 'en.wikipedia.org') fail(`the handoff carried host ${JSON.stringify(handoff.host)}`);
    if (typeof handoff.at !== 'number') fail('the handoff carried no timestamp, so the panel cannot age it out');

    // And a tab on the URL the chat recorded, not just the site's front door.
    await page.waitForTimeout(2500);
    const opened = b.ctx.pages().slice(before).map((p) => p.url());
    if (!opened.some((u) => u.startsWith('https://en.wikipedia.org/wiki/Common_kingfisher'))) {
      fail(`Open did not create a tab on the chat's recorded URL (new tabs: ${JSON.stringify(opened)})`);
    }
    // The page must still be usable: whatever sidePanel.open did, it cannot break the view.
    if ((await page.locator('[data-testid="chat-row"]').count()) !== 3) fail('the dashboard broke after the Open click');

    // --- 7. Mods: toggling writes through to storage.
    await page.locator('.dash-tabs button', { hasText: 'Mods' }).click();
    await page.locator('[data-testid="mod-row"]').first().waitFor({ timeout: 10_000 });
    if ((await page.locator('[data-testid="mod-row"]').count()) !== 3) fail('not every mod was listed');

    const firstMod = page.locator('[data-testid="mod-row"]').first();
    const modId = await firstMod.getAttribute('data-mod-id');
    await firstMod.locator('[data-testid="mod-toggle"]').click();
    await page.waitForTimeout(800);
    const nowEnabled = await page.evaluate(async (id) => {
      const { mods } = await chrome.storage.local.get('mods');
      return mods.find((m) => m.id === id)?.enabled;
    }, modId);
    if (nowEnabled !== false) fail(`toggling a mod off did not reach storage (stored enabled=${nowEnabled})`);

    // The enabled filter is driven by that same state.
    await page.locator('[data-testid="mod-enabled"]').selectOption('disabled');
    await page.waitForTimeout(400);
    const disabledCount = await page.locator('[data-testid="mod-row"]').count();
    if (disabledCount !== 2) fail(`the "disabled only" filter showed ${disabledCount} mods, expected 2`);
    await page.locator('[data-testid="mod-enabled"]').selectOption('all');
    await page.waitForTimeout(400);

    // --- 8. Editing a mod's source re-parses its header: the name follows the @name line.
    await page.locator('[data-testid="mod-row"]').first().locator('[data-testid="mod-name"]').click();
    const editor = page.locator('[data-testid="mod-editor-source"]');
    await editor.waitFor({ timeout: 10_000 });
    const original = await editor.inputValue();
    if (!original.includes('==UserScript==')) fail('the editor did not load the mod source');
    await editAndSave(page, original.replace(/@name\s+.*/, '@name         Renamed by the editor'), { settle: 1200 });
    const storedName = await page.evaluate(async (id) => {
      const { mods } = await chrome.storage.local.get('mods');
      return mods.find((m) => m.id === id)?.name;
    }, modId);
    if (storedName !== 'Renamed by the editor') fail(`editing the source did not update the parsed name (storage holds ${JSON.stringify(storedName)})`);
    const shownName = await page.locator(`[data-testid="mod-row"][data-mod-id="${modId}"] [data-testid="mod-name"]`).textContent();
    if (!shownName?.includes('Renamed by the editor')) fail(`the mod list still showed ${JSON.stringify(shownName)}`);

    // --- 8a. Finding 5: an edit that adds an @require line fetches and stores the dependency.
    //
    // This is the whole of the bug. The editor used to save through rpc 'mods.save', which is an
    // upsert plus a re-register and resolves nothing, so the mod was written with requires: [] under
    // a header naming a library — and the re-registered script threw ReferenceError at page load
    // with the save having reported success. The save now goes through mods.saveSource, which
    // re-parses the header AND refetches the dependencies when (and only when) they moved.
    {
      const editor = page.locator('[data-testid="mod-editor-source"]');
      const requireUrl = `${BASE_URL.replace(/\/v1$/, '')}/__require.js?name=firstLib`;
      const withRequire = (await editor.inputValue()).replace('// ==/UserScript==', `// @require      ${requireUrl}\n// ==/UserScript==`);
      // Warm the BACKGROUND's path to the mock server before the assertion depends on it. In
      // headless Chromium the extension service worker's very first fetch to plain-HTTP localhost
      // intermittently comes back "Failed to fetch" — the network service is still coming up — and
      // the save is then correctly refused, which would read here as the feature being broken. A
      // mods.preview-shaped round trip is not available, so this drives the same fetchText the save
      // uses, through the same worker, and simply waits for it to start working.
      await page
        .waitForFunction(
          async (u) => {
            try {
              const r = await fetch(u, { cache: 'no-store' });
              return r.ok;
            } catch {
              return false;
            }
          },
          requireUrl,
          { timeout: 20_000 },
        )
        .catch(() => fail(`the mock server never served ${requireUrl}; the @require assertions cannot mean anything`));
      await editAndSave(page, withRequire);
      let stored = await page.evaluate(async (id) => {
        const { mods } = await chrome.storage.local.get('mods');
        const m = mods.find((x) => x.id === id);
        return { requires: m?.requires ?? [], enabled: m?.enabled, source: m?.source };
      }, modId);
      // One retry, and only for the one failure that is the harness rather than the feature: the
      // MV3 service worker can be evicted mid-save, and the fetch it was in the middle of dies with
      // a bare "Failed to fetch". The save is correctly refused when that happens — nothing is
      // written and the error is shown — so the assertion below still has to pass on the retry.
      // Any other error, or a second failure, fails the flow.
      if (stored.requires.length !== 1) {
        const err = (await page.locator('.error').first().textContent().catch(() => '')) ?? '';
        if (!/Failed to fetch/.test(err)) {
          fail(`adding an @require line saved ${stored.requires.length} dependency bodies — the mod would throw ReferenceError on its next page load (editor said ${JSON.stringify(err)})`);
        }
        console.log('dashboard: the service worker dropped the @require fetch; retrying once');
        await page.reload();
        await page.locator('[data-testid="overview"]').waitFor({ timeout: 15_000 });
        await page.locator('.dash-tabs button', { hasText: 'Mods' }).click();
        await page.locator(`[data-testid="mod-row"][data-mod-id="${modId}"] [data-testid="mod-name"]`).click();
        await page.locator('[data-testid="mod-editor-source"]').waitFor({ timeout: 10_000 });
        await editAndSave(page, withRequire);
        stored = await page.evaluate(async (id) => {
          const { mods } = await chrome.storage.local.get('mods');
          const m = mods.find((x) => x.id === id);
          return { requires: m?.requires ?? [], enabled: m?.enabled, source: m?.source };
        }, modId);
      }
      if (stored.requires.length !== 1) {
        fail(`adding an @require line saved ${stored.requires.length} dependency bodies — the mod would throw ReferenceError on its next page load`);
      }
      if (!stored.requires[0].code.includes('firstLib')) {
        fail(`the stored @require body is not what the URL serves (got ${JSON.stringify(stored.requires[0].code.slice(0, 80))})`);
      }
      if (stored.requires[0].url !== requireUrl) fail('the stored dependency does not carry the URL it came from');

      // Changing the URL refetches: the stale body must not survive an edit that repointed it.
      const secondUrl = `${BASE_URL.replace(/\/v1$/, '')}/__require.js?name=secondLib`;
      await editAndSave(page, withRequire.replace(requireUrl, secondUrl));
      const after = await page.evaluate(async (id) => {
        const { mods } = await chrome.storage.local.get('mods');
        return mods.find((x) => x.id === id)?.requires ?? [];
      }, modId);
      if (after.length !== 1 || !after[0].code.includes('secondLib')) {
        fail(`repointing the @require left the old body in place (stored ${JSON.stringify(after.map((r) => r.url))})`);
      }

      // A dependency that will not fetch fails the save and says so, rather than writing a mod that
      // is broken from the moment it is registered.
      const badUrl = `${BASE_URL.replace(/\/v1$/, '')}/__nothing-here.js`;
      await editAndSave(page, withRequire.replace(requireUrl, badUrl), { settle: 2500 });
      const unchanged = await page.evaluate(async (id) => {
        const { mods } = await chrome.storage.local.get('mods');
        return mods.find((x) => x.id === id)?.requires ?? [];
      }, modId);
      if (unchanged.length !== 1 || !unchanged[0].code.includes('secondLib')) {
        fail('a failed dependency fetch still wrote over the installed mod');
      }
      const shownError = await page.locator('.error').first().textContent().catch(() => '');
      if (!/require|fetch|404|HTTP/i.test(shownError ?? '')) {
        fail(`a dependency fetch failure was not surfaced to the editor (the page said ${JSON.stringify(shownError)})`);
      }

      // Back to a clean, saved, dependency-free mod for the steps that follow.
      const plain = withRequire.replace(new RegExp(`// @require.*\\n`), '');
      await editAndSave(page, plain);
    }

    // --- 8b. Finding 6: the editor follows an external change when it is clean, and refuses to
    // pick a winner when it is not.
    //
    // The old editor derived dirtiness from `source !== mod.source` and adopted a new mod.source
    // only while that comparison said clean. But the moment mod.source moved underneath, the
    // comparison said DIRTY on its own — the box still held the old text — so the editor froze on
    // the pre-update source, Save lit up, and saving wrote that stale text back over the update.
    {
      const editor = page.locator('[data-testid="mod-editor-source"]');
      const save = page.locator('[data-testid="mod-editor-save"]');

      // (a) Clean editor, source changes elsewhere: the new text is adopted, with no prompt.
      const externalA = `${await editor.inputValue()}\n// changed elsewhere while the editor was clean\n`;
      await page.evaluate(
        async ([id, source]) => {
          const { mods } = await chrome.storage.local.get('mods');
          await chrome.storage.local.set({
            mods: mods.map((m) => (m.id === id ? { ...m, source, updatedAt: Date.now() } : m)),
          });
        },
        [modId, externalA],
      );
      await page
        .waitForFunction(
          (want) => document.querySelector('[data-testid="mod-editor-source"]')?.value === want,
          externalA,
          { timeout: 10_000 },
        )
        .catch(async () => {
          fail(`a clean editor did not pick up the source saved elsewhere (it still held ${JSON.stringify(await editor.inputValue())})`);
        });
      if (await page.locator('[data-testid="mod-editor-conflict"]').count()) {
        fail('a clean editor should adopt the new version silently, not ask about it');
      }

      // (b) Unsaved edits here, source changes elsewhere: neither side is thrown away, Save is
      // blocked, and the user is given the choice.
      const mine = `${externalA}// my unsaved edit\n`;
      await editor.fill(mine);
      await page.waitForTimeout(200);
      const externalB = `${externalA}// a second change from elsewhere\n`;
      await page.evaluate(
        async ([id, source]) => {
          const { mods } = await chrome.storage.local.get('mods');
          await chrome.storage.local.set({
            mods: mods.map((m) => (m.id === id ? { ...m, source, updatedAt: Date.now() } : m)),
          });
        },
        [modId, externalB],
      );
      await page
        .locator('[data-testid="mod-editor-conflict"]')
        .waitFor({ timeout: 10_000 })
        .catch(() => fail('a change from elsewhere during an unsaved edit raised no notice'));
      if ((await editor.inputValue()) !== mine) fail('the conflict notice came with the edits already discarded');
      if (!(await save.isDisabled())) fail('Save was live during a conflict, so it would silently pick a winner');

      // "Keep my edits" is an explicit choice: Save comes back, and it writes the user's text.
      await page.locator('[data-testid="mod-editor-keep-mine"]').click();
      await page.waitForTimeout(200);
      if (await page.locator('[data-testid="mod-editor-conflict"]').count()) fail('choosing a version left the notice up');
      if (await save.isDisabled()) fail('Save stayed disabled after the user chose a version');
      await save.click();
      await page.waitForTimeout(1200);
      const storedSource = await page.evaluate(async (id) => {
        const { mods } = await chrome.storage.local.get('mods');
        return mods.find((m) => m.id === id)?.source;
      }, modId);
      if (storedSource !== mine) fail('the save after "Keep my edits" did not write the text that was in the box');

      // (c) And the far more damaging half of the old bug: an update landing while the editor is
      // clean must not be undone by a later save of the pre-update text. The editor is clean again
      // now (it just saved), so a change from elsewhere is adopted rather than held on to.
      const externalC = `${mine}// the update this editor must not overwrite\n`;
      await page.evaluate(
        async ([id, source]) => {
          const { mods } = await chrome.storage.local.get('mods');
          await chrome.storage.local.set({
            mods: mods.map((m) => (m.id === id ? { ...m, source, updatedAt: Date.now() } : m)),
          });
        },
        [modId, externalC],
      );
      await page
        .waitForFunction(
          (want) => document.querySelector('[data-testid="mod-editor-source"]')?.value === want,
          externalC,
          { timeout: 10_000 },
        )
        .catch(async () => {
          fail(`the editor did not follow the update (it held ${JSON.stringify(await editor.inputValue())})`);
        });
      if (!(await save.isDisabled())) fail('the editor reported unsaved changes it does not have, which is how the stale text got saved');
    }

    // --- 9. Bulk: selecting every visible mod and disabling them writes through in one pass.
    await page.locator('.dash-toolbar button.pill', { hasText: 'Select all' }).click();
    await page.locator('[data-testid="mod-bulkbar"]').waitFor({ timeout: 5_000 });
    await page.locator('[data-testid="mod-bulkbar"] button.pill', { hasText: 'Disable' }).click();
    await page.waitForTimeout(1200);
    const allOff = await page.evaluate(async () => {
      const { mods } = await chrome.storage.local.get('mods');
      return mods.every((m) => m.enabled === false);
    });
    if (!allOff) fail('a bulk disable did not turn every mod off');

    if (capture) {
      // Re-enable everything the bulk step just turned off: the shot should show the page in its
      // normal state, not with every mod disabled and "0 sites customised" in the overview.
      await page.locator('.dash-toolbar button.pill', { hasText: 'Select all' }).click();
      await page.locator('[data-testid="mod-bulkbar"] button.pill', { hasText: 'Enable' }).click();
      await page.waitForTimeout(1000);
      // Back to Chats for the screenshot: the grouped list plus a transcript preview is the page.
      await page.locator('.dash-tabs button', { hasText: 'Chats' }).click();
      await page.locator('[data-testid="chat-row"]').first().locator('[data-testid="chat-title"]').click();
      await page.locator('[data-testid="chat-preview"]').waitFor({ timeout: 10_000 });
      await page.waitForTimeout(600);
      // Crop to the content: the page is a centred column on a tall viewport, and a shot that is
      // half empty background tells the reader nothing.
      await page.addStyleTag({ content: HIDE_SETUP_NOTICE });
      // Park the cursor off the list: a row left under the pointer draws its hover border and reads
      // as selected in a still image.
      await page.mouse.move(1260, 8);
      await page.waitForTimeout(200);
      // The tallest of the two panes decides the crop; .dash-inner keeps its padding-bottom, which
      // would leave a band of empty background under the content.
      const height = await page.evaluate(() => {
        const bottoms = [...document.querySelectorAll('.panes > *')].map((e) => e.getBoundingClientRect().bottom);
        return Math.ceil(Math.max(...bottoms) + window.scrollY + 28);
      });
      await page.setViewportSize({ width: 1280, height: Math.max(560, Math.min(height, 1100)) });
      await page.waitForTimeout(300);
      await shot(page, '07-dashboard.png');

      // The same page in light, from the same state, so the README's pair differs only by theme.
      // The theme is driven through the toggle rather than through storage plus a reload: a reload
      // would drop the open preview and re-collapse the list, and the two shots would then be of
      // two different pages.
      await page.locator('.theme-toggle').click();
      await page.waitForTimeout(500);
      const nowLight = await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue('--bg-app').trim(),
      );
      if (paletteOf(nowLight) !== 'light') fail(`the light capture was still on the ${paletteOf(nowLight)} palette (--bg-app ${nowLight})`);
      await page.mouse.move(1260, 8);
      await page.waitForTimeout(200);
      await shot(page, '07-dashboard-light.png');
      // Back to dark, so nothing after this step inherits a light page.
      await page.locator('.theme-toggle').click(); // light -> system
      await page.locator('.theme-toggle').click(); // system -> dark
      await page.waitForTimeout(300);
    }

    // Nothing structurally invalid went over the wire. The dashboard does not run a conversation
    // itself, but the handoff step opens the side panel on a seeded chat and the mod edits
    // re-register scripts, so this asserts the same contract every other flow does.
    await assertNoViolations('dashboard');

    console.log(
      'dashboard: OK — grouping, search over titles/hosts/message text (incl. under sustained writes), preview (closed by the one derived rule), rename, archive, handoff + tab, mod toggle, source edit with @require resolution and a failed fetch refused, external-change adoption and conflict, bulk disable, zero invalid requests',
    );
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------
// Tab bar: the top bar holds together at every width a side panel can be
// ---------------------------------------------------------------------------
//
// The bar is responsive with no JavaScript at all — a container query on .tabs swaps Settings and
// Dashboard between icon+label and icon-only. That is exactly the kind of thing a unit test cannot
// see and a single-width screenshot will not catch, so it is asserted here, in a real engine, at
// the widths a side panel actually gets dragged to.
//
// What is checked, at 320 / 360 / 420 / 640 in both themes:
//
//   * The bar does not overflow and does not wrap. One row, scrollWidth <= clientWidth.
//   * No control is clipped: every one of them is inside the bar's box and at least 28x28.
//   * Narrow (320/360/420): the Settings and Dashboard labels are not visible, and both buttons
//     still expose their accessible names. Icon-only must not mean nameless.
//   * Wide (640): the labels are visible.
//   * The hostname is not thrown away to make room. At 360 at least 10 characters of
//     "en.wikipedia.org" are legible; at 420 the whole thing is. (The bar this replaced showed
//     "en.…" at 420.)
//   * Settings is a view of the panel, not a link: clicking it shows the settings view and marks
//     the control current; clicking Chat comes back.

const TABBAR_WIDTHS = [320, 360, 420, 640];
const TABBAR_HOST = 'en.wikipedia.org';

/** The accessible name of a control, the way a screen reader resolves it: aria-label wins, else text. */
async function accessibleName(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    return (el.getAttribute('aria-label') || el.textContent || '').trim();
  }, selector);
}

/** How much of the host label is actually legible, in characters, from its rendered width. */
async function visibleHostChars(page) {
  return await page.evaluate(() => {
    const el = document.querySelector('.status-host');
    if (!el) return { text: '', shown: 0, full: false };
    const text = (el.textContent ?? '').trim();
    const full = el.scrollWidth <= el.clientWidth + 1;
    if (full) return { text, shown: text.length, full };
    // Truncated: measure how many leading characters fit in the box the element actually has.
    const probe = document.createElement('span');
    const cs = getComputedStyle(el);
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${cs.font}`;
    document.body.appendChild(probe);
    let shown = 0;
    // The ellipsis takes room of its own, so the budget is the box minus one character's worth.
    probe.textContent = '…';
    const budget = el.clientWidth - probe.getBoundingClientRect().width;
    for (let i = 1; i <= text.length; i++) {
      probe.textContent = text.slice(0, i);
      if (probe.getBoundingClientRect().width > budget) break;
      shown = i;
    }
    probe.remove();
    return { text, shown, full };
  });
}

async function tabbarFlow({ capture = false } = {}) {
  const fail = (m) => {
    throw new Error(`tabbar: ${m}`);
  };

  if (capture) fs.mkdirSync(TABBAR_SHOT_DIR, { recursive: true });

  for (const theme of ['dark', 'light']) {
    const b = await launch(theme);
    try {
      const panel = await openPanel(b.ctx, b.extId, { settings: { theme } });
      // A real site tab, so the bar shows a real hostname rather than an empty status.
      //
      // The site tab stays in front deliberately (note 3): the panel targets whatever tab is
      // active, so bringing the panel forward would make the panel its own target and the bar
      // would show the extension's host instead. The panel behind it still renders and screenshots
      // normally.
      await openSite(b.ctx, `https://${TABBAR_HOST}/wiki/Common_kingfisher`);
      await panel.locator('.tabs').waitFor({ timeout: 20_000 });
      await panel.waitForFunction(
        (h) => document.querySelector('.status-host')?.textContent?.trim() === h,
        TABBAR_HOST,
        { timeout: 20_000 },
      );

      for (const width of TABBAR_WIDTHS) {
        const at = `${theme} @ ${width}px`;
        await panel.setViewportSize({ width, height: PANEL.height });
        await panel.waitForTimeout(250);

        // --- The bar itself: one row, no overflow, nothing clipped -----------
        const box = await panel.evaluate(() => {
          const bar = document.querySelector('.tabs');
          const r = bar.getBoundingClientRect();
          const kids = [...bar.querySelectorAll('button, .status')];
          return {
            scrollWidth: bar.scrollWidth,
            clientWidth: bar.clientWidth,
            height: Math.round(r.height),
            top: r.top,
            bottom: r.bottom,
            left: r.left,
            right: r.right,
            /*
             * Wrapping, detected by vertical overlap rather than by distinct top edges.
             *
             * The controls are deliberately different heights — a 28px pill next to a line of 11px
             * mono — so they do not share a top edge even when they are plainly on the same line.
             * What "one row" really means is that every control's vertical span overlaps every
             * other's; a wrapped control sits entirely below its neighbours.
             */
            rows: (() => {
              const bands = [];
              for (const k of kids) {
                const kr = k.getBoundingClientRect();
                const band = bands.find((bd) => kr.top < bd.bottom - 1 && kr.bottom > bd.top + 1);
                if (band) {
                  band.top = Math.min(band.top, kr.top);
                  band.bottom = Math.max(band.bottom, kr.bottom);
                } else {
                  bands.push({ top: kr.top, bottom: kr.bottom });
                }
              }
              return bands.length;
            })(),
            controls: kids.map((k) => {
              const kr = k.getBoundingClientRect();
              return {
                what: k.className || k.tagName,
                w: Math.round(kr.width),
                h: Math.round(kr.height),
                left: kr.left,
                right: kr.right,
                top: kr.top,
                bottom: kr.bottom,
                isButton: k.tagName === 'BUTTON',
              };
            }),
          };
        });

        if (box.scrollWidth > box.clientWidth) {
          fail(`${at}: the bar overflows — scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth}`);
        }
        if (box.rows !== 1) fail(`${at}: the bar wrapped onto ${box.rows} rows`);

        for (const c of box.controls) {
          if (c.left < box.left - 0.5 || c.right > box.right + 0.5) {
            fail(`${at}: ${c.what} is clipped horizontally (${c.left}–${c.right} outside ${box.left}–${box.right})`);
          }
          if (c.top < box.top - 0.5 || c.bottom > box.bottom + 0.5) {
            fail(`${at}: ${c.what} is clipped vertically`);
          }
          // Hit targets: every button in the bar must be at least 28x28.
          if (c.isButton && (c.w < 28 || c.h < 28)) {
            fail(`${at}: ${c.what} is only ${c.w}x${c.h}, under the 28x28 hit target`);
          }
        }

        // --- Labels: hidden when narrow, shown when wide ---------------------
        const labels = await panel.evaluate(() =>
          ['settings', 'dashboard'].map((a) => {
            const el = document.querySelector(`[data-action="${a}"] .tab-action-label`);
            const r = el.getBoundingClientRect();
            return { a, text: (el.textContent ?? '').trim(), visible: r.width > 1 && r.height > 1 };
          }),
        );
        const wide = width >= 640;
        for (const l of labels) {
          if (wide && !l.visible) fail(`${at}: the ${l.a} label should be visible at this width`);
          if (!wide && l.visible) fail(`${at}: the ${l.a} label is still visible — the bar did not go icon-only`);
          // Hidden or not, the text stays in the DOM: it is the accessible name.
          if (!l.text) fail(`${at}: the ${l.a} label has no text content`);
        }

        // Icon-only must still be named, and the icon itself must be there and drawn.
        for (const [action, expected] of [['settings', 'Settings'], ['dashboard', 'Dashboard']]) {
          const name = await accessibleName(panel, `[data-action="${action}"]`);
          if (name !== expected) fail(`${at}: ${action} exposes the accessible name ${JSON.stringify(name)}, not ${JSON.stringify(expected)}`);
          const title = await panel.getAttribute(`[data-action="${action}"]`, 'title');
          if (!title) fail(`${at}: ${action} has no title tooltip`);
          const icon = await panel.evaluate((a) => {
            const svg = document.querySelector(`[data-action="${a}"] svg.ico`);
            if (!svg) return null;
            const r = svg.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          }, action);
          if (!icon) fail(`${at}: ${action} has no inline icon`);
          if (icon.w < 12 || icon.h < 12) fail(`${at}: the ${action} icon rendered at ${icon.w}x${icon.h}`);
        }

        // --- The hostname is not sacrificed to make room ---------------------
        const host = await visibleHostChars(panel);
        if (host.text !== TABBAR_HOST) fail(`${at}: the bar shows host ${JSON.stringify(host.text)}`);
        if (width >= 420 && !host.full) {
          fail(`${at}: "${TABBAR_HOST}" is truncated (${host.shown} of ${host.text.length} chars) — it should fit whole here`);
        }
        if (width >= 360 && host.shown < 10) {
          fail(`${at}: only ${host.shown} characters of "${TABBAR_HOST}" are legible; at least 10 are required`);
        }

        if (capture && (width === 360 || width === 640)) {
          const file = path.join(TABBAR_SHOT_DIR, `tabbar-${theme}-${width}.png`);
          await panel.screenshot({ path: file, clip: { x: 0, y: 0, width, height: box.height + 2 } });
          log(`tabbar capture ${path.basename(file)}`);
        }
      }

      // --- Settings is a view of the panel, and selecting it says so ---------
      await panel.setViewportSize({ width: 360, height: PANEL.height });
      await panel.waitForTimeout(200);

      await panel.locator('[data-action="settings"]').click();
      await panel.locator('.view', { hasText: 'Provider' }).first().waitFor({ timeout: 10_000 });
      const current = await panel.getAttribute('[data-action="settings"]', 'aria-current');
      if (current !== 'page') fail(`${theme}: selecting Settings left aria-current=${JSON.stringify(current)}`);
      if (!(await panel.locator('[data-action="settings"].active').count())) {
        fail(`${theme}: the selected Settings control carries no active class`);
      }
      // Distinguishable without relying on colour alone: the selected control changes its border,
      // which is a shape cue a colour-blind user (or a greyscale display) still gets.
      const borders = await panel.evaluate(() => {
        const el = document.querySelector('[data-action="settings"]');
        const dash = document.querySelector('[data-action="dashboard"]');
        const g = (n) => {
          const cs = getComputedStyle(n);
          return { color: cs.borderTopColor, width: cs.borderTopWidth, shadow: cs.boxShadow };
        };
        return { on: g(el), off: g(dash) };
      });
      if (borders.on.color === borders.off.color && borders.on.shadow === borders.off.shadow) {
        fail(`${theme}: the selected Settings control is indistinguishable from the unselected Dashboard control`);
      }

      // And back. Chat is the left group's first tab.
      await panel.locator('.tab-group [data-view="chat"]').click();
      await waitForComposer(panel);
      if ((await panel.getAttribute('[data-action="settings"]', 'aria-current')) != null) {
        fail(`${theme}: Settings still reported itself current after returning to Chat`);
      }
      if (!(await panel.locator('[data-view="chat"].active').count())) {
        fail(`${theme}: Chat is not marked active after returning to it`);
      }
    } finally {
      await b.close();
    }
  }

  console.log(
    `tabbar: OK — no overflow or wrap at ${TABBAR_WIDTHS.join('/')}px in both themes, icon-only below the breakpoint with accessible names intact, labels at 640, "${TABBAR_HOST}" legible, Settings selects the view and Chat returns`,
  );
}

// ---------------------------------------------------------------------------
// Attached images: paste, drop, send, reload.
// ---------------------------------------------------------------------------
//
// Everything about an attachment that a unit test cannot reach is here: the clipboard and the
// drop event really carrying a File, the browser really decoding and re-encoding it, and — the
// assertion the whole feature rests on — what the backend actually received.
//
// The mock records every image_url part it is handed (scripts/mock-llm.mjs: collectImages), with
// its media type, decoded byte count, dimensions read out of the header, and whether it sat before
// the text part of its message. So this flow does not assert that the panel "looks like it sent an
// image"; it reads the wire.

const IMAGES_PROMPT = 'make the header look like this';

/**
 * A PNG generated in the page, as a File, so the paste and the drop carry real image bytes rather
 * than a fixture we would have to keep in the repo. `w`/`h` are the source size: the point of the
 * 6000px case is that the panel shrinks it rather than refusing it.
 */
const MAKE_PNG = `async (opts) => {
  const canvas = document.createElement('canvas');
  canvas.width = opts.w;
  canvas.height = opts.h;
  const ctx = canvas.getContext('2d');
  // Something with structure, so a downscale is visible and the JPEG encoder has work to do.
  ctx.fillStyle = opts.bg;
  ctx.fillRect(0, 0, opts.w, opts.h);
  ctx.fillStyle = opts.fg;
  for (let i = 0; i < opts.w; i += Math.max(8, Math.round(opts.w / 24))) ctx.fillRect(i, 0, Math.max(4, opts.w / 80), opts.h);
  ctx.fillStyle = '#ffffff';
  ctx.font = Math.round(opts.h / 6) + 'px sans-serif';
  ctx.fillText(opts.label, Math.round(opts.w / 12), Math.round(opts.h / 2));
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return new File([blob], opts.name, { type: 'image/png' });
}`;

/** Paste a generated PNG into the composer through a real ClipboardEvent carrying a File. */
async function pasteImage(panel, opts) {
  await panel.evaluate(
    async ([make, o]) => {
      const file = await eval(make)(o);
      const dt = new DataTransfer();
      dt.items.add(file);
      const ta = document.querySelector('.composer textarea');
      ta.focus();
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [MAKE_PNG, opts],
  );
}

/** Drop a generated image onto a target, through a real DragEvent carrying a File. */
async function dropImage(panel, selector, opts) {
  await panel.evaluate(
    async ([make, o, sel]) => {
      const file = await eval(make)(o);
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector(sel);
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [MAKE_PNG, opts, selector],
  );
}

/** Drop a file the panel must refuse, so the note it shows can be read. */
async function dropSvg(panel, selector) {
  await panel.evaluate(
    ([sel]) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
      const file = new File([svg], 'diagram.svg', { type: 'image/svg+xml' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector(sel);
      target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    [selector],
  );
}

/** Wait until the composer strip holds exactly `n` thumbnails. */
async function waitForThumbs(panel, n, timeout = 20_000) {
  await panel.waitForFunction((want) => document.querySelectorAll('.composer .attach img').length === want, n, { timeout });
}

async function imagesFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`images: ${m}`);
  };
  try {
    await clearViolations();
    await fetch(`${CONTROL_BASE}/__requests`, { method: 'DELETE' }).catch(() => {});
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await waitForComposer(panel);

    // --- 1. A pasted screenshot, and a dropped one --------------------------
    await pasteImage(panel, { w: 1200, h: 800, bg: '#123456', fg: '#2e5bfc', label: 'PASTED', name: 'pasted-mock.png' });
    await waitForThumbs(panel, 1);

    // The second arrives by drop, onto the message list rather than the composer: both are drop
    // targets, and a mockup dragged onto the conversation is the natural gesture.
    await dropImage(panel, '.messages', { w: 6000, h: 6000, bg: '#301040', fg: '#f343d3', label: 'DROPPED', name: 'dropped-huge.png' });
    await waitForThumbs(panel, 2);

    // Each thumbnail carries a size, and the 6000px one was SHRUNK rather than refused — which is
    // the difference between a cap that helps and a cap that gets in the way.
    const labels = await panel.locator('.composer .attach .attach-size').allTextContents();
    if (labels.length !== 2) fail(`expected 2 size labels, got ${labels.length}`);
    for (const l of labels) {
      if (!/\d+×\d+ · /.test(l)) fail(`a thumbnail's size label read ${JSON.stringify(l)}`);
    }
    const huge = labels.find((l) => l.startsWith('1568×1568'));
    if (!huge) fail(`the 6000×6000 image was not downscaled to 1568 on its long edge: ${labels.join(' | ')}`);

    // --- 2. An SVG is refused, with a note ----------------------------------
    await dropSvg(panel, '.composer');
    await panel.locator('.composer .attach-note').waitFor({ timeout: 10_000 });
    const note = (await panel.locator('.composer .attach-note').textContent()) ?? '';
    if (!/SVG is not supported/i.test(note)) fail(`the SVG refusal read ${JSON.stringify(note)}`);
    if ((await panel.locator('.composer .attach img').count()) !== 2) fail('the refused SVG was attached anyway');

    // --- 3. Removing one -----------------------------------------------------
    await panel.locator('.composer .attach .attach-x').first().click();
    await waitForThumbs(panel, 1);
    const left = (await panel.locator('.composer .attach .attach-size').first().textContent()) ?? '';
    if (!left.startsWith('1568×1568')) fail(`removing the first thumbnail left ${JSON.stringify(left)}; the wrong one went`);

    // A capture of the composer carrying attachments. Taken with two thumbnails, so it shows the
    // strip doing its job; the removal above is re-done after.
    await pasteImage(panel, { w: 1200, h: 800, bg: '#123456', fg: '#2e5bfc', label: 'PASTED', name: 'pasted-mock.png' });
    await waitForThumbs(panel, 2);
    await panel.locator('.composer textarea').fill(IMAGES_PROMPT);
    await panel.waitForTimeout(300);
    await shot(panel, '08-images-composer.png');
    await panel.locator('.composer .attach .attach-x').last().click();
    await waitForThumbs(panel, 1);

    // --- 4. Send, and read what the backend was handed -----------------------
    await panel.locator('.composer button.btn.primary').click();
    await panel.locator('.messages .msg.assistant', { hasText: IMAGES_MARKER }).waitFor({ timeout: 60_000 });
    await panel.waitForTimeout(400);

    const requests = (await fetchRequests()).filter((r) => r.script === 'attached-images');
    if (!requests.length) fail('the mock never received a request for the attached-images script');
    const first = requests[0];
    const sent = first.images ?? [];
    if (sent.length !== 1) fail(`the request carried ${sent.length} image parts; exactly 1 was attached`);
    const [only] = sent;
    if (only.mediaType !== 'image/jpeg') fail(`the attachment was sent as ${only.mediaType}; it is re-encoded to JPEG`);
    if (!only.beforeText) fail('the image part came AFTER the text part of its message; providers expect image then text');
    if (only.width !== 1568 || only.height !== 1568) {
      fail(`the sent image measured ${only.width}×${only.height}; it should have been downscaled to 1568×1568`);
    }
    if (!(only.bytes > 1000 && only.bytes <= 1_200_000)) fail(`the sent image was ${only.bytes} bytes, outside the expected range`);

    // The caption the model can refer to the picture by, in the same message.
    const userMsg = (first.messages ?? []).filter((m) => m.role === 'user').pop();
    const captions = (Array.isArray(userMsg?.content) ? userMsg.content : [])
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    if (!/\[attached image 1: 1568x1568 jpeg, dropped-huge\.png\]/.test(captions)) {
      fail(`the user message carried no caption for the attachment: ${JSON.stringify(captions.slice(0, 300))}`);
    }

    // --- 5. The sent bubble, the lightbox ------------------------------------
    const bubbleThumbs = panel.locator('.messages .msg.user .attach img');
    if ((await bubbleThumbs.count()) !== 1) fail(`the sent bubble shows ${await bubbleThumbs.count()} thumbnails, expected 1`);
    await shot(panel, '08-images-sent.png');

    await panel.locator('.messages .msg.user button.attach').first().click();
    await panel.locator('.lightbox img').waitFor({ timeout: 10_000 });
    // The overlay shows the FULL image out of the blob store, not the thumbnail it was opened from.
    await panel
      .waitForFunction(
        () => {
          const img = document.querySelector('.lightbox img');
          return !!img && img.naturalWidth > 320;
        },
        null,
        { timeout: 15_000 },
      )
      .catch(() => fail('the lightbox never loaded the full-size image from the chat blob store'));
    await panel.keyboard.press('Escape');
    await panel.locator('.lightbox').waitFor({ state: 'detached', timeout: 10_000 });

    // --- 6. A reload still shows the picture ---------------------------------
    await reloadPanel(panel);
    await panel.locator('.messages .msg.user .attach img').first().waitFor({ timeout: 30_000 });
    const afterReload = await panel.locator('.messages .msg.user .attach img').count();
    if (afterReload !== 1) fail(`after a reload the bubble shows ${afterReload} thumbnails, expected 1`);
    // Rendered from the transcript's own data URL, so it is there without touching the blob store.
    const thumbSrc = await panel.locator('.messages .msg.user .attach img').first().getAttribute('src');
    if (!thumbSrc?.startsWith('data:image/')) fail(`the restored thumbnail src was ${JSON.stringify((thumbSrc ?? '').slice(0, 40))}`);

    // --- 7. Storage: a thumbnail in the transcript, the full copy beside it ---
    const storage = await panel.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      const out = { items: null, blobs: null, itemsBytes: 0 };
      for (const [k, v] of Object.entries(all)) {
        if (k.endsWith(':items')) {
          out.items = v;
          out.itemsBytes = JSON.stringify(v).length;
        }
        if (k.endsWith(':blobs')) out.blobs = v;
      }
      return out;
    });
    const stored = (storage.items ?? []).find((it) => it.kind === 'user' && it.images?.length);
    if (!stored) fail('the stored transcript has no user row carrying images');
    const [thumb] = stored.images;
    if (!thumb.hash) fail('the stored thumbnail carries no blob hash');
    if (!thumb.thumb?.startsWith('data:image/')) fail('the stored thumbnail is not a data URL');
    if (thumb.width !== 1568 || thumb.height !== 1568) fail(`the stored row records ${thumb.width}×${thumb.height}`);
    const blobs = storage.blobs ?? {};
    if (!blobs[thumb.hash]) fail(`the blob store has no entry for hash ${thumb.hash} (keys: ${Object.keys(blobs).join(',')})`);
    if (blobs[thumb.hash].data.length <= thumb.thumb.length) {
      fail('the stored blob is no larger than its thumbnail, so the full-size copy was never written');
    }
    // The transcript is read and rewritten constantly; the thumbnail must not make it heavy.
    if (storage.itemsBytes > 300_000) fail(`the stored transcript is ${storage.itemsBytes} bytes; the thumbnail is too big for it`);

    await assertNoViolations('images');
    console.log(
      'images: OK — pasted and dropped, 6000px downscaled to 1568, SVG refused, one removed, one image part sent before the text as JPEG with its caption, bubble thumbnail, lightbox opened from the blob store and closed on Escape, thumbnail survived a reload, zero invalid requests',
    );
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------

/**
 * The living specimen, captured in both themes for docs/design.md.
 *
 * It renders entrypoints/styleguide, which loads the REAL stylesheets, so these images are evidence
 * of what the system actually looks like rather than an illustration of what it is meant to look
 * like. The doc embeds them; if a component changes and this is not re-run, the doc is visibly out
 * of date rather than quietly wrong.
 */
async function styleguideFlow() {
  const DESIGN_DIR = path.join(ROOT, 'docs', 'design');
  fs.mkdirSync(DESIGN_DIR, { recursive: true });
  const b = await launch('dark');
  try {
    for (const theme of ['dark', 'light']) {
      const page = await b.ctx.newPage();
      await page.setViewportSize({ width: 1180, height: 1200 });
      // The stored SETTING, not the attribute: the page calls applyStoredTheme() on mount, which
      // would overwrite an attribute set here and leave both captures in the default palette.
      await page.goto(`chrome-extension://${b.extId}/styleguide.html`);
      await page.evaluate(async (t) => {
        await chrome.storage.local.set({ settings: { theme: t } });
      }, theme);
      await page.reload();
      await page.waitForSelector('.sg-section');
      await page.waitForFunction(
        (t) => document.documentElement.getAttribute('data-theme') === t,
        theme,
        { timeout: 10_000 },
      );
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const file = path.join(DESIGN_DIR, `styleguide-${theme === 'dark' ? 'night' : 'day'}.png`);
      await page.screenshot({ path: file, fullPage: true });
      const kb = Math.round(fs.statSync(file).size / 1024);
      log(`docs/design/${path.basename(file)} (${kb} KB)`);
      await page.close();
    }
  } finally {
    await b.close();
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mock = await startMock();
  try {
    if (STYLEGUIDE) {
      await styleguideFlow();
      return;
    }
    if (TABBAR || TABBAR_SHOT) {
      await tabbarFlow({ capture: TABBAR_SHOT });
      return;
    }
    if (WAIT) {
      await waitFlow();
      return;
    }
    if (IMAGES) {
      await imagesFlow();
      return;
    }
    if (THEME) {
      await themeFlow();
      return;
    }
    if (COMPACTION) {
      await compactionFlow();
      return;
    }
    if (ISOLATION) {
      await isolationFlow();
      return;
    }
    if (DASHBOARD || DASHBOARD_SHOT) {
      await dashboardFlow({ capture: DASHBOARD_SHOT });
      return;
    }
    if (CHATS) {
      await chatsFlow();
      return;
    }
    if (SMOKE) {
      await smoke();
      await guardrails();
      await activityFlow();
      await chatsFlow();
      await isolationFlow();
      await compactionFlow();
      await dashboardFlow();
      await themeFlow();
      await tabbarFlow();
      await waitFlow();
      await imagesFlow();
      return;
    }
    // The dark set: the design system's own palette, and what the README leads with.
    await chatProposal('dark', '01-chat-proposal.png');
    await chatRefs();
    await mods('dark', '03-mods.png');
    await settings('dark', '04-settings.png');
    await install('dark', '05-install.png');
    await migrate('dark');
    await dashboardFlow({ capture: true });

    // The light set: the same three screens the README puts side by side with their dark twins.
    await chatProposal('light', '01-chat-proposal-light.png');
    await mods('light', '03-mods-light.png');
    await settings('light', '04-settings-light.png');

    const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).sort();
    log(`wrote ${files.length} screenshots to docs/screenshots/`);
    const small = files.filter((f) => fs.statSync(path.join(OUT_DIR, f)).size < 20 * 1024);
    if (small.length) throw new Error(`suspiciously small screenshots: ${small.join(', ')}`);
  } finally {
    mock.kill();
  }
}

await main();
