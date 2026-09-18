#!/usr/bin/env node
// Regenerates docs/screenshots/*.png with Playwright, driving the real extension against the
// scripted mock backend in scripts/mock-llm.mjs. No API key and no network model call.
//
//   npm run screenshots     capture everything into docs/screenshots/
//   npm run smoke           the same chat flow, headless, asserting the proposal card appears
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
//    the screenshots only (HIDE_SETUP_NOTICE below). The consequence for the scripted
//    conversations is that run_script and screenshot would fail, so the mock never calls them;
//    get_page, find_elements and get_styles go through the content script and work for real
//    against the live pages.
//
// 5. Settings are seeded by evaluating chrome.storage.local.set from an extension page, which
//    has the same storage as the side panel.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
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

/** See note 4: a first-run setup instruction, not the steady state the README should show. */
const HIDE_SETUP_NOTICE = '.app > .notice { display: none !important; }';

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

/** Open the panel page, seed settings and storage, and return the page. */
async function openPanel(ctx, extId, { settings = {}, storage = {} } = {}) {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.evaluate(
    async ([s, extra]) => {
      await chrome.storage.local.set({ settings: s, ...extra });
    },
    [{ provider: 'openai-compatible', baseUrl: BASE_URL, apiKey: '', model: 'demo', ...settings }, storage],
  );
  await page.reload();
  await page.addStyleTag({ content: HIDE_SETUP_NOTICE });
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
  await page.addStyleTag({ content: HIDE_SETUP_NOTICE }).catch(() => {});
  const file = path.join(OUT_DIR, name);
  await page.screenshot({ path: file });
  const kb = Math.round(fs.statSync(file).size / 1024);
  log(`${name} (${kb} KB)`);
  return file;
}

/** Send a message in the panel and wait for the proposal card. */
async function runConversation(panel, text, { refreshTitle = false } = {}) {
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
    await panel.reload();
    await panel.addStyleTag({ content: HIDE_SETUP_NOTICE }).catch(() => {});
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
// The captures
// ---------------------------------------------------------------------------

/** 01 — a finished conversation with the proposal card, in one color scheme. */
async function chatProposal(colorScheme, name) {
  const b = await launch(colorScheme);
  try {
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1200);
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
    await panel.waitForTimeout(1200);

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
async function mods() {
  const b = await launch('light');
  try {
    const panel = await openPanel(b.ctx, b.extId, { storage: { mods: seedMods() } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1000);
    await panel.locator('.tabs button', { hasText: 'Mods' }).click();
    await panel.waitForTimeout(600);
    return await shot(panel, '03-mods.png');
  } finally {
    await b.close();
  }
}

/** 04 — Settings, provider presets and the ChatGPT subscription card, not signed in. */
async function settings() {
  const b = await launch('light');
  try {
    const panel = await openPanel(b.ctx, b.extId, { settings: { provider: 'chatgpt', baseUrl: '', apiKey: '', model: '' } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(800);
    await panel.locator('.tabs button', { hasText: 'Settings' }).click();
    await panel.waitForTimeout(600);
    return await shot(panel, '04-settings.png');
  } finally {
    await b.close();
  }
}

/** 05 — the install page for a real Greasy Fork script, fetched live. */
async function install() {
  const b = await launch('light');
  try {
    // The install page is a full page, not a panel, so give it a page-sized viewport.
    const page = await b.ctx.newPage();
    await page.setViewportSize({ width: 860, height: 900 });
    await page.goto(`chrome-extension://${b.extId}/install.html?url=${encodeURIComponent(GREASY_FORK_URL)}`);
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
    return await shot(page, '05-install.png');
  } finally {
    await b.close();
  }
}

/** 06 — the Migrate from Tampermonkey card, expanded. */
async function migrate() {
  const b = await launch('light');
  try {
    const panel = await openPanel(b.ctx, b.extId, { storage: { mods: seedMods() } });
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(800);
    await panel.locator('.tabs button', { hasText: 'Mods' }).click();
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
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1200);
    await runConversation(panel, 'hide the sidebar and make the article full width');

    const fail = (m) => {
      throw new Error(`smoke: ${m}`);
    };

    const title = (await panel.locator('.messages .card h4').first().textContent())?.trim();
    if (title !== 'Wikipedia: full-width article') fail(`proposal title was ${JSON.stringify(title)}`);

    const match = (await panel.locator('.messages .card .chip').first().textContent())?.trim();
    if (match !== '*://*.wikipedia.org/wiki/*') fail(`match pattern was ${JSON.stringify(match)}`);

    // The tools really ran against the page through the content script.
    const tools = await panel.locator('.messages .tool summary').allTextContents();
    for (const name of ['get_page', 'find_elements', 'get_styles', 'propose_mod']) {
      if (!tools.some((t) => t.includes(name))) fail(`no ${name} row in the transcript (rows: ${tools.join(' | ')})`);
    }
    if (tools.some((t) => t.startsWith('✗'))) fail(`a tool call failed: ${tools.filter((t) => t.startsWith('✗')).join(' | ')}`);

    // The generated code is present and is the real script, not a placeholder.
    const code = await panel.locator('.messages .card pre').first().textContent();
    if (!code?.includes('vector-toc-pinned-container')) fail('proposal code did not contain the expected selector');

    // Saving it puts a real mod in storage.
    await panel.locator('.messages .card button.btn.primary').click();
    await panel.locator('.messages .card button.btn.primary', { hasText: 'Saved & enabled' }).waitFor({ timeout: 10_000 });
    const saved = await panel.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? []);
    if (saved.length !== 1) fail(`expected 1 saved mod, got ${saved.length}`);
    if (!saved[0].source.includes('==UserScript==')) fail('saved mod has no userscript header');

    console.log('smoke: OK — streamed reply, 3 page-inspection tools, proposal card, save to storage');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mock = await startMock();
  try {
    if (SMOKE) {
      await smoke();
      return;
    }
    await chatProposal('light', '01-chat-proposal.png');
    await chatProposal('dark', '01-chat-proposal-dark.png');
    await chatRefs();
    await mods();
    await settings();
    await install();
    await migrate();

    const files = fs.readdirSync(OUT_DIR).filter((f) => f.endsWith('.png')).sort();
    log(`wrote ${files.length} screenshots to docs/screenshots/`);
    const small = files.filter((f) => fs.statSync(path.join(OUT_DIR, f)).size < 20 * 1024);
    if (small.length) throw new Error(`suspiciously small screenshots: ${small.join(', ')}`);
  } finally {
    mock.kill();
  }
}

await main();
