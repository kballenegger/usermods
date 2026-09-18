#!/usr/bin/env node
// Regenerates docs/screenshots/*.png with Playwright, driving the real extension against the
// scripted mock backend in scripts/mock-llm.mjs. No API key and no network model call.
//
//   npm run screenshots     capture everything into docs/screenshots/
//   npm run smoke           headless: the chat flow, the chats flow and the isolation flow, all asserted
//   npm run smoke:chats     headless: the chats flow alone (restore, New chat, archive/unarchive)
//   npm run smoke:isolation headless: the isolation flow alone (two chats running at once, no bleed)
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
import { FAST_MARKER, SLOW_MARKER } from './mock-llm.mjs';
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
      // consent: the first-run data notice, acknowledged, so the panel opens straight into the chat.
      await chrome.storage.local.set({ settings: s, consent: { version: 1, acceptedAt: Date.now() }, ...extra });
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
// Chats test: the panel always comes back to the last chat, and archiving is what takes it away.
// ---------------------------------------------------------------------------

const PROMPT = 'hide the sidebar and make the article full width';
const PROPOSAL_TITLE = 'Wikipedia: full-width article';

/** Reload the panel tab the way a user reopening the side panel would, and settle. */
async function reopenPanel(panel) {
  await panel.reload();
  await panel.addStyleTag({ content: HIDE_SETUP_NOTICE }).catch(() => {});
  // Long enough for the host lookup, the chat lookup and the transcript read to all resolve.
  await panel.waitForTimeout(2500);
}

/** The switcher's options, as "<group>/<label>" so the Archived group can be asserted on. */
async function switcherOptions(panel) {
  return panel.locator('.chatbar select').evaluate((sel) =>
    [...sel.querySelectorAll('option')].map((o) => `${o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : ''}/${o.textContent}`),
  );
}

async function chatsFlow() {
  const b = await launch('light');
  const fail = (m) => {
    throw new Error(`chats: ${m}`);
  };
  try {
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1200);

    // --- 1. A real conversation, so there is something to come back to.
    await runConversation(panel, PROMPT);
    const firstTitle = (await panel.locator('.messages .card h4').first().textContent())?.trim();
    if (firstTitle !== PROPOSAL_TITLE) fail(`the conversation did not produce the expected proposal (got ${JSON.stringify(firstTitle)})`);

    // The switcher must show the real title straight away — the background writes it while the run
    // starts, and the panel used to keep saying "New chat" until the next reload.
    const liveLabel = await panel.locator('.chatbar select option:checked').textContent();
    if (!liveLabel?.includes(PROMPT.slice(0, 20))) fail(`the switcher still showed ${JSON.stringify(liveLabel)} instead of the chat's title right after the first send`);

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

    let options = await switcherOptions(panel);
    if (!options.some((o) => o.startsWith('Archived/') && o.includes(PROMPT.slice(0, 20)))) {
      fail(`the archived chat was not under an "Archived" group (options: ${JSON.stringify(options)})`);
    }
    if (options.some((o) => o.startsWith('/') && o.includes(PROMPT.slice(0, 20)))) {
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

    // --- 7. Sending in an archived chat brings it back to life.
    await panel.locator('textarea').fill('and dim the images a little');
    await panel.locator('.composer button.btn.primary').click();
    await panel.waitForTimeout(1500);
    await panel.locator('.chatbar button.btn', { hasText: 'Archive' }).waitFor({ timeout: 20_000 }).catch(() => {});
    await reopenPanel(panel);
    const revived = await panel.locator('.messages .msg.user').first().textContent();
    if (!revived?.includes(PROMPT)) fail(`sending in an archived chat did not unarchive it: reopening showed ${JSON.stringify(revived)}`);
    options = await switcherOptions(panel);
    if (options.some((o) => o.startsWith('Archived/'))) fail(`the chat was still in the Archived group after a send (options: ${JSON.stringify(options)})`);

    console.log('chats: OK — last chat restored on reopen, New chat not persisted, archive hides and unarchives on send');
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
    const panel = await openPanel(b.ctx, b.extId);

    // --- Tab 1: the slow chat, A.
    const tab1 = await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1200);
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
    await panel.locator('.messages .msg.assistant', { hasText: FAST_MARKER }).waitFor({ timeout: 30_000 });
    // B has answered; pressing Stop here is the user tidying up their own chat.
    const stopInB = panel.locator('.composer button.btn.danger', { hasText: 'Stop' });
    if (await stopInB.count()) await stopInB.click();

    const bText = await transcriptText(panel);
    if (!bText.includes(FAST_MARKER)) fail(`chat B did not get its own answer (transcript: ${JSON.stringify(bText.slice(0, 300))})`);
    if (bText.includes(SLOW_MARKER)) fail(`chat A's output bled into chat B's transcript: ${JSON.stringify(bText.slice(0, 400))}`);
    if (bText.includes(SLOW_PROMPT)) fail(`chat A's user message appeared in chat B: ${JSON.stringify(bText.slice(0, 400))}`);

    // --- Let A finish while B is on screen, then go back to it.
    await panel.waitForTimeout(12_000);
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
    await panel.locator('.messages .msg.assistant', { hasText: FAST_MARKER }).waitFor({ timeout: 30_000 });
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

    console.log('isolation: OK — two chats ran at once with no bleed on screen, in storage, or on the wire; Stop in B left A alone');
  } finally {
    await b.close();
  }
}

// ---------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mock = await startMock();
  try {
    if (ISOLATION) {
      await isolationFlow();
      return;
    }
    if (CHATS) {
      await chatsFlow();
      return;
    }
    if (SMOKE) {
      await smoke();
      await chatsFlow();
      await isolationFlow();
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
