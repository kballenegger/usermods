#!/usr/bin/env node
// Regenerates docs/screenshots/*.png with Playwright, driving the real extension against the
// scripted mock backend in scripts/mock-llm.mjs. No API key and no network model call.
//
//   npm run screenshots     capture everything into docs/screenshots/
//   npm run smoke            headless: the chat, guardrails, activity, chats, isolation and
//                            compaction flows, all asserted
//   npm run smoke:chats      headless: the chats flow alone (restore, New chat, archive/unarchive)
//   npm run smoke:isolation  headless: the isolation flow alone (two chats running at once, no bleed)
//   npm run smoke:compaction headless: the compaction flow alone (both tiers, on a shrunken budget)
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
import { COMPACT_MARKER, FAST_MARKER, SLOW_MARKER, SUMMARY_MARKER } from './mock-llm.mjs';
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

/** True when this run is capturing screenshots rather than asserting behaviour (see MASK below). */
const CAPTURING = !SMOKE && !CHATS && !ISOLATION && !COMPACTION;

/** See note 4: a first-run setup instruction, not the steady state the README should show. */
const HIDE_SETUP_NOTICE = '.app > .notice { display: none !important; }';

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
    await panel.addStyleTag({ content: MASK }).catch(() => {});
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
    await clearViolations();
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
  const b = await launch('light');
  try {
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1200);
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

    console.log('guardrails: OK — read-budget nudge and propose-time refusal both reached the model, override accepted');
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
    await panel.waitForTimeout(1200);

    const indicator = panel.locator('.activity');
    if (await indicator.count()) fail('the activity line was showing before anything had been sent');

    // A tool phase can be over in a few milliseconds, so sampling the DOM from here would be a
    // coin flip. Record every distinct value the line takes instead, from inside the page.
    await installActivityRecorder(panel);

    // --- 1. It appears within 500ms of sending. The mock does not answer for ~3s, so if the line
    // waited for the backend rather than for the send, it would not be up yet.
    await panel.locator('textarea').fill(THINKING_PROMPT);
    const sentAt = Date.now();
    await panel.locator('.composer button.btn.primary').click();
    await indicator.waitFor({ timeout: 2_000 });
    const appearedIn = Date.now() - sentAt;
    if (appearedIn > 500) fail(`the activity line took ${appearedIn}ms to appear, which is longer than the 500ms it promises`);

    // --- 2. During the delay it says it is waiting for the model, and its timer ticks.
    const waitingText = (await indicator.textContent())?.trim() ?? '';
    if (!/waiting for model/i.test(waitingText)) fail(`the line did not say it was waiting for the model (it said ${JSON.stringify(waitingText)})`);

    const firstTimer = await readTimer(panel);
    if (firstTimer === null) fail(`the line showed no elapsed timer (it said ${JSON.stringify(waitingText)})`);
    await panel.waitForTimeout(1600);
    const secondTimer = await readTimer(panel);
    if (secondTimer === null || secondTimer <= firstTimer) {
      fail(`the elapsed timer did not tick: it read ${firstTimer}s then ${secondTimer}s`);
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
    console.log('activity: OK — appears <500ms, waiting label with a ticking timer, tool label, gone after done');

  } finally {
    await b.close();
  }
}

/** The elapsed seconds the line is showing, or null if it is not showing one. */
async function readTimer(panel) {
  const text = await panel.locator('.activity').textContent().catch(() => null);
  const m = text?.match(/(\d+)s(?!\w)/);
  return m ? Number(m[1]) : null;
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

/** Reload the panel tab the way a user reopening the side panel would, and settle. */
async function reopenPanel(panel) {
  await panel.reload();
  await panel.addStyleTag({ content: MASK }).catch(() => {});
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
    await clearViolations();
    const panel = await openPanel(b.ctx, b.extId);
    await openSite(b.ctx, 'https://en.wikipedia.org/wiki/Common_kingfisher');
    await panel.waitForTimeout(1200);

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
    await panel.locator('.chatbar button.btn', { hasText: 'Rename' }).click();
    await panel.locator('.chatbar input.rename').waitFor({ timeout: 5000 });
    await panel.locator('.chatbar input.rename').fill('this one is abandoned');
    await panel.locator('.chatbar input.rename').press('Escape');
    await panel.waitForTimeout(400);
    if (await panel.locator('.chatbar input.rename').count()) fail('Escape did not take the switcher out of rename mode');
    const afterEscape = await selectedLabel(panel);
    if (afterEscape?.includes('abandoned')) fail(`Escape saved the abandoned name anyway (switcher reads ${JSON.stringify(afterEscape)})`);

    await panel.locator('.chatbar button.btn', { hasText: 'Rename' }).click();
    await panel.locator('.chatbar input.rename').waitFor({ timeout: 5000 });
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
    await panel.waitForTimeout(1200);

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

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const mock = await startMock();
  try {
    if (COMPACTION) {
      await compactionFlow();
      return;
    }
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
      await guardrails();
      await activityFlow();
      await chatsFlow();
      await isolationFlow();
      await compactionFlow();
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
