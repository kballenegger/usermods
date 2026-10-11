#!/usr/bin/env node
// Builds the App Store screenshots for the iOS and iPadOS submission into
// docs/store/appstore/screenshots/, at the exact pixel sizes App Store Connect requires.
//
//   node scripts/appstore-screenshots.mjs            everything: simulator captures, popup renders,
//                                                    composites, size check
//   node scripts/appstore-screenshots.mjs --sim      only the simulator captures (into .output/appstore)
//   node scripts/appstore-screenshots.mjs --render   only the popup renders (into .output/appstore)
//   node scripts/appstore-screenshots.mjs --compose  only the composites, from what .output/appstore holds
//
//   iphone-01..05.png  1320x2868  iPhone 6.9" (iPhone 17 Pro Max simulator)
//   ipad-01..04.png    2064x2752  iPad 13"    (iPad Pro 13-inch (M5) simulator)
//
// Prerequisites: `node scripts/safari-xcode.mjs simulator --device 'iPhone 17 Pro Max'` (which
// builds the full Safari web build, stages it, builds the app and installs it), the same .app
// installed on the iPad Pro 13-inch simulator, both simulators booted, Safari opened once on each
// (so Safari has registered the extension), and `npx playwright install webkit`.
//
// ---------------------------------------------------------------------------
// What is real, and what is a composite
// ---------------------------------------------------------------------------
//
// Two kinds of picture, kept apart on purpose, and the README beside the PNGs says which is which:
//
//   1. SIMULATOR CAPTURES (`xcrun simctl io <udid> screenshot`): the installed extension, enabled in
//      Mobile Safari, doing its job. A saved mod running on a Wikipedia article, and the install page
//      the extension opens for a .user.js link. These are pixel-for-pixel what the simulator drew.
//      Two things had to be done without a finger, because simctl cannot tap:
//        - the extension is enabled and granted <all_urls> by writing Safari's Extensions.plist,
//          which is what Settings > Apps > Safari > Extensions > usermods > Allow writes
//          (docs/safari.md, "Enabling on iOS was written, not tapped");
//        - the saved mod is written into the extension's storage.local (Safari's LocalStorage.db for
//          the extension), because saving one through the UI needs a tap on INSTALL.
//      The simulator has no network on the machine this was made on, so the article is a snapshot
//      of the live mobile page (styles inlined, images local, scripts removed), served from
//      127.0.0.1. That is why Safari's address bar reads 127.0.0.1 in those captures.
//
//   2. POPUP RENDERS: the extension's own popup.html from the built Safari bundle, served by
//      scripts/safari-preview.mjs with stubbed extension APIs (?fixture=appstore), rendered by
//      Playwright's WebKit at the device's exact point size and pixel ratio. The extension's real
//      popup cannot be opened from automation (it needs a tap on the toolbar), so the chat, Mods
//      and Settings views come from here. Same document, same CSS, same React build; the data is the
//      fixture's and nothing runs. On iPhone the popup is full screen, so the render fills the frame
//      with the popup's own background in the status-bar and home-indicator insets the popup pads
//      for on a device. On iPad the popup is a 440x720 popover, so it is laid over a real simulator
//      capture of the article, below the toolbar's usermods button, with a drawn rounded corner and
//      shadow standing in for the system popover (the arrow is not drawn).
//
// No model is called by any of this. The chat transcript is fixture text.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'store', 'appstore', 'screenshots');
const WORK = path.join(ROOT, '.output', 'appstore');
const SITE = path.join(WORK, 'site');
const RAW = path.join(WORK, 'raw');
const SITE_PORT = 8800;
const BARE_PORT = 8801; // the same article, on an origin no mod matches: the page before the mod
const PREVIEW_PORT = 4180;
const BUNDLE = 'com.kballenegger.usermods';
const ARTICLE = 'https://en.m.wikipedia.org/wiki/Bulletin_board_system';

const PHONE = { name: 'iPhone 17 Pro Max', w: 440, h: 956, dpr: 3, top: 62, bottom: 34 };
const PAD = { name: 'iPad Pro 13-inch (M5)', w: 1032, h: 1376, dpr: 2 };
const SIZES = { iphone: [1320, 2868], ipad: [2064, 2752] };

const argv = process.argv.slice(2);
const only = ['--sim', '--render', '--compose'].filter((f) => argv.includes(f));
const want = (f) => only.length === 0 || only.includes(f);

function fail(msg) {
  console.error(`appstore-screenshots: ${msg}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const simctl = (...args) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The fixture mod: what the install page previews and what the page capture shows running. */
const MOD_SOURCE = `// ==UserScript==
// @name         Wikipedia: reading mode
// @namespace    https://github.com/kballenegger/usermods
// @version      1.2.0
// @description  Warm paper background, a serif body at a comfortable size, and no edit clutter on Wikipedia articles.
// @match        *://*.wikipedia.org/wiki/*
// @run-at       document-end
// @grant        GM_addStyle
// ==/UserScript==

GM_addStyle(\`
  html, body, .mw-page-container, #content, .page-header-content { background: #f4ecd8 !important; }
  .header-container, .header-container.header-chrome { background: #efe3c6 !important; box-shadow: none !important; }
  #content, .mw-parser-output { color: #2b2418 !important; }
  .mw-parser-output p, .mw-parser-output li {
    font-family: 'New York', 'Iowan Old Style', Georgia, serif !important;
    font-size: 19px !important;
    line-height: 1.65 !important;
  }
  #firstHeading, .mw-parser-output h2 {
    font-family: 'New York', 'Iowan Old Style', Georgia, serif !important;
    color: #1d170e !important;
  }
  .mw-parser-output a { color: #8a3b12 !important; }
  .mw-editsection, .page-actions-menu, .hatnote, .ambox, .mw-reflink-text { display: none !important; }
  .mw-parser-output figure img { border-radius: 10px; }
\`);
`;

/** A second script for the install page, so it previews a fresh install rather than a reinstall. */
const INSTALL_SOURCE = `// ==UserScript==
// @name         YouTube: no Shorts
// @namespace    https://github.com/kballenegger/usermods
// @version      2.0.1
// @description  Removes the Shorts shelf, the Shorts tab and Shorts in search results.
// @match        *://www.youtube.com/*
// @match        *://m.youtube.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// ==/UserScript==

GM_addStyle(\`
  ytd-reel-shelf-renderer, ytd-rich-shelf-renderer[is-shorts],
  ytm-reel-shelf-renderer, ytm-pivot-bar-item-renderer:has(.pivot-shorts),
  a[title="Shorts"], ytd-guide-entry-renderer:has(a[title="Shorts"]) { display: none !important; }
\`);
`;

// ---------------------------------------------------------------------------
// Simulator setup
// ---------------------------------------------------------------------------

function findSimulator(name) {
  const json = JSON.parse(simctl('list', 'devices', '-j'));
  const all = Object.entries(json.devices)
    .filter(([rt]) => rt.includes('iOS'))
    .flatMap(([rt, ds]) => ds.map((d) => ({ ...d, rt })))
    .filter((d) => d.name === name && d.isAvailable);
  const booted = all.find((d) => d.state === 'Booted');
  if (!booted) fail(`boot a "${name}" simulator first (${all.map((d) => d.udid).join(', ') || 'none installed'})`);
  try {
    simctl('get_app_container', booted.udid, BUNDLE, 'app');
  } catch {
    fail(`${BUNDLE} is not installed on ${name}; run node scripts/safari-xcode.mjs simulator --device '${name}'`);
  }
  return booted.udid;
}

/** Python for the plist and the SQLite store: both ship with macOS, and plistlib keeps dates as dates. */
function python(code, ...args) {
  const r = spawnSync('python3', ['-I', '-c', code, ...args], { encoding: 'utf8' });
  if (r.status !== 0) fail(`python step failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}

/** Settings > Apps > Safari > Extensions > usermods: on, and Allow on every website. */
function enableExtension(udid) {
  const container = simctl('get_app_container', udid, 'com.apple.mobilesafari', 'data');
  const plist = path.join(container, 'Library/Safari/WebExtensions/Extensions.plist');
  if (!fs.existsSync(plist)) fail(`no ${plist}: open Safari once on ${udid} so it registers the extension`);
  return python(
    `import plistlib, sys, datetime
p = sys.argv[1]
d = plistlib.load(open(p, 'rb'))
far = datetime.datetime(4001, 1, 1)
hit = [k for k in d if k.startswith('${BUNDLE}.extension')]
assert hit, 'usermods is not in Extensions.plist'
for k in hit:
    v = d[k]
    v['Enabled'] = True
    v['GrantedPermissions'] = {x: far for x in v.get('Permissions', [])}
    v['GrantedPermissionOrigins'] = {'<all_urls>': far}
plistlib.dump(d, open(p, 'wb'))
print(hit[0])`,
    plist,
  );
}

/**
 * Put one saved mod into the extension's storage.local.
 *
 * Safari keeps it in LocalStorage.db beside the extension's other state, one row per key, the value
 * as JSON. The row is exactly what lib/mods.ts saveMods() writes; the extra match pattern is the
 * fixture origin, because a match pattern with no port does not match 127.0.0.1:8800 in the Safari
 * engine's matcher. Safari must not be running while this writes.
 */
function seedStorage(udid) {
  const container = simctl('get_app_container', udid, 'com.apple.mobilesafari', 'data');
  const base = path.join(container, 'Library/WebKit/com.apple.mobilesafari/WebExtensions/Default');
  const dir = fs.existsSync(base) && fs.readdirSync(base).find((d) => d.startsWith(`${BUNDLE}.extension`));
  if (!dir) fail(`no extension store under ${base}: load any page in Safari on ${udid} first`);
  const meta = (key) => MOD_SOURCE.split('\n').filter((l) => l.startsWith(`// ${key}`)).map((l) => l.slice(3 + key.length).trim());
  const now = Date.now();
  const mod = {
    id: 'mod-wikipedia-reading', name: meta('@name')[0], description: meta('@description')[0], version: meta('@version')[0],
    matches: [...meta('@match'), `http://127.0.0.1:${SITE_PORT}/wiki/*`], excludeMatches: [], includeGlobs: [], excludeGlobs: [],
    runAt: 'document_end', world: 'USER_SCRIPT', allFrames: false, grants: meta('@grant'), connect: [], requires: [], resources: [],
    source: MOD_SOURCE, enabled: true, createdAt: now - 864e5, updatedAt: now - 36e5,
  };
  const rows = { mods: [mod], consent: { version: 1, acceptedAt: now - 864e5 } };
  return python(
    `import sqlite3, sys, json
con = sqlite3.connect(sys.argv[1])
con.execute('CREATE TABLE IF NOT EXISTS extension_storage (key TEXT PRIMARY KEY NOT NULL, value BLOB NOT NULL)')
if con.execute('PRAGMA user_version').fetchone()[0] == 0:
    con.execute('PRAGMA user_version = 2')
for k, v in json.loads(sys.argv[2]).items():
    con.execute('INSERT OR REPLACE INTO extension_storage (key, value) VALUES (?, ?)', (k, json.dumps(v)))
con.commit()
print(sorted(r[0] for r in con.execute('SELECT key FROM extension_storage')))`,
    path.join(base, dir, 'LocalStorage.db'),
    JSON.stringify(rows),
  );
}

/** Start every capture from one tab: Safari restores the last session's tabs otherwise. */
function resetTabs(udid) {
  const device = simctl('get_app_container', udid, 'com.apple.mobilesafari', 'data').split('/Containers/')[0];
  for (const f of ['SafariTabs.db', 'SafariTabs.db-wal', 'SafariTabs.db-shm']) fs.rmSync(path.join(device, 'Library', 'Safari', f), { force: true });
}

// ---------------------------------------------------------------------------
// The article fixture
// ---------------------------------------------------------------------------

/** curl, so the machine's proxy settings apply; Node's fetch ignores them. */
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 usermods-screenshot-fixture';
const curl = (url, file) => execFileSync('curl', ['-sS', '-L', '--fail', '-A', UA, ...(file ? ['-o', file] : []), url], { maxBuffer: 64 << 20, encoding: file ? undefined : 'utf8' });

function snapshotArticle() {
  const page = path.join(SITE, 'wiki', 'Bulletin_board_system', 'index.html');
  if (fs.existsSync(page)) return;
  fs.mkdirSync(path.join(SITE, 'img'), { recursive: true });
  const origin = new URL(ARTICLE).origin;
  let html = curl(ARTICLE);
  html = html.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>${curl(new URL(href.replace(/&amp;/g, '&'), origin).href)}</style>`);
  html = html.replace(/<link[^>]*rel="(?:preload|modulepreload|preconnect|dns-prefetch)"[^>]*>/g, '');
  let n = 0;
  let budget = 12;
  html = html.replace(/<img\b[^>]*>/g, (tag) => {
    const m = tag.match(/src="([^"]+)"/);
    if (!m || !/wikimedia\.org\//.test(m[1]) || budget-- <= 0) return tag.replace(/\ssrcset="[^"]*"/, '');
    const abs = m[1].startsWith('//') ? `https:${m[1]}` : m[1];
    const name = `/img/${n++}${path.extname(new URL(abs).pathname) || '.png'}`;
    try {
      curl(abs, path.join(SITE, name));
    } catch {
      return tag;
    }
    return tag.replace(/src="[^"]+"/, `src="${name}"`).replace(/\ssrcset="[^"]*"/, '');
  });
  for (const p of new Set(html.match(/\/static\/[A-Za-z0-9_\-./]+\.(?:svg|png|ico|gif)/g) ?? [])) {
    const dest = path.join(SITE, p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try { curl(new URL(p, origin).href, dest); } catch { /* a missing footer icon does not matter */ }
  }
  html = html.replace(/https:\/\/en\.wikipedia\.org\/static\//g, '/static/').replace('client-nojs', 'client-js');
  fs.mkdirSync(path.dirname(page), { recursive: true });
  fs.writeFileSync(page, html);
  console.log(`[fixture] ${path.relative(ROOT, page)}`);
}

function writeScripts() {
  fs.mkdirSync(path.join(SITE, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(SITE, 'scripts', 'wikipedia-reading-mode.user.js'), MOD_SOURCE);
  fs.writeFileSync(path.join(SITE, 'scripts', 'youtube-no-shorts.user.js'), INSTALL_SOURCE);
}

async function serveSite(port) {
  const http = await import('node:http');
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.ico': 'image/x-icon' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let file = path.join(SITE, path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, ''));
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!file.startsWith(SITE) || !fs.existsSync(file)) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}

/** One page in a fresh single-tab Safari, so no tab strip and no leftover tabs in the picture. */
async function capture(udid, url, out, wait = 9000) {
  try { simctl('terminate', udid, 'com.apple.mobilesafari'); } catch { /* not running */ }
  await sleep(1000);
  resetTabs(udid);
  simctl('openurl', udid, url);
  await sleep(wait);
  simctl('io', udid, 'screenshot', out);
  console.log(`[sim] ${path.relative(ROOT, out)}`);
}

async function simulatorCaptures() {
  fs.mkdirSync(RAW, { recursive: true });
  snapshotArticle();
  writeScripts();
  const servers = [await serveSite(SITE_PORT), await serveSite(BARE_PORT)];
  const article = `http://127.0.0.1:${SITE_PORT}/wiki/Bulletin_board_system`;
  try {
    for (const [key, name] of [['iphone', PHONE.name], ['ipad', PAD.name]]) {
      const udid = findSimulator(name);
      simctl('status_bar', udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active', '--wifiBars', '3',
        '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'discharging', '--batteryLevel', '100');
      try { simctl('terminate', udid, 'com.apple.mobilesafari'); } catch { /* not running */ }
      console.log(`[sim] ${name}: enabled ${enableExtension(udid)}`);
      console.log(`[sim] ${name}: storage.local keys ${seedStorage(udid)}`);
      // The install page, for a script that is not installed yet.
      await capture(udid, `http://127.0.0.1:${SITE_PORT}/scripts/youtube-no-shorts.user.js`, path.join(RAW, `${key}-install.png`));
      // The article with the saved mod running on it.
      await capture(udid, article, path.join(RAW, `${key}-running.png`));
      // The same article on an origin the mod does not match: the page before the mod, which the
      // iPad chat composite sits on.
      if (key === 'ipad') await capture(udid, `http://127.0.0.1:${BARE_PORT}/wiki/Bulletin_board_system`, path.join(RAW, `${key}-before.png`));
    }
  } finally {
    for (const s of servers) s.close();
  }
}

// ---------------------------------------------------------------------------
// Popup renders
// ---------------------------------------------------------------------------

async function popupRenders() {
  if (!fs.existsSync(path.join(ROOT, '.output', 'safari-mv3', 'popup.html'))) fail('no Safari build: run npm run build:safari');
  fs.mkdirSync(RAW, { recursive: true });
  const preview = spawn(process.execPath, [path.join(ROOT, 'scripts', 'safari-preview.mjs'), '--port', String(PREVIEW_PORT)], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    preview.stdout.on('data', (b) => { if (String(b).includes('[preview]')) resolve(); });
    preview.on('exit', (c) => reject(new Error(`safari-preview exited ${c}`)));
  });
  const { webkit, devices } = await import('playwright');
  const browser = await webkit.launch();
  try {
    const phone = { w: PHONE.w, h: PHONE.h - PHONE.top - PHONE.bottom };
    const cases = [
      { key: 'iphone', view: 'chat', ctx: { ...devices['iPhone 14'], viewport: { width: phone.w, height: phone.h }, screen: { width: PHONE.w, height: PHONE.h }, deviceScaleFactor: PHONE.dpr } },
      { key: 'iphone', view: 'mods', ctx: { ...devices['iPhone 14'], viewport: { width: phone.w, height: phone.h }, screen: { width: PHONE.w, height: PHONE.h }, deviceScaleFactor: PHONE.dpr } },
      { key: 'iphone', view: 'settings', ctx: { ...devices['iPhone 14'], viewport: { width: phone.w, height: phone.h }, screen: { width: PHONE.w, height: PHONE.h }, deviceScaleFactor: PHONE.dpr } },
      // The iPad popover: popup-size.css gives the document 440x720 on a 1032x1376 screen.
      { key: 'ipad', view: 'chat', ctx: { ...devices['iPad Pro 11'], viewport: { width: 440, height: 720 }, screen: { width: PAD.w, height: PAD.h }, deviceScaleFactor: PAD.dpr } },
      { key: 'ipad', view: 'mods', ctx: { ...devices['iPad Pro 11'], viewport: { width: 440, height: 720 }, screen: { width: PAD.w, height: PAD.h }, deviceScaleFactor: PAD.dpr } },
    ];
    for (const c of cases) {
      const context = await browser.newContext(c.ctx);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${PREVIEW_PORT}/popup.html?fixture=appstore&theme=dark&view=${c.view}`, { waitUntil: 'load' });
      if (c.view === 'chat') {
        await page.locator('[data-testid="proposal-card"]').last().waitFor({ state: 'visible', timeout: 15000 });
        // Open the card's code, as a person checking what they are about to save would, then show
        // the newest turn with the card whole.
        // The iPad popover is shorter, and there the request matters more than the code.
        if (c.key === 'iphone') await page.locator('[data-testid="proposal-card"] summary').last().click();
        await page.evaluate(() => {
          const card = [...document.querySelectorAll('[data-testid="proposal-card"]')].pop();
          card?.scrollIntoView({ block: 'end' });
        });
      } else {
        await page.waitForFunction((v) => !document.querySelector('.sheet') && document.querySelector('.app')?.textContent?.includes(v === 'mods' ? 'Wikipedia: reading mode' : 'SuperGrok'), c.view, { timeout: 15000 });
      }
      // ?view= gets there by pressing Menu and then the row, which leaves focus (and its ring) on
      // the Menu button. A thumb would not leave a focus ring behind, so drop it.
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
      await page.waitForTimeout(700);
      const layout = await page.evaluate(() => document.querySelector('.app')?.getAttribute('data-layout'));
      if (layout !== 'compact') fail(`${c.key}/${c.view}: expected the compact layout, got ${layout}`);
      const out = path.join(RAW, `${c.key}-popup-${c.view}.png`);
      await page.screenshot({ path: out });
      console.log(`[render] ${path.relative(ROOT, out)}`);
      await context.close();
    }
  } finally {
    await browser.close();
    preview.kill();
  }
}

// ---------------------------------------------------------------------------
// Composites
// ---------------------------------------------------------------------------

const dataUrl = (file) => `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`;

async function compose() {
  const need = ['iphone-running', 'iphone-install', 'iphone-popup-chat', 'iphone-popup-mods', 'iphone-popup-settings', 'ipad-running', 'ipad-install', 'ipad-before', 'ipad-popup-chat', 'ipad-popup-mods'];
  for (const n of need) if (!fs.existsSync(path.join(RAW, `${n}.png`))) fail(`missing ${n}.png in ${path.relative(ROOT, RAW)}: run with --sim and --render first`);
  fs.mkdirSync(OUT, { recursive: true });
  const raw = (n) => path.join(RAW, `${n}.png`);

  // Straight copies: the simulator's own pixels.
  fs.copyFileSync(raw('iphone-running'), path.join(OUT, 'iphone-02.png'));
  fs.copyFileSync(raw('iphone-install'), path.join(OUT, 'iphone-04.png'));
  fs.copyFileSync(raw('ipad-running'), path.join(OUT, 'ipad-02.png'));
  fs.copyFileSync(raw('ipad-install'), path.join(OUT, 'ipad-04.png'));

  const { webkit } = await import('playwright');
  const browser = await webkit.launch();
  try {
    const shoot = async (w, h, html, out) => {
      const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
      await page.setContent(html, { waitUntil: 'load' });
      if (html.includes('<canvas')) await page.waitForFunction(() => document.title === 'done');
      await page.screenshot({ path: out });
      await page.close();
      console.log(`[compose] ${path.relative(ROOT, out)}`);
    };
    // iPhone: the popup fills the screen, as it does on a device; the inset strips above and below
    // carry the popup's own top-bar and composer colours, sampled from the render's edge rows.
    const [W, H] = SIZES.iphone;
    for (const [n, view] of [['01', 'chat'], ['03', 'mods'], ['05', 'settings']]) {
      const html = `<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#000">
<canvas id="c" width="${W}" height="${H}"></canvas>
<script>
const img = new Image();
img.onload = () => {
  const c = document.getElementById('c').getContext('2d');
  const top = ${PHONE.top * PHONE.dpr}, bottom = ${PHONE.bottom * PHONE.dpr};
  c.drawImage(img, 0, top);
  const edge = (y) => { const d = c.getImageData(4, y, 1, 1).data; return 'rgb(' + d[0] + ',' + d[1] + ',' + d[2] + ')'; };
  c.fillStyle = edge(top + 1); c.fillRect(0, 0, ${W}, top);
  c.fillStyle = edge(top + img.height - 2); c.fillRect(0, top + img.height, ${W}, bottom);
  document.title = 'done';
};
img.src = ${JSON.stringify(dataUrl(raw(`iphone-popup-${view}`)))};
</script></body></html>`;
      await shoot(W, H, html, path.join(OUT, `iphone-${n}.png`));
    }
    // iPad: the popover over the real page, hanging from the toolbar's usermods button.
    const [PW, PH] = SIZES.ipad;
    const pop = { w: 440 * PAD.dpr, h: 720 * PAD.dpr, left: PW - 440 * PAD.dpr - 300, top: 196 };
    for (const [n, base, view] of [['01', 'ipad-before', 'chat'], ['03', 'ipad-running', 'mods']]) {
      const html = `<!doctype html><html><body style="margin:0;width:${PW}px;height:${PH}px;overflow:hidden;position:relative">
<img src="${dataUrl(raw(base))}" style="position:absolute;left:0;top:0;width:${PW}px;height:${PH}px">
<div style="position:absolute;left:${pop.left}px;top:${pop.top}px;width:${pop.w}px;height:${pop.h}px;border-radius:26px;overflow:hidden;box-shadow:0 24px 80px rgba(0,0,0,.35),0 0 0 1px rgba(0,0,0,.12)">
<img src="${dataUrl(raw(`ipad-popup-${view}`))}" style="display:block;width:${pop.w}px;height:${pop.h}px"></div>
</body></html>`;
      await shoot(PW, PH, html, path.join(OUT, `ipad-${n}.png`));
    }
  } finally {
    await browser.close();
  }
}

function checkSizes() {
  let bad = 0;
  for (const f of fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).sort()) {
    const r = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path.join(OUT, f)], { encoding: 'utf8' });
    const w = Number(r.match(/pixelWidth: (\d+)/)[1]);
    const h = Number(r.match(/pixelHeight: (\d+)/)[1]);
    const [ew, eh] = SIZES[f.startsWith('ipad') ? 'ipad' : 'iphone'];
    const ok = w === ew && h === eh;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} ${f} ${w}x${h}`);
  }
  if (bad) fail(`${bad} screenshot(s) at the wrong size`);
}

if (want('--sim')) await simulatorCaptures();
if (want('--render')) await popupRenders();
if (want('--compose')) {
  await compose();
  checkSizes();
}
