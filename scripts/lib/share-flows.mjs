// The `share` and `banner` smoke flows (npm run smoke:share, npm run smoke:banner), driven from
// scripts/screenshots.mjs, which passes in its browser helpers.
//
// Nothing here touches GitHub or Greasy Fork. Every https://gist.github.com/*, https://greasyfork.org/*
// and gist.githubusercontent.com request the browser makes is answered by a Playwright route from
// the reconstructed pages in scripts/lib/share-fixtures.mjs and the saved pages in
// test/fixtures/pages; a save is a form POST the route answers with the redirect the real site
// sends. No account, no token, no gist, no post.
import fs from 'node:fs';
import path from 'node:path';
import { gist404Page, gistEditorPage, gistViewPage, greasyForkFormPage, greasyForkScriptPage, greasyForkSignInPage } from './share-fixtures.mjs';

const html = (body, status = 200) => ({ status, contentType: 'text/html; charset=utf-8', body });

/**
 * Chrome flags for both flows: the real hosts do not resolve at all, so anything a route does not
 * answer fails in the browser instead of reaching GitHub or Greasy Fork. Routes are consulted
 * before DNS, so every routed request still works.
 */
export const OFFLINE_HOSTS = [
  '--host-resolver-rules=' +
    ['gist.github.com', 'github.com', '*.github.com', 'gist.githubusercontent.com', 'raw.githubusercontent.com', '*.githubassets.com', 'greasyfork.org', '*.greasyfork.org', 'openuserjs.org', 'paste.example.com', 'frame.example.com', 'smoke.example']
      .map((h) => `MAP ${h} ~NOTFOUND`)
      .join(', '),
];

/**
 * A tab the extension opens (chrome.tabs.create from the background) starts navigating before
 * Playwright has attached to it, so its FIRST request escapes the context's routes — it would go
 * to the real site. Test instrumentation, not product behaviour: the worker's tabs.create is
 * wrapped so an https tab opens blank and is then sent to its URL, by which time Playwright is
 * attached and the route answers. The product code is untouched.
 */
async function holdExtensionTabs(ctx) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
  await sw.evaluate(() => {
    const g = globalThis;
    if (g.__usermodsHeldTabs) return;
    g.__usermodsHeldTabs = true;
    const create = chrome.tabs.create.bind(chrome.tabs);
    chrome.tabs.create = async (props) => {
      if (!props?.url || !/^https:/.test(props.url)) return create(props);
      const tab = await create({ ...props, url: 'about:blank' });
      await new Promise((r) => setTimeout(r, 400));
      return chrome.tabs.update(tab.id, { url: props.url });
    };
  });
}

const WIDE_WIKI = [
  '// ==UserScript==',
  '// @name         Wide Wiki',
  '// @namespace    https://example.com/wide-wiki',
  '// @version      1.0.0',
  '// @description  Lets Wikipedia articles use the whole window.',
  '// @match        *://*.wikipedia.org/*',
  '// @grant        GM_addStyle',
  '// ==/UserScript==',
  '',
  "GM_addStyle('.mw-page-container { max-width: none !important; }');",
  '',
].join('\n');

// A fake OpenAI-style key, assembled here so the file itself holds no key-shaped string.
const FAKE_KEY = ['sk-', 'proj-', 'TESTONLY', '0000000000000000000000'].join('');
const LEAKY = [
  '// ==UserScript==',
  '// @name         Summarise with my key',
  '// @version      0.3.0',
  '// @description  Posts the page to a model.',
  '// @match        *://news.ycombinator.com/*',
  '// ==/UserScript==',
  '',
  `const KEY = '${FAKE_KEY}';`,
  "fetch('https://api.example.com/v1/chat', { headers: { Authorization: 'Bearer ' + KEY } });",
  '',
].join('\n');

const QUIET = [
  '// ==UserScript==',
  '// @name         Quiet HN',
  '// @version      2.0.0',
  '// @description  Hides vote counts.',
  '// @match        *://news.ycombinator.com/*',
  '// ==/UserScript==',
  '',
  "document.querySelectorAll('.score').forEach((e) => e.remove());",
  '',
].join('\n');

function mod(source, over = {}) {
  const now = Date.now();
  const name = source.match(/@name\s+(.+)/)[1].trim();
  return {
    id: crypto.randomUUID(),
    name,
    description: (source.match(/@description\s+(.+)/) ?? [])[1] ?? '',
    version: (source.match(/@version\s+(.+)/) ?? [])[1]?.trim() ?? '',
    matches: [source.match(/@match\s+(.+)/)[1].trim()],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    allFrames: true,
    grants: [],
    connect: [],
    requires: [],
    resources: [],
    source,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/** Wait for `fn` to be truthy, polling; the failure names what was awaited. */
async function until(what, fn, timeout = 15_000) {
  const end = Date.now() + timeout;
  let last;
  while (Date.now() < end) {
    last = await fn().catch((e) => (e instanceof Error ? e : new Error(String(e))));
    if (last && !(last instanceof Error)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`share: timed out waiting for ${what}${last instanceof Error ? ` (${last.message})` : ''}`);
}

async function hintText(page, testId) {
  try {
    return await page.locator(`[data-usermods="hint"] [data-testid="${testId}"] [data-testid="usermods-hint-text"]`).textContent({ timeout: 20_000 });
  } catch (e) {
    // Say what IS there: another hint, or none at all.
    const seen = await page.evaluate(() => Array.from(document.querySelectorAll('[data-usermods="hint"]')).map((h) => h.shadowRoot?.textContent ?? '')).catch(() => []);
    throw new Error(`no ${testId} hint on ${page.url()}; hints present: ${JSON.stringify(seen)}; ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

/**
 * The share flow. See the flow list in scripts/screenshots.mjs for what it proves; in order: a new
 * gist is filled through the editor's own API and pointed at, a save is remembered with its
 * install link and @updateURL/@downloadURL, "Update gist" re-opens the edit page with the bumped
 * version filled by a synthetic paste, a redesigned page falls back to the clipboard, the leak
 * check holds a key-carrying script until "Share anyway", a deleted gist offers a new one, a
 * signed-out share waits for the sign-in, and Greasy Fork is filled, remembered and re-posted.
 */
export async function shareFlow({ launch, openPanel, openSite, log, outDir, capture = false }) {
  const b = await launch('light', { args: OFFLINE_HOSTS });
  const fail = (m) => {
    throw new Error(`share: ${m}`);
  };
  await holdExtensionTabs(b.ctx);
  try {
    const gist = { signedIn: true, variant: 'default', gists: new Map(), posts: 0 };
    const USER = 'smokeuser';
    // Catch-alls first (Playwright tries the most recently added route first), so a favicon or any
    // stray request to these hosts is answered here rather than going out.
    for (const host of ['https://github.com/**', 'https://gist.githubusercontent.com/**', 'https://greasyfork.org/**', 'https://update.greasyfork.org/**']) {
      await b.ctx.route(host, (route) => route.fulfill(html('<title>Not found</title>', 404)));
    }
    await b.ctx.route('https://gist.github.com/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (req.method() === 'POST') {
        const form = new URLSearchParams(req.postData() ?? '');
        const names = form.getAll('gist[contents][][name]');
        const values = form.getAll('gist[contents][][value]');
        const files = names.map((name, i) => ({ name, content: values[i] ?? '' }));
        gist.posts++;
        let id;
        const edit = u.pathname.match(/^\/smokeuser\/([0-9a-f]+)$/);
        if (edit) id = edit[1];
        else id = (gist.posts.toString(16) + 'b'.repeat(32)).slice(0, 32);
        gist.gists.set(id, { files, description: form.get('gist[description]') ?? '' });
        return route.fulfill({ status: 302, headers: { location: `https://gist.github.com/${USER}/${id}` } });
      }
      if (u.pathname === '/' || u.pathname === '/new') {
        if (!gist.signedIn) return route.fulfill(html(fs.readFileSync(path.join(process.cwd(), 'test/fixtures/pages/gist-signed-out.html'), 'utf8')));
        return route.fulfill(html(gistEditorPage({ mode: 'new', variant: gist.variant })));
      }
      const m = u.pathname.match(/^\/smokeuser\/([0-9a-f]+)(\/edit)?$/);
      const g = m && gist.gists.get(m[1]);
      if (!g) return route.fulfill(html(gist404Page(), 404));
      if (m[2]) return route.fulfill(html(gistEditorPage({ mode: 'edit', files: g.files, description: g.description, action: `/${USER}/${m[1]}`, variant: gist.variant })));
      return route.fulfill(html(gistViewPage({ user: USER, id: m[1], files: g.files })));
    });
    await b.ctx.route('https://github.com/login**', (route) => route.fulfill(html('<!doctype html><title>Sign in to GitHub</title><form action="/session"><input name="login" type="text"></form>')));
    const gf = { scripts: new Map(), next: 424242 };
    await b.ctx.route('https://greasyfork.org/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      if (req.method() === 'POST') {
        const body = req.postData() ?? '';
        const code = (body.match(/name="script_version\[code\]"\r?\n\r?\n([\s\S]*?)\r?\n--/) ?? [])[1] ?? '';
        const into = u.pathname.match(/\/scripts\/(\d+)\/versions$/);
        const id = into ? into[1] : String(gf.next++);
        gf.scripts.set(id, code);
        return route.fulfill({ status: 302, headers: { location: `https://greasyfork.org/en/scripts/${id}-wide-wiki` } });
      }
      if (/\/users\/sign_in/.test(u.pathname)) return route.fulfill(html(greasyForkSignInPage()));
      if (/\/script_versions\/new$/.test(u.pathname)) return route.fulfill(html(greasyForkFormPage()));
      const v = u.pathname.match(/\/scripts\/(\d+)\/versions\/new$/);
      if (v) return route.fulfill(html(greasyForkFormPage({ scriptId: v[1] })));
      const s = u.pathname.match(/\/scripts\/(\d+)-([\w-]+)$/);
      if (s) return route.fulfill(html(greasyForkScriptPage({ id: s[1], slug: s[2], name: 'Wide Wiki' })));
      return route.fulfill(html('<title>Not found</title>', 404));
    });
    await b.ctx.route('https://smoke.example/**', (route) => route.fulfill(html('<!doctype html><title>A page</title><h1>A page to point the panel at</h1>')));
    await b.ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://gist.github.com' });

    const wiki = mod(WIDE_WIKI);
    const leaky = mod(LEAKY);
    const quiet = mod(QUIET);
    const panel = await openPanel(b.ctx, b.extId, { storage: { mods: [wiki, leaky, quiet] } });
    await openSite(b.ctx, 'https://smoke.example/');
    await panel.locator('.tab-group [data-view="mods"]').click();
    const card = (name) => panel.locator('.card', { has: panel.locator('h4', { hasText: name }) }).first();
    const stored = async (id) => (await panel.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? [])).find((m) => m.id === id);
    /** Open a mod's Export menu and pick an item, returning the tab the pick opened (if any). */
    async function pick(name, item, { opens = true } = {}) {
      await card(name).locator('[data-testid="mod-export"]').click();
      const it = panel.locator(`[data-testid="mod-export-menu"] [data-testid="${item}"]`);
      await it.waitFor({ timeout: 5000 });
      if (!opens) {
        await it.click();
        return null;
      }
      const [tab] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 15_000 }), it.click()]);
      // Held blank for a moment (holdExtensionTabs), then sent to the site.
      await tab.waitForURL((u) => u.href !== 'about:blank', { timeout: 15_000 });
      await tab.waitForLoadState('domcontentloaded');
      return tab;
    }
    const itemLabel = async (name, item) => {
      await card(name).locator('[data-testid="mod-export"]').click();
      const text = (await panel.locator(`[data-testid="mod-export-menu"] [data-testid="${item}"]`).textContent())?.trim();
      await panel.keyboard.press('Escape');
      return text;
    };

    // --- The menu is one control with four ways out.
    await card('Wide Wiki').locator('[data-testid="mod-export"]').click();
    const items = (await panel.locator('[data-testid="mod-export-menu"] [role="menuitem"]').allTextContents()).map((t) => t.trim());
    if (items.join(' | ') !== 'Download .user.js | Copy to clipboard | Share as Gist | Publish on Greasy Fork') fail(`Export menu reads ${JSON.stringify(items)}`);
    if (capture) {
      await panel.waitForTimeout(250);
      await panel.screenshot({ path: path.join(outDir, '14-export-menu.png') });
      log('14-export-menu.png');
    }
    await panel.keyboard.press('Escape');

    // --- 1. Share as Gist: filled through the editor's API, the hint points at Create.
    let tab = await pick('Wide Wiki', 'export-gist');
    const newText = await hintText(tab, 'usermods-hint-filled');
    if (!newText?.includes('Press “Create secret gist” to save it')) fail(`new-gist hint read ${JSON.stringify(newText)}`);
    const filled = await tab.evaluate(() => ({
      name: document.querySelector('.js-gist-filename').value,
      description: document.querySelector('#gist_description').value,
      code: document.querySelector('.CodeMirror').CodeMirror.getValue(),
    }));
    if (filled.name !== 'wide-wiki.user.js') fail(`file name was ${JSON.stringify(filled.name)}`);
    if (filled.description !== 'Lets Wikipedia articles use the whole window.') fail(`description was ${JSON.stringify(filled.description)}`);
    if (filled.code !== WIDE_WIKI) fail('the editor does not hold the mod’s source, exactly');
    // Nothing was pressed for the user: no POST has happened.
    if (gist.posts !== 0) fail('something submitted the gist form');
    // The ring is around the button the hint names.
    const ring = await tab.evaluate(() => {
      const host = document.querySelector('[data-usermods="hint"]');
      const r = host.shadowRoot.querySelector('.ring').getBoundingClientRect();
      const btn = Array.from(document.querySelectorAll('button')).find((x) => x.textContent.trim() === 'Create secret gist').getBoundingClientRect();
      return Math.abs(r.left + 2 - btn.left) < 3 && Math.abs(r.top + 2 - btn.top) < 3;
    });
    if (!ring) fail('the highlight ring is not on “Create secret gist”');
    if (capture) {
      await tab.setViewportSize({ width: 1100, height: 720 });
      await tab.waitForTimeout(400);
      await tab.screenshot({ path: path.join(outDir, '15-share-hint.png') });
      log('15-share-hint.png');
    }

    // The user presses the site's own button; the save lands on the gist's page and is remembered.
    await tab.locator('button', { hasText: 'Create secret gist' }).click();
    const savedText = await hintText(tab, 'usermods-hint-saved');
    if (!savedText?.includes('usermods remembered this gist')) fail(`saved hint read ${JSON.stringify(savedText)}`);
    const [gistId] = [...gist.gists.keys()];
    const raw = `https://gist.githubusercontent.com/${USER}/${gistId}/raw/wide-wiki.user.js`;
    const after = await until('the gist to be recorded on the mod', async () => {
      const m = await stored(wiki.id);
      return m?.share?.gist ? m : null;
    });
    if (after.share.gist.rawUrl !== raw) fail(`rawUrl was ${after.share.gist.rawUrl}`);
    if (after.share.gist.url !== `https://gist.github.com/${USER}/${gistId}`) fail(`gist url was ${after.share.gist.url}`);
    if (after.downloadUrl !== raw) fail(`downloadUrl was ${after.downloadUrl}`);
    if (!after.source.includes(`// @updateURL    ${raw}`) || !after.source.includes(`// @downloadURL  ${raw}`)) fail(`header lacks @updateURL/@downloadURL:\n${after.source}`);
    if (!/@version\s+1\.0\.0\b/.test(after.source)) fail('the first share bumped the version');
    await panel.locator('[data-testid="share-install-link"]', { hasText: raw }).waitFor({ timeout: 10_000 });
    await card('Wide Wiki').locator('[data-testid="mod-install-link"]', { hasText: raw }).waitFor({ timeout: 10_000 });
    // The user's own gist is theirs: no install banner on it.
    await tab.waitForTimeout(800);
    if (await tab.locator('[data-usermods="banner"]').count()) fail('the install banner nags on the user’s own gist');
    await tab.close();

    // --- 2. Update gist: the edit page, the bumped version, filled without the editor API.
    if ((await itemLabel('Wide Wiki', 'export-gist')) !== 'Update gist') fail('the menu does not offer “Update gist” after a share');
    gist.variant = 'noapi';
    tab = await pick('Wide Wiki', 'export-gist');
    if (!tab.url().endsWith(`/${USER}/${gistId}/edit`)) fail(`Update gist opened ${tab.url()}`);
    const updText = await hintText(tab, 'usermods-hint-filled');
    if (!updText?.includes('Version 1.0.1 is filled in')) fail(`update hint read ${JSON.stringify(updText)}`);
    const code2 = await tab.evaluate(() => document.querySelector('textarea.js-blob-contents').value);
    if (!/@version\s+1\.0\.1\b/.test(code2) || /@version\s+1\.0\.0\b/.test(code2)) fail(`the edit page holds:\n${code2}`);
    if (!code2.includes(`@downloadURL  ${raw}`)) fail('the new version does not carry its @downloadURL');
    const name2 = await tab.evaluate(() => document.querySelector('.js-gist-filename').value);
    if (name2 !== 'wide-wiki.user.js') fail(`the update renamed the file to ${name2}`);
    if ((await stored(wiki.id)).version !== '1.0.1') fail('the mod was not saved at 1.0.1');
    await tab.locator('button', { hasText: 'Update secret gist' }).click();
    await hintText(tab, 'usermods-hint-saved');
    if (!/@version\s+1\.0\.1\b/.test(gist.gists.get(gistId).files[0].content)) fail('the gist did not receive 1.0.1');
    await tab.close();

    // --- 3. A page whose markup matches nothing: the clipboard fallback.
    gist.variant = 'unknown';
    tab = await pick('Wide Wiki', 'export-gist');
    const fbText = await hintText(tab, 'usermods-hint-fallback');
    if (fbText !== 'Paste your script here (it is on your clipboard) and name the file wide-wiki.user.js.') fail(`fallback hint read ${JSON.stringify(fbText)}`);
    // Reading the clipboard back needs the tab focused; writing it did not (the fallback wrote it).
    await tab.bringToFront();
    const clip = await tab.evaluate(() => navigator.clipboard.readText());
    if (!/@version\s+1\.0\.2\b/.test(clip) || !clip.includes('@name         Wide Wiki')) fail(`the clipboard holds: ${JSON.stringify(clip.slice(0, 300))}`);
    await tab.close();
    gist.variant = 'default';

    // --- 4. The leak check holds a script with a key in it until "Share anyway".
    const pagesBefore = b.ctx.pages().length;
    await pick('Summarise with my key', 'export-gist', { opens: false });
    const prompt = panel.locator('[data-testid="share-prompt"]');
    await prompt.waitFor({ timeout: 5000 });
    const leakText = await panel.locator('[data-testid="share-leaks"]').textContent();
    if (!leakText?.includes('Line 8: an OpenAI-style API key')) fail(`leak list read ${JSON.stringify(leakText)}`);
    if (leakText.includes(FAKE_KEY)) fail('the leak warning prints the key whole');
    await panel.waitForTimeout(700);
    if (b.ctx.pages().length !== pagesBefore) fail('a tab opened before the user answered the leak check');
    await panel.locator('[data-testid="share-cancel"]').click();
    await prompt.waitFor({ state: 'detached', timeout: 5000 });
    await panel.waitForTimeout(500);
    if (b.ctx.pages().length !== pagesBefore) fail('Cancel opened a tab anyway');
    await pick('Summarise with my key', 'export-gist', { opens: false });
    const [leakTab] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 15_000 }), panel.locator('[data-testid="share-anyway"]').click()]);
    await hintText(leakTab, 'usermods-hint-filled');
    await leakTab.close();

    // --- 5. The gist was deleted: its edit page is a 404, and a new gist is offered.
    gist.gists.delete(gistId);
    tab = await pick('Wide Wiki', 'export-gist');
    const goneText = await hintText(tab, 'usermods-hint-missing');
    if (!goneText?.includes('no longer exists')) fail(`deleted-gist hint read ${JSON.stringify(goneText)}`);
    await panel.locator('[data-testid="share-gist-missing"]').waitFor({ timeout: 10_000 });
    await tab.locator('[data-usermods="hint"] [data-testid="usermods-hint-new-gist"]').click();
    await tab.waitForURL('https://gist.github.com/', { timeout: 15_000 });
    await hintText(tab, 'usermods-hint-filled');
    const cleared = await stored(wiki.id);
    if (cleared.share?.gist || /@downloadURL/.test(cleared.source)) fail('the dead gist is still remembered after “Share as a new gist”');
    await tab.close();

    // --- 6. Signed out: the hint says so, and the fill happens once the editor appears.
    gist.signedIn = false;
    tab = await pick('Quiet HN', 'export-gist');
    const inText = await hintText(tab, 'usermods-hint-signin');
    if (inText !== 'Sign in to GitHub, then usermods will fill this in.') fail(`sign-in hint read ${JSON.stringify(inText)}`);
    gist.signedIn = true;
    await tab.goto('https://gist.github.com/');
    await hintText(tab, 'usermods-hint-filled');
    const quietCode = await tab.evaluate(() => document.querySelector('.CodeMirror').CodeMirror.getValue());
    if (quietCode !== QUIET) fail('after sign-in the editor does not hold the script');
    await tab.close();

    // --- 7. Greasy Fork: the header check asks about @license; the form is filled and pointed at.
    await pick('Wide Wiki', 'export-greasyfork', { opens: false });
    await prompt.waitFor({ timeout: 5000 });
    if (!(await panel.locator('[data-testid="share-add-license"]').isVisible())) fail('the Greasy Fork check does not ask about @license');
    await panel.locator('[data-testid="share-add-license"] input').check();
    const [gfTab] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 15_000 }), panel.locator('[data-testid="share-anyway"]').click()]);
    const gfText = await hintText(gfTab, 'usermods-hint-filled');
    if (!gfText?.includes('Press “Post script”')) fail(`Greasy Fork hint read ${JSON.stringify(gfText)}`);
    const gfCode = await gfTab.evaluate(() => document.querySelector('#script_version_code').value);
    if (!gfCode.includes('// @license      MIT') && !/@license\s+MIT/.test(gfCode)) fail('@license MIT was not added');
    await gfTab.locator('input[type="submit"][name="commit"]').click();
    await hintText(gfTab, 'usermods-hint-saved');
    const posted = await until('the Greasy Fork post to be recorded', async () => (await stored(wiki.id))?.share?.greasyFork ?? null);
    if (posted.id !== '424242' || posted.url !== 'https://greasyfork.org/en/scripts/424242-wide-wiki') fail(`recorded ${JSON.stringify(posted)}`);
    await gfTab.close();
    if ((await itemLabel('Wide Wiki', 'export-greasyfork')) !== 'Post new version on Greasy Fork') fail('the menu does not offer a new version after a post');
    const v2 = await pick('Wide Wiki', 'export-greasyfork');
    if (!v2.url().endsWith('/en/scripts/424242/versions/new')) fail(`new version opened ${v2.url()}`);
    const v2Text = await hintText(v2, 'usermods-hint-filled');
    if (!v2Text?.includes('Press “Post new version”')) fail(`new-version hint read ${JSON.stringify(v2Text)}`);
    const v2Code = await v2.evaluate(() => document.querySelector('#script_version_code').value);
    const v2Version = (v2Code.match(/@version\s+(\S+)/) ?? [])[1];
    if (!v2Version || v2Version === '1.0.2' || v2Version === '1.0.0') fail(`the new version carries @version ${v2Version}`);
    await v2.close();

    // --- 8. The dashboard's rows carry the same Export menu, with the labels the mod has earned.
    const dash = await b.ctx.newPage();
    await dash.setViewportSize({ width: 1280, height: 820 });
    await dash.goto(`chrome-extension://${b.extId}/dashboard.html#mods`);
    const row = dash.locator('[data-testid="mod-row"]', { hasText: 'Wide Wiki' });
    await row.locator('[data-testid="mod-export"]').click();
    const dashItems = (await dash.locator('[data-testid="mod-export-menu"] [role="menuitem"]').allTextContents()).map((t) => t.trim());
    if (dashItems.join(' | ') !== 'Download .user.js | Copy to clipboard | Share as Gist | Post new version on Greasy Fork') fail(`dashboard Export menu reads ${JSON.stringify(dashItems)}`);
    if (capture) {
      await dash.waitForTimeout(250);
      await dash.screenshot({ path: path.join(outDir, '14-export-menu-dashboard.png') });
      log('14-export-menu-dashboard.png');
    }
    await dash.close();
    log('share flow OK');
  } finally {
    await b.close();
  }
}

/**
 * The banner flow: the install banner on a gist with a .user.js file, a plain-text raw script and a
 * GitHub blob page; Install opens the install page with that script's URL; Installed and Update
 * states; a dismissal that survives a reload; nothing in an iframe; the .user.js redirect for gist
 * raw URLs.
 */
export async function bannerFlow({ launch, log, outDir, capture = false }) {
  const b = await launch('light', { args: OFFLINE_HOSTS });
  const fail = (m) => {
    throw new Error(`banner: ${m}`);
  };
  const fixture = (name) => fs.readFileSync(path.join(process.cwd(), 'test/fixtures/pages', name), 'utf8');
  try {
    const GIST = 'https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02';
    const RAW_LATEST = 'https://gist.githubusercontent.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02/raw/pinterest-dark.user.js';
    const PASTE = 'https://paste.example.com/raw/pinterest';
    const BLOB = 'https://github.com/jesus2099/konami-command/blob/master/acacia_BONUS.user.js';
    const GF = 'https://greasyfork.org/en/scripts/19993-ru-adlist-js-fixes';
    for (const host of ['https://gist.github.com/**', 'https://github.com/**', 'https://greasyfork.org/**', 'https://update.greasyfork.org/**', 'https://raw.githubusercontent.com/**']) {
      await b.ctx.route(host, (route) => route.fulfill(html('<title>Not found</title>', 404)));
    }
    await b.ctx.route(`${GIST}`, (r) => r.fulfill(html(fixture('gist-userscript.html'))));
    await b.ctx.route(BLOB, (r) => r.fulfill(html(fixture('github-blob.html'))));
    await b.ctx.route(GF, (r) => r.fulfill(html(fixture('greasyfork-script.html'))));
    await b.ctx.route('https://paste.example.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: fixture('raw-userscript.txt') }));
    await b.ctx.route('https://frame.example.com/**', (r) => r.fulfill(html(`<!doctype html><title>Frame host</title><h1>A page with a script in a frame</h1><iframe src="${PASTE}" width="600" height="300"></iframe>`)));
    // Anything the install page's preview asks for is answered here too, so nothing reaches GitHub.
    await b.ctx.route('https://gist.githubusercontent.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: fixture('raw-userscript.txt') }));

    // An extension page to seed storage from.
    const ext = await b.ctx.newPage();
    await ext.goto(`chrome-extension://${b.extId}/sidepanel.html`);
    const setMods = (mods) => ext.evaluate(async (m) => chrome.storage.local.set({ mods: m, consent: { version: 1, acceptedAt: Date.now() } }), mods);
    const pinterest = (version, extra = {}) =>
      mod(
        `// ==UserScript==\n// @name         Pinterest Dark (Polished)\n// @namespace    https://gist.github.com/KillaMeep/c5e8506a7c32169843d0373f710dfb02\n// @version      ${version}\n// @match        https://*.pinterest.com/*\n// ==/UserScript==\n`,
        extra,
      );
    await setMods([]);

    const page = await b.ctx.newPage();
    await page.setViewportSize({ width: 1100, height: 700 });
    const banner = page.locator('[data-usermods="banner"] [data-testid="usermods-banner"]');
    const bannerText = () => page.locator('[data-usermods="banner"] [data-testid="usermods-banner-text"]').first().textContent({ timeout: 10_000 });

    // (a) A gist with a .user.js file.
    await page.goto(GIST);
    if ((await bannerText()) !== 'usermods can install “Pinterest Dark (Polished)”.') fail(`gist banner read ${JSON.stringify(await bannerText())}`);
    // Install opens the install page on the always-latest raw URL. Nothing is installed by it.
    const [install] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 10_000 }), page.locator('[data-usermods="banner"] [data-testid="usermods-banner-action"]').click()]);
    await install.waitForLoadState('domcontentloaded');
    if (install.url() !== `chrome-extension://${b.extId}/install.html#${RAW_LATEST}`) fail(`Install opened ${install.url()}`);
    await install.close();
    const modsNow = await ext.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? []);
    if (modsNow.length) fail('opening the install page installed something');

    // (c) A plain-text raw script, not caught by the .user.js redirect.
    await page.goto(PASTE);
    if ((await bannerText()) !== 'usermods can install “Pinterest Dark (Polished)”.') fail('no banner on the raw text page');
    if (capture) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(outDir, '16-install-banner.png') });
      log('16-install-banner.png');
    }

    // (b) A GitHub blob page.
    await page.goto(BLOB);
    if ((await bannerText()) !== 'usermods can install “acacia. BONUS”.') fail(`blob banner read ${JSON.stringify(await bannerText())}`);

    // Installed, and an update available.
    await setMods([pinterest('0.1')]);
    await page.goto(GIST);
    await page.locator('[data-usermods="banner"] [data-testid="usermods-banner-status"]', { hasText: 'Installed ✓' }).waitFor({ timeout: 10_000 });
    if (await page.locator('[data-usermods="banner"] [data-testid="usermods-banner-action"]').count()) fail('an installed script still offers Install');
    await setMods([pinterest('0.0.9')]);
    await page.goto(GIST);
    const upd = page.locator('[data-usermods="banner"] [data-testid="usermods-banner-action"]');
    await upd.waitFor({ timeout: 10_000 });
    if ((await upd.textContent())?.trim() !== 'Update to v0.1') fail(`update action read ${await upd.textContent()}`);

    // Greasy Fork: its own Install button covers "not installed"; the banner speaks for an update.
    await setMods([]);
    await page.goto(GF);
    await page.waitForTimeout(1200);
    if (await banner.count()) fail('a banner on a Greasy Fork page with nothing to add');
    await setMods([mod('// ==UserScript==\n// @name RU AdList JS Fixes\n// @namespace ruadlist_js_fixes\n// @version 20200101\n// @match *://*/*\n// ==/UserScript==\n')]);
    await page.goto(GF);
    await page.locator('[data-usermods="banner"] [data-testid="usermods-banner-action"]', { hasText: 'Update to v20240625.1' }).waitFor({ timeout: 10_000 });

    // Dismiss is remembered for the page.
    await setMods([]);
    await page.goto(PASTE);
    await banner.waitFor({ timeout: 10_000 });
    await page.locator('[data-usermods="banner"] [data-testid="usermods-banner-close"]').click();
    if (await banner.count()) fail('close did not remove the banner');
    const dismissed = await until('the dismissal to be stored', async () => {
      const d = await ext.evaluate(async () => (await chrome.storage.local.get('banner:dismissed'))['banner:dismissed'] ?? []);
      return d.includes(PASTE) ? d : null;
    }, 5000).catch(() => null);
    if (!dismissed) fail('the dismissal was not stored');
    await page.reload();
    await page.waitForTimeout(1200);
    if (await banner.count()) fail('a dismissed banner came back after a reload');
    await ext.evaluate(async () => chrome.storage.local.remove('banner:dismissed'));

    // Never in a frame: the same raw script, framed, gets nothing (the top page is not a script).
    await page.goto('https://frame.example.com/');
    await page.waitForTimeout(1500);
    const framed = page.frames().find((f) => f.url() === PASTE);
    if (!framed) fail('the frame did not load');
    if (await framed.locator('[data-usermods="banner"]').count()) fail('a banner inside an iframe');
    if (await page.locator('[data-usermods="banner"]').count()) fail('a banner on the frame host page');

    // The .user.js redirect catches a gist raw URL before any banner is needed.
    await page.goto(RAW_LATEST).catch(() => {});
    await page.waitForURL(/install\.html#/, { timeout: 10_000 });
    if (!page.url().endsWith(`install.html#${RAW_LATEST}`)) fail(`the gist raw URL landed on ${page.url()}`);
    log('banner flow OK');
  } finally {
    await b.close();
  }
}
