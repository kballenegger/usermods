#!/usr/bin/env node
// Serve the built Safari popup as an ordinary web page, so it can be looked at on a real iPhone.
//
//   node scripts/safari-preview.mjs                 serve on http://127.0.0.1:4173/popup.html
//   node scripts/safari-preview.mjs --shots out/    serve, then screenshot each view on the
//                                                   booted iOS simulator and exit
//   node scripts/safari-preview.mjs --webkit-shots out/
//                                                   serve, then screenshot both popup layouts in
//                                                   headless WebKit and exit
//   node scripts/safari-preview.mjs --providers     serve, then check in headless WebKit that the
//                                                   provider menu offers both subscriptions and that a
//                                                   pending sign-in survives a reload (stubbed, no vendor)
//   node scripts/safari-preview.mjs --popover-size  serve, then measure in headless WebKit what
//                                                   size the popup document hands a content-sized
//                                                   popover, at a window far too small to help
//   node scripts/safari-preview.mjs --probe         serve, open the popup in the default browser,
//                                                   print what that browser laid out, and exit
//                                                   (--probe simulator for the booted iPhone,
//                                                    --view mods to land on a different view)
//
// ---------------------------------------------------------------------------
// What this is for, and what it is not
// ---------------------------------------------------------------------------
//
// The popup is the whole of usermods on iPhone, and how it behaves under a thumb is not something
// a desktop window at 390px wide answers. Safe areas, the home indicator, momentum scrolling, how
// large the tap targets really are, what the on-screen keyboard covers: all of that is WebKit on
// iOS plus the system chrome around it, and nothing on a Mac reproduces it.
//
// Installing the extension and tapping its toolbar item cannot be automated (enabling a Safari
// extension is a Settings toggle a person has to flip), so this serves popup.html over HTTP
// instead and opens it in Mobile Safari on the simulator. Same document, same stylesheets, same
// React build, same engine, same device metrics.
//
// --webkit-shots is the same document in Playwright's WebKit, at the two sizes the popup has to
// handle: a Mac window and a phone. It exists because the layout decision is a media query, and a
// media query is the engine's answer, not React's. It is still WebKit in a headless harness rather
// than Safari with an extension loaded, so it proves the layout and nothing beyond it.
//
// --probe is for the machine where neither of those is available: it opens the page in the real
// browser and has the page report back what it laid out. No screenshot, no automation permissions,
// and the answer comes from the browser you actually have rather than from a harness. Same
// caveat, in bold: stubbed APIs, layout only.
//
// It is NOT a functional test and must never be reported as one. The extension APIs are stubbed
// below with fixed data, so what you are looking at is layout and interaction, not a live
// extension: no background worker, no storage, nothing executes on a page. Screenshots from here
// belong in the "rendered in Mobile Safari, stubbed APIs" row of the evidence table and nowhere
// else. See docs/safari.md.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, '.output', 'safari-mv3');
const VIEWS = ['chat', 'mods', 'settings'];

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const port = Number(flag('port', '4173'));
const shots = flag('shots', null);
const webkitShots = flag('webkit-shots', null);
const probe = argv.includes('--probe');
const popoverSize = argv.includes('--popover-size');
const providers = argv.includes('--providers');
// `--probe` on its own means this Mac's browser; `--probe simulator` means the booted iPhone.
const probeTarget = (() => {
  const value = flag('probe', 'browser');
  return !value || value.startsWith('--') ? 'browser' : value;
})();
const device = flag('device', 'booted');

function fail(message, hint) {
  console.error(`safari-preview: ${message}`);
  if (hint) console.error(`note: ${hint}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(DIST, 'popup.html'))) {
  fail(`no built popup at ${path.relative(ROOT, DIST)}/popup.html`, 'run `npm run build:safari` first.');
}

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

/**
 * What the stubbed extension reports. Invented, and obviously so: no real key, no real host that
 * would pull a screenshot into someone's actual browsing, nothing that could be mistaken for the
 * owner's data. The point is to fill every view enough that its layout is being judged with
 * content in it rather than empty.
 */
const TAB = { id: 7, windowId: 1, url: 'https://news.ycombinator.com/item?id=41203187', title: 'Show HN' };
const CHAT_ID = 'chat-preview-1';

const STORAGE = {
  // lib/consent.ts: the notice is acknowledged at a version, so the preview opens on the chat
  // rather than on the first-run notice. The notice has its own screenshot.
  consent: { version: 1, acceptedAt: Date.now() - 864e5 },
  'usermods.theme': 'dark',
  settings: { theme: 'dark' },
  connections: {
    v: 1,
    list: [
      { id: 'conn-1', kind: 'anthropic', label: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-preview-not-a-real-key' },
      { id: 'conn-2', kind: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '' },
      // A SuperGrok row, so the sign-in card is on screen in the screenshots and so --providers has
      // something to open. It carries no token and no key: `oauth.status` answers "not signed in",
      // which is the state worth looking at anyway. It exists in the Safari build because that
      // build has subscription sign-in — the thing this branch put back.
      { id: 'conn-3', kind: 'xai', label: 'SuperGrok subscription', baseUrl: '', apiKey: '' },
    ],
  },
  modelChoice: { connectionId: 'conn-1', model: 'claude-opus-5', label: 'Anthropic' },
  chats: [
    { id: CHAT_ID, host: 'news.ycombinator.com', title: 'Widen the comment column', createdAt: Date.now() - 864e5, updatedAt: Date.now() - 36e5, turns: 2, url: TAB.url },
    { id: 'chat-preview-2', host: 'news.ycombinator.com', title: 'Collapse dead comments', createdAt: Date.now() - 6048e5, updatedAt: Date.now() - 2592e5, turns: 5 },
  ],
  [`chat:${CHAT_ID}:items`]: [
    { kind: 'model', connectionId: 'conn-1', label: 'Anthropic', model: 'claude-opus-5' },
    { kind: 'user', id: 'u1', text: 'The comment column is too narrow to read on my phone. Widen it and give the replies more room.' },
    { kind: 'assistant', text: 'The comment table is fixed at 85% with a left indent per reply level. I can set the outer table to full width and shrink the indent on narrow screens, which keeps the thread shape without eating the text.' },
    { kind: 'note', text: 'Saved as a mod: Wider comments' },
  ],
};

const MODS = [
  {
    id: 'mod-1', name: 'Wider comments', description: 'Full-width comment column, smaller reply indent.',
    version: '1.0.0', matches: ['https://news.ycombinator.com/*'], excludeMatches: [], includeGlobs: [], excludeGlobs: [],
    runAt: 'document_end', world: 'USER_SCRIPT', allFrames: false, grants: ['GM_addStyle'], connect: [],
    requires: [], resources: [], source: '// ==UserScript==\n', enabled: true, createdAt: Date.now() - 864e5, updatedAt: Date.now() - 36e5,
  },
  {
    id: 'mod-2', name: 'Collapse dead comments', description: 'Hides greyed-out replies behind a count.',
    version: '0.2.0', matches: ['https://news.ycombinator.com/item*'], excludeMatches: [], includeGlobs: [], excludeGlobs: [],
    runAt: 'document_idle', world: 'USER_SCRIPT', allFrames: false, grants: [], connect: [],
    requires: [], resources: [], source: '// ==UserScript==\n', enabled: false, createdAt: Date.now() - 6048e5, updatedAt: Date.now() - 2592e5,
  },
];

const RPC = {
  'userScripts.status': { available: true, message: '' },
  'agent.attach': { running: {}, resumable: {} },
  'mods.list': MODS,
  'chats.list': STORAGE.chats,
  'chats.listAll': STORAGE.chats,
  'artifact.get': null,
  'models.list': { models: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], fallback: false },
  'oauth.status': { signedIn: false },
};

/**
 * A device-code sign-in, invented end to end.
 *
 * NOTHING here touches a vendor. `auth.x.ai` and `auth.openai.com` are never contacted, no real
 * device code is requested and no token is ever exchanged — the point of the check this feeds is
 * that the POPUP restores a pending sign-in after its document is reloaded, which is a question
 * about the UI and about `oauth.restore`, not about the vendors. The code below is obviously fake
 * and the URL points at example.invalid, which cannot resolve.
 *
 * The stub keeps it in the same page-lifetime `store` the storage stub uses, so a reload of the
 * document finds it exactly the way the real popup finds the record the background wrote.
 */
const PENDING_SIGNIN = {
  kind: 'xai',
  userCode: 'PREVIEW-FAKE',
  verificationUri: 'https://device.example.invalid/preview',
  expiresAt: Date.now() + 10 * 60 * 1000,
};

/**
 * The stub, as a classic script that runs before everything else on the page.
 *
 * It answers the handful of extension APIs the popup touches on the way to a first paint, and
 * refuses the rest loudly rather than returning undefined and leaving a blank view to be puzzled
 * over. Storage is a plain object: writes stick for the life of the page and go nowhere else.
 */
function stubSource() {
  return `(() => {
  const store = ${JSON.stringify(STORAGE)};
  const rpc = ${JSON.stringify(RPC)};
  const tab = ${JSON.stringify(TAB)};
  const fakeSignin = ${JSON.stringify(PENDING_SIGNIN)};
  const listeners = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });

  /*
   * The oauth RPCs, answered from a record in sessionStorage.
   *
   * sessionStorage rather than the page-lifetime \`store\`, because the whole question being asked
   * is what survives the DOCUMENT being thrown away — which is what happens on iOS when opening
   * the verification tab dismisses the popup. sessionStorage is per tab and outlives a reload,
   * which is as close as a plain web page gets to "the background still has the record".
   *
   * No vendor is contacted for any of this. ?signin=pending seeds a fake pending sign-in so the
   * restored state can be checked; without it every vendor reads as idle.
   */
  const PENDING_KEY = 'preview:pending-signin';
  const seed = new URLSearchParams(location.search).get('signin');
  if (seed === 'pending') {
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(fakeSignin)); } catch {}
  } else if (seed === 'none') {
    try { sessionStorage.removeItem(PENDING_KEY); } catch {}
  }
  const readPending = (kind) => {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const p = JSON.parse(raw);
      return p && p.kind === kind ? p : null;
    } catch { return null; }
  };
  const oauth = (req) => {
    const p = readPending(req.kind);
    switch (req.type) {
      case 'oauth.status': return { signedIn: false };
      case 'oauth.restore':
      case 'oauth.poll':
        return p
          ? { status: 'pending', userCode: p.userCode, verificationUri: p.verificationUri, expiresAt: p.expiresAt }
          : { status: 'idle' };
      case 'oauth.start': {
        const next = { ...fakeSignin, kind: req.kind };
        try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(next)); } catch {}
        return { status: 'pending', userCode: next.userCode, verificationUri: next.verificationUri, expiresAt: next.expiresAt };
      }
      case 'oauth.cancel':
      case 'oauth.signout':
        try { sessionStorage.removeItem(PENDING_KEY); } catch {}
        return { ok: true };
      default: return null;
    }
  };

  const read = (keys) => {
    if (keys == null) return { ...store };
    if (typeof keys === 'string') return keys in store ? { [keys]: store[keys] } : {};
    if (Array.isArray(keys)) return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]));
    return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in store ? store[k] : d]));
  };
  const area = () => ({
    get: async (keys) => read(keys),
    set: async (items) => { Object.assign(store, items); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; },
    clear: async () => { for (const k of Object.keys(store)) delete store[k]; },
  });

  const api = {
    runtime: {
      id: 'usermods-preview',
      getURL: (p) => '/' + String(p).replace(/^\\/+/, ''),
      sendMessage: async (req) => {
        const type = req && req.type;
        if (typeof type === 'string' && type.startsWith('oauth.')) {
          const answer = oauth(req);
          if (answer) return { ok: true, data: answer };
        }
        if (type in rpc) return { ok: true, data: rpc[type] };
        // Anything not in the fixture is a write, a run, or a network call. Saying so beats
        // pretending it worked: this preview has no background worker to do any of it.
        return { ok: false, error: 'preview: ' + type + ' needs the real background worker' };
      },
      connect: () => ({ name: 'agent', postMessage() {}, disconnect() {}, onMessage: listeners(), onDisconnect: listeners() }),
      onMessage: listeners(),
      lastError: undefined,
    },
    storage: { local: area(), session: area(), sync: area(), onChanged: listeners() },
    tabs: {
      query: async () => [tab],
      get: async () => tab,
      update: async () => tab,
      // Recorded rather than ignored: on iOS this is the call that dismisses the popup, so a check
      // wants to know it happened and with which URL. It deliberately does NOT navigate anywhere.
      create: async (props) => {
        (globalThis.__usermodsOpenedTabs ||= []).push(props && props.url);
        return tab;
      },
      sendMessage: async () => undefined,
      onActivated: listeners(),
      onUpdated: listeners(),
      onRemoved: listeners(),
    },
    windows: { update: async () => ({}) },
    scripting: { executeScript: async () => [] },
  };
  globalThis.chrome = api;
  globalThis.browser = api;

  // ?view=mods opens straight to that view, by pressing the same button a thumb would. Polls
  // because React has not mounted yet when this runs, and gives up rather than spinning forever.
  const wanted = new URLSearchParams(location.search).get('view');
  if (wanted && wanted !== 'chat') {
    let tries = 0;
    const tick = setInterval(() => {
      const el = document.querySelector('.popup-nav [data-view="' + wanted + '"]');
      if (el) { el.click(); clearInterval(tick); }
      else if (++tries > 100) { clearInterval(tick); console.error('preview: no ' + wanted + ' button'); }
    }, 50);
  }
})();`;
}

// ---------------------------------------------------------------------------
// The probe
// ---------------------------------------------------------------------------

/**
 * A few lines the page runs about itself and posts back.
 *
 * Which layout the popup draws is a media query plus a width, which is the browser's answer and not
 * something any harness can vouch for on its behalf. This asks the browser: what did you match,
 * what width did you give the document, which layout did the shell settle on, and is the navigation
 * above the body or below it. Then it clears the page, so a fixture tab is not left sitting there.
 */
function probeSource() {
  return `(() => {
  let sent = false;
  const send = (report) => {
    if (sent) return;
    sent = true;
    navigator.sendBeacon('/__report', JSON.stringify(report));
    setTimeout(() => { location.replace('about:blank'); }, 400);
  };
  const look = () => {
    const shell = document.querySelector(".app[data-surface='popup']");
    if (!shell) return false;
    const nav = shell.querySelector('.popup-nav');
    const body = shell.querySelector('.popup-body');
    send({
      userAgent: navigator.userAgent,
      width: window.innerWidth,
      height: window.innerHeight,
      coarsePointer: window.matchMedia('(pointer: coarse)').matches,
      layout: shell.getAttribute('data-layout'),
      // 4 is DOCUMENT_POSITION_FOLLOWING: the body comes after the nav, so the nav is on top.
      navAboveBody: !!nav && !!body && (nav.compareDocumentPosition(body) & 4) !== 0,
      navHeight: nav ? Math.round(nav.getBoundingClientRect().height) : null,
      // What a pointer has to hit. The phone raises these and a Mac does not.
      switchHeight: (() => {
        const el = document.querySelector("input[type='checkbox']");
        return el ? Math.round(el.getBoundingClientRect().height) : null;
      })(),
    });
    return true;
  };
  // A beat after the shell appears, not the instant it does: ?view= is a click the app makes on
  // itself once mounted, and measuring before it lands measures the chat view under another name.
  const settle = () => { setTimeout(look, 900); };
  const shellNow = document.querySelector(".app[data-surface='popup']");
  if (shellNow) {
    settle();
  } else {
    const observer = new MutationObserver(() => {
      if (!document.querySelector(".app[data-surface='popup']")) return;
      observer.disconnect();
      settle();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); if (!sent) send({ error: 'the popup never mounted' }); }, 15000);
  }
})();`;
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.map': 'application/json',
};

/** Resolved by the first report a probed page posts back. */
let reported = null;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__report' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(204);
      res.end();
      try {
        reported?.(JSON.parse(body));
      } catch {
        reported?.({ error: `unreadable report: ${body.slice(0, 200)}` });
      }
    });
    return;
  }

  if (url.pathname === '/__probe.js') {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(probeSource());
    return;
  }

  if (url.pathname === '/__preview.js') {
    res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' });
    res.end(stubSource());
    return;
  }

  const rel = url.pathname === '/' ? '/popup.html' : url.pathname;
  // Confine every read to the build directory: this serves over the network, if only to a phone
  // on the same desk, and a path that escapes with .. would serve the whole disk.
  const file = path.join(DIST, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`not in ${path.relative(ROOT, DIST)}: ${rel}\n`);
    return;
  }

  if (file.endsWith('popup.html')) {
    // The stub has to be the first script on the page: theme-boot.js reads storage before the
    // first paint, and main.tsx calls chrome the moment it mounts.
    let html = fs.readFileSync(file, 'utf8').replace('<head>', '<head><script src="/__preview.js"></script>');
    // The probe goes at the end, after the app's own scripts, because it is watching for what they
    // render. It is opt-in per request so an ordinary preview is untouched by it.
    if (url.searchParams.get('probe') === '1') html = html.replace('</body>', `<script src="/__probe.js"></script></body>`);
    res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' });
    res.end(html);
    return;
  }

  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

// ---------------------------------------------------------------------------

/** One simctl call, with its output attached to any failure rather than swallowed. */
function simctl(args) {
  const developerDir = process.env.DEVELOPER_DIR;
  const r = spawnSync('xcrun', ['simctl', ...args], {
    encoding: 'utf8',
    env: developerDir ? { ...process.env, DEVELOPER_DIR: developerDir } : process.env,
  });
  if (r.status !== 0) fail(`simctl ${args[0]} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return (r.stdout ?? '').trim();
}

async function screenshotViews(dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const view of VIEWS) {
    simctl(['openurl', device, `http://127.0.0.1:${port}/popup.html?view=${view}`]);
    // Mobile Safari has to load the page, React has to mount, and the ?view= click has to land.
    await new Promise((r) => setTimeout(r, 4000));
    const out = path.join(dir, `popup-${view}.png`);
    simctl(['io', device, 'screenshot', out]);
    console.log(`[preview] ${path.relative(ROOT, out)}`);
  }
}

/**
 * The same popup in headless WebKit, at a Mac window's size and at a phone's.
 *
 * Which layout the popup draws comes from `(pointer: coarse)` and the width, so the check worth
 * making is the engine's: load the document, read back the `data-layout` the shell settled on, and
 * fail if it is not the one that size is supposed to get. The screenshot is what a person looks at
 * afterwards; the assertion is what makes this run mean something unattended.
 */
async function webkitCapture(dir) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    fail('playwright is not installed', 'npm install, then `npx playwright install webkit`.');
  }
  fs.mkdirSync(dir, { recursive: true });

  const sizes = [
    // A Mac popup. Safari caps the popover at 800x600 and this is the size mobile.css asks for.
    { name: 'mac', layout: 'roomy', context: { viewport: { width: 420, height: 560 }, deviceScaleFactor: 2 } },
    // A phone, through Playwright's own descriptor, so the touch and pointer flags are its problem.
    { name: 'phone', layout: 'compact', context: playwright.devices['iPhone 14'] },
  ];

  const browser = await playwright.webkit.launch();
  const failures = [];
  try {
    for (const size of sizes) {
      const context = await browser.newContext(size.context);
      for (const view of VIEWS) {
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${port}/popup.html?view=${view}`, { waitUntil: 'load' });
        const shell = page.locator(".app[data-surface='popup']");
        await shell.waitFor({ state: 'visible', timeout: 15000 });
        const got = await shell.getAttribute('data-layout');
        if (got !== size.layout) failures.push(`${size.name}/${view}: data-layout is ${got}, expected ${size.layout}`);
        const out = path.join(dir, `popup-${size.name}-${view}.png`);
        await page.screenshot({ path: out });
        console.log(`[preview] ${path.relative(ROOT, out)}  data-layout=${got}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) fail(`the popup drew the wrong layout:\n  ${failures.join('\n  ')}`);
}

/**
 * Does the built Safari popup actually offer the subscription providers, and does a pending
 * sign-in come back after the document is thrown away?
 *
 * ---------------------------------------------------------------------------
 * What this is for
 * ---------------------------------------------------------------------------
 *
 * Two regressions, both of which shipped and neither of which any unit test would have caught,
 * because both are about what the BUILT bundle renders:
 *
 *   1. The Safari build had `SUBSCRIPTIONS_OFF` set, so `presetsFor()` returned no subscription
 *      presets and the "Add provider" row simply did not list ChatGPT or SuperGrok. The owner's
 *      report was exactly this: "i don't see the subscriptions on safari provider menu (grok
 *      supergrok for example)". The flag is compile-time, so the only honest check is to load the
 *      built file and look at the buttons.
 *   2. On iPhone the popup is a sheet over the page, and opening the verification tab dismisses
 *      it. The sign-in card used to mount with `{status:'idle'}` and draw a fresh "Sign in"
 *      button while a live code sat on the vendor's page. The fix is `oauth.restore`, and what
 *      proves it is reloading the document mid-flow and finding the same code.
 *
 * Both layouts are checked, because the compact one is where the owner is actually doing this and
 * the two have different CSS and different target sizes.
 *
 * ---------------------------------------------------------------------------
 * What it does NOT prove
 * ---------------------------------------------------------------------------
 *
 * Nothing here signs in to anything. The extension APIs are stubbed (see stubSource), the device
 * code is the literal string PREVIEW-FAKE, and the verification URL points at example.invalid.
 * auth.x.ai and auth.openai.com are never contacted, and no token is ever issued, exchanged or
 * stored. That a REAL sign-in completes needs the owner's own account and is a manual step; see
 * docs/safari.md. This proves the build offers the providers and that the UI resumes — the two
 * things that were broken — and nothing about the vendors.
 */
async function checkProviders() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    fail('playwright is not installed', 'npm install, then `npx playwright install webkit`.');
  }

  const layouts = [
    { name: 'roomy', context: { viewport: { width: 420, height: 560 }, deviceScaleFactor: 2 } },
    { name: 'compact', context: playwright.devices['iPhone 14'] },
  ];
  // The two presets by the labels lib/connections.ts gives them. These strings are what the user
  // reads on the buttons, so they are what is asserted.
  const WANTED = ['ChatGPT subscription', 'SuperGrok subscription'];

  const browser = await playwright.webkit.launch();
  const failures = [];
  try {
    for (const layout of layouts) {
      const context = await browser.newContext(layout.context);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/popup.html?view=settings&signin=none`, { waitUntil: 'load' });

      const shell = page.locator(".app[data-surface='popup']");
      await shell.waitFor({ state: 'visible', timeout: 15000 });
      const got = await shell.getAttribute('data-layout');
      if (got !== layout.name) failures.push(`${layout.name}: data-layout is ${got}`);

      await page.locator('[data-testid="providers"]').waitFor({ state: 'visible', timeout: 15000 });
      const presets = await page.locator('[data-testid="add-provider"]').evaluateAll((els) =>
        els.map((e) => (e.textContent ?? '').trim()),
      );
      for (const want of WANTED) {
        if (!presets.includes(want)) {
          failures.push(`${layout.name}: "Add provider" does not offer ${want} (offers: ${presets.join(', ') || 'nothing'})`);
        }
      }

      // Apple asks for 44px. The subscription buttons are the ones being added here, so they are
      // the ones measured, and only where a thumb is what presses them.
      if (layout.name === 'compact') {
        for (const want of WANTED) {
          const box = await page.locator(`[data-testid="add-provider"][data-preset="${want}"]`).boundingBox().catch(() => null);
          if (!box) failures.push(`compact: ${want} has no box to measure`);
          else if (box.height < 44) failures.push(`compact: ${want} is ${Math.round(box.height)}px tall, under the 44px minimum`);
        }
      }

      // --- the pending sign-in survives the document being thrown away ---
      await page.goto(`http://127.0.0.1:${port}/popup.html?view=settings&signin=pending`, { waitUntil: 'load' });
      await page.locator('[data-testid="providers"]').waitFor({ state: 'visible', timeout: 15000 });

      // Open the SuperGrok card. The fixture carries one, and its presence is itself a check: a
      // build with subscriptions off renders it as "Not available in this build" with no sign-in
      // control at all, which is what the Safari build used to do.
      const card = page.locator('[data-testid="provider-card"][data-kind="xai"]');
      if ((await card.count()) === 0) {
        failures.push(`${layout.name}: the SuperGrok connection is missing from the providers list entirely`);
        await page.close();
        await context.close();
        continue;
      }
      const status = await card.getAttribute('data-status');
      if (status === 'unavailable') {
        failures.push(`${layout.name}: SuperGrok reads as "${await card.locator('[data-testid="provider-status"]').textContent()}" — this build has subscriptions off`);
      }
      await card.locator('[data-testid="provider-toggle"]').click();

      // Not `waitFor` — an absent card is a RESULT here, not a harness problem, and the whole
      // point is to report it as the sentence a reader can act on rather than as a Playwright
      // timeout stack. A build with subscriptions off renders no sign-in card at all, which is
      // exactly the state the Safari build was in when the owner reported it missing.
      const pendingCard = page.locator('[data-testid="subscription-login"][data-kind="xai"]');
      await pendingCard.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      if ((await pendingCard.count()) === 0) {
        failures.push(
          `${layout.name}: the SuperGrok card has no sign-in control at all — this build was made with ` +
            'subscriptions off (USERMODS_STORE=1), or SUBSCRIPTIONS_OFF still includes SAFARI_BUILD',
        );
        await page.close();
        await context.close();
        continue;
      }

      const code = page.locator('[data-testid="user-code"]');
      await code.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      const shownCode = await code.inputValue().catch(() => null);
      if (shownCode !== PENDING_SIGNIN.userCode) {
        failures.push(
          `${layout.name}: a reopened popup showed ${shownCode === null ? 'no pending code at all' : `"${shownCode}"`}, ` +
            `expected the persisted "${PENDING_SIGNIN.userCode}" — the sign-in did not resume`,
        );
      }
      // And the way back to the vendor page has to be there, not just the code.
      if ((await page.locator('[data-testid="open-verification"]').count()) === 0) {
        failures.push(`${layout.name}: the restored sign-in offers no way to reopen the verification page`);
      }
      if ((await page.locator('[data-testid="cancel-signin"]').count()) === 0) {
        failures.push(`${layout.name}: the restored sign-in offers no way to cancel`);
      }

      console.log(`[preview] ${layout.name}: presets ${presets.length}, restored code ${shownCode ?? '(none)'}`);
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) fail(`the Safari popup's providers are wrong:\n  ${failures.join('\n  ')}`);
  console.log('[preview] both subscription presets are offered in both layouts, and a pending sign-in is restored after a reload.');
  console.log('[preview] stubbed APIs: no vendor was contacted and no token was issued.');
}

/**
 * What size does this document hand a popover that is sized FROM it?
 *
 * This is the check for the bug that shipped on this branch: on macOS the toolbar popover opened
 * as a sliver roughly 470px by 90px, showing the top edge of the header and an empty grey strip.
 * Safari sizes a popover from its document's content, so at the first layout pass the window has
 * no useful width to give the page. `popupLayout` gated the roomy shell on `width >= 360`, so it
 * answered 'compact', whose CSS is `height: 100dvh` with no width — a percentage of a window that
 * was itself waiting for the content. Nothing gave the document a size, the width never reached
 * 360, and the layout never flipped. A deadlock that renders, which is the kind nothing but eyes
 * catch.
 *
 * So the measurement is the document's own box, in a window deliberately far smaller than the
 * popup, with a fine pointer. `getBoundingClientRect()` on <html>, NOT `scrollWidth`: scrollWidth
 * is max(content, viewport), so in any browser window wider than the document it reports the
 * window and would pass whatever the page did.
 *
 * WHAT THIS PROVES: the built popup document, in the engine Safari ships, lays itself out at
 * 420x560 with a fine pointer whatever the window says, and at the window's own size with a
 * coarse one. A popover measured from this content would therefore be the right size.
 *
 * WHAT IT DOES NOT PROVE: that Safari's popover does the measuring the way this assumes. Nothing
 * here is a popover, an extension, or Safari. Installing the extension and clicking its toolbar
 * item cannot be automated, so the real popover stays a manual check. This narrows the failure to
 * "Safari read the document differently than WebKit laid it out", which the pre-mount stylesheet
 * is written to survive either way.
 */
async function measurePopoverSize() {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    fail('playwright is not installed', 'npm install, then `npx playwright install webkit`.');
  }

  // Each case is a window, a pointer, and what the document should make of them.
  const cases = [
    {
      label: 'fine pointer, 100x50 window (nothing useful to measure)',
      context: { viewport: { width: 100, height: 50 }, deviceScaleFactor: 1 },
      expect: { width: 420, height: 560, layout: 'roomy' },
    },
    {
      label: 'fine pointer, 470x90 window (the sliver the bug produced)',
      context: { viewport: { width: 470, height: 90 }, deviceScaleFactor: 1 },
      expect: { width: 420, height: 560, layout: 'roomy' },
    },
    {
      // iOS must be untouched: a phone sheet fills its window and is never pinned to a Mac size.
      label: 'coarse pointer, iPhone 14 (the sheet)',
      context: playwright.devices['iPhone 14'],
      expect: { layout: 'compact', notPinned: true },
    },
  ];

  const browser = await playwright.webkit.launch();
  const failures = [];
  try {
    for (const c of cases) {
      const context = await browser.newContext(c.context);
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/popup.html`, { waitUntil: 'load' });

      // Before the app mounts. This is the layout a popover would be measured from, and the frame
      // the bug lived in.
      const early = await page.evaluate(() => {
        const r = document.documentElement.getBoundingClientRect();
        return { fine: matchMedia('(pointer: fine)').matches, width: Math.round(r.width), height: Math.round(r.height) };
      });
      await page.locator(".app[data-surface='popup']").waitFor({ state: 'visible', timeout: 15000 });
      const late = await page.evaluate(() => {
        const r = document.documentElement.getBoundingClientRect();
        return {
          layout: document.querySelector('.app').getAttribute('data-layout'),
          width: Math.round(r.width),
          height: Math.round(r.height),
        };
      });

      console.log(`[preview] ${c.label}`);
      console.log(`[preview]   (pointer: fine) ${early.fine}`);
      console.log(`[preview]   before mount    <html> ${early.width}x${early.height}`);
      console.log(`[preview]   after mount     <html> ${late.width}x${late.height}  data-layout=${late.layout}`);

      if (late.layout !== c.expect.layout) {
        failures.push(`${c.label}: data-layout is ${late.layout}, expected ${c.expect.layout}`);
      }
      if (c.expect.width) {
        // Both measurements, because a size that only appears after React mounts is a size the
        // popover was never offered.
        for (const [when, got] of [['before mount', early], ['after mount', late]]) {
          if (got.width !== c.expect.width || got.height !== c.expect.height) {
            failures.push(`${c.label}: ${when} the document is ${got.width}x${got.height}, expected ${c.expect.width}x${c.expect.height}`);
          }
        }
      }
      if (c.expect.notPinned && (late.width === 420 || late.height === 560)) {
        failures.push(`${c.label}: the sheet was pinned to the Mac window size (${late.width}x${late.height})`);
      }
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) fail(`the popup document would size a popover wrongly:\n  ${failures.join('\n  ')}`);
  console.log('[preview] every case as expected: a content-sized popover would get 420x560 on a Mac, and the sheet is untouched.');
}

/**
 * Open the popup in whatever browser this Mac opens web pages with, and wait for it to report.
 *
 * `open` is a shell command, not an Apple event, so this needs no automation permission and does
 * not care whether the browser is scriptable. What comes back is the browser's own account of the
 * layout it produced.
 */
async function probeBrowser() {
  // --view picks which of the three the probe lands on, because what is worth measuring differs:
  // the mods list has the on/off switch, which is the control the phone grows and the Mac must not.
  const view = flag('view', null);
  const url = `http://127.0.0.1:${port}/popup.html?probe=1${view ? `&view=${view}` : ''}`;
  const report = new Promise((resolve) => { reported = resolve; });
  if (probeTarget === 'simulator') {
    simctl(['openurl', device, url]);
  } else {
    const opened = spawnSync('/usr/bin/open', [url], { encoding: 'utf8' });
    if (opened.status !== 0) fail(`could not open ${url}: ${(opened.stderr || '').trim()}`);
  }
  console.log(`[preview] opened ${url} on ${probeTarget === 'simulator' ? device : 'this Mac'}`);

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 45000));
  const result = await Promise.race([report, timeout]);
  if (!result) fail('the browser never reported back', 'it may not have come to the front, or the page did not load.');
  if (result.error) fail(`the page reported: ${result.error}`);
  console.log(JSON.stringify(result, null, 2));
}

server.listen(port, '127.0.0.1', async () => {
  console.log(`[preview] http://127.0.0.1:${port}/popup.html  (views: ${VIEWS.map((v) => `?view=${v}`).join(' ')})`);
  if (!shots && !webkitShots && !probe && !popoverSize && !providers) {
    console.log('[preview] stubbed extension APIs: layout only, nothing runs. Ctrl-C to stop.');
    return;
  }
  try {
    if (shots) await screenshotViews(path.resolve(ROOT, shots));
    if (webkitShots) await webkitCapture(path.resolve(ROOT, webkitShots));
    if (popoverSize) await measurePopoverSize();
    if (providers) await checkProviders();
    if (probe) await probeBrowser();
  } finally {
    server.close();
  }
});
