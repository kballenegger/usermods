#!/usr/bin/env node
// Serve the built Safari popup as an ordinary web page, so it can be looked at on a real iPhone.
//
//   node scripts/safari-preview.mjs                 serve on http://127.0.0.1:4173/popup.html
//   node scripts/safari-preview.mjs --shots out/    serve, then screenshot each view on the
//                                                   booted iOS simulator and exit
//   node scripts/safari-preview.mjs --webkit-shots out/
//                                                   serve, then screenshot both popup layouts in
//                                                   headless WebKit and exit
//   node scripts/safari-preview.mjs --popover-size  serve, then measure in headless WebKit what
//                                                   size the popup document hands a content-sized
//                                                   popover, at a window far too small to help
//   node scripts/safari-preview.mjs --measure out/ [--label after]
//                                                   serve, then load a long seeded chat (tool rows,
//                                                   proposals, a draft, an editing link) at iPhone
//                                                   sizes, keyboard down and up, in both themes;
//                                                   print how much of the screen the transcript
//                                                   gets, save a PNG of each, and (unless the label
//                                                   is `before`) run the compact shell's
//                                                   accessibility assertions
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
const measure = flag('measure', null);
const measureLabel = flag('label', 'after');
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
      // Each carries a fresh model listing, as a connection that has been used does, so the model
      // picker has rows in it and does not go looking for a background worker to refresh them.
      { id: 'conn-1', kind: 'anthropic', label: 'Anthropic', baseUrl: '', apiKey: 'sk-ant-preview-not-a-real-key', models: { ids: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'], fetchedAt: Date.now() } },
      { id: 'conn-2', kind: 'openai-compatible', label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', apiKey: '', models: { ids: ['qwen3-coder-30b', 'gemma-3-12b-it'], fetchedAt: Date.now() } },
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

// ---------------------------------------------------------------------------
// The long fixture (?fixture=long)
// ---------------------------------------------------------------------------

/**
 * A chat that has been worked in, for judging how much of a phone the transcript gets.
 *
 * The short fixture above is four rows, which flatters any layout: nothing scrolls, so nothing
 * shows what the chrome around the transcript costs. This one is a realistic second session on an
 * installed mod: two turns, seven tool calls, two proposals, a draft at v2 that is linked to the
 * installed mod (so the "editing" state is on screen), which is the heaviest the area above the
 * composer ever gets.
 */
const LONG_CHAT_ID = 'chat-preview-long';
const V1_CODE = `GM_addStyle(\`
  table.comment-tree { width: 100% !important; }
  td.ind img { width: calc(var(--depth, 1) * 12px) !important; }
\`);`;
const V2_CODE = `GM_addStyle(\`
  table.comment-tree { width: 100% !important; }
  td.ind img { width: calc(var(--depth, 1) * 8px) !important; }
  .comment { font-size: 15px; line-height: 1.5; }
  @media (max-width: 480px) { td.ind img { width: calc(var(--depth, 1) * 5px) !important; } }
\`);`;
const LONG_ITEMS = [
  { kind: 'model', connectionId: 'conn-1', label: 'Anthropic', model: 'claude-opus-5' },
  { kind: 'user', id: 'u1', text: 'The comment column is too narrow to read on my phone. Widen it and give the replies more room.' },
  { kind: 'tool', id: 't1', name: 'find_elements', input: { selector: 'table.comment-tree' }, summary: '1 match: table.comment-tree (612 rows)' },
  { kind: 'tool', id: 't2', name: 'find_elements', input: { selector: 'td.ind img' }, summary: '611 matches, widths 0 to 360px' },
  { kind: 'tool', id: 't3', name: 'run_script', input: { description: 'widen the comment table', code: V1_CODE }, summary: 'ran without errors' },
  { kind: 'tool', id: 't4', name: 'wait_for', input: { selector: 'table.comment-tree', state: 'visible', timeoutMs: 2000 }, summary: 'matched after 40ms' },
  { kind: 'assistant', text: 'The comment table is fixed at 85% with a 40px indent per reply level. I set the outer table to full width and cut the indent to 12px a level, which keeps the thread shape without eating the text.' },
  { kind: 'proposal', version: 1, proposal: { name: 'Wider comments', description: 'Full-width comment column with a smaller reply indent.', matches: ['https://news.ycombinator.com/item*'], code: V1_CODE } },
  { kind: 'note', text: 'Saved as a mod: Wider comments' },
  { kind: 'user', id: 'u2', text: 'Better. Deep threads still get squeezed on the phone though, and the text is a bit small.' },
  { kind: 'tool', id: 't5', name: 'find_elements', input: { selector: '.comment' }, summary: '611 matches, font-size 12px' },
  { kind: 'tool', id: 't6', name: 'run_script', input: { description: 'tighter indent under 480px, 15px text', code: V2_CODE }, summary: 'ran without errors' },
  { kind: 'tool', id: 't7', name: 'screenshot', input: { description: 'check a deep thread' }, summary: 'captured 390x844' },
  { kind: 'assistant', text: 'Under 480px the indent is now 5px a level, so a reply ten levels deep keeps about 85% of the width. Comment text is 15px with a 1.5 line height. I checked a deep thread and nothing wraps badly.' },
  { kind: 'proposal', version: 2, proposal: { name: 'Wider comments', description: 'Full-width comment column, tighter indent on phones, larger text.', matches: ['https://news.ycombinator.com/item*'], code: V2_CODE } },
  { kind: 'assistant', text: 'That is v2 of the draft. Update the mod when you are happy with it, or tell me what to change.' },
];
const version = (n, code, description, ago) => ({
  n, code, name: 'Wider comments', description, matches: ['https://news.ycombinator.com/item*'], createdAt: Date.now() - ago, source: 'proposal',
});
const LONG_ARTIFACT = {
  id: 'artifact-long', chatId: LONG_CHAT_ID, name: 'Wider comments',
  description: 'Full-width comment column, tighter indent on phones, larger text.',
  matches: ['https://news.ycombinator.com/item*'],
  versions: [
    version(1, V1_CODE, 'Full-width comment column with a smaller reply indent.', 72e5),
    version(2, V2_CODE, 'Full-width comment column, tighter indent on phones, larger text.', 6e5),
  ],
  current: 2, linkedModId: 'mod-1', savedVersion: 1,
};
const LONG_CHATS = [
  { id: LONG_CHAT_ID, host: 'news.ycombinator.com', title: 'Widen the comment column', createdAt: Date.now() - 864e5, updatedAt: Date.now() - 6e5, turns: 2, url: TAB.url, editingModId: 'mod-1', editingModName: 'Wider comments' },
  ...STORAGE.chats.map((c) => ({ ...c, id: `${c.id}-b`, title: c.id === CHAT_ID ? 'Dim visited links' : c.title })),
  { id: 'chat-preview-4', host: 'news.ycombinator.com', title: 'Old experiment with the front page', createdAt: Date.now() - 9e9, updatedAt: Date.now() - 8e9, turns: 3, archivedAt: Date.now() - 7e9 },
];
const LONG = {
  storage: { chats: LONG_CHATS, [`chat:${LONG_CHAT_ID}:items`]: LONG_ITEMS },
  rpc: { 'chats.list': LONG_CHATS, 'chats.listAll': LONG_CHATS, 'artifact.get': LONG_ARTIFACT },
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
  const query = new URLSearchParams(location.search);
  // ?fixture=long swaps in the worked-in chat. ?theme=light|dark picks the palette, in storage
  // (what the app reads) and in the localStorage mirror (what theme-boot.js reads before paint).
  if (query.get('fixture') === 'long') {
    const long = ${JSON.stringify(LONG)};
    Object.assign(store, long.storage);
    Object.assign(rpc, long.rpc);
  }
  const theme = query.get('theme');
  if (theme === 'light' || theme === 'dark') {
    store['usermods.theme'] = theme;
    store.settings = { ...store.settings, theme };
    try { localStorage.setItem('usermods.theme', theme); } catch {}
  }
  // ?keyboard=<px> pretends the on-screen keyboard is up, the way iOS reports it: the window
  // keeps its height and the VISUAL viewport shrinks. Headless WebKit has no keyboard, so the
  // visualViewport the app listens to is replaced with one that says <px> is what is visible.
  const keyboard = Number(query.get('keyboard'));
  if (keyboard > 0) {
    const fake = new EventTarget();
    Object.assign(fake, { width: innerWidth, height: keyboard, offsetTop: 0, offsetLeft: 0, pageTop: 0, pageLeft: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, get: () => fake });
  }
  const listeners = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });

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
      create: async () => tab,
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
      // A Mac has the three views as tabs. A phone has them behind the menu in its top bar, so
      // there it is two presses: the menu, then the row.
      const el = document.querySelector('.popup-nav [data-view="' + wanted + '"]') || document.querySelector('.sheet [data-action="view-' + wanted + '"]');
      const menu = document.querySelector('[data-action="menu"]');
      if (el) { el.click(); clearInterval(tick); }
      else if (menu && !document.querySelector('.sheet')) menu.click();
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

  const ipad = playwright.devices['iPad Pro 11'];
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
    {
      // The largest iPhone screen there is (440pt). The iPad rule must not reach it either.
      label: 'coarse pointer, 440x956 phone screen (the largest iPhone)',
      context: { ...playwright.devices['iPhone 14'], viewport: { width: 440, height: 956 }, screen: { width: 440, height: 956 } },
      expect: { layout: 'compact', notPinned: true },
    },
    // The iPad. Safari shows the popup there as a popover sized from the document, as on a Mac,
    // and the owner's iPad Pro opened a tiny one. `screen` is what makes these an iPad to the
    // engine: device-width follows it, and without it Playwright reports the window as the screen.
    // The windows are the same two useless ones the Mac cases use, because a content-sized popover
    // has nothing better to offer the page at first layout.
    {
      label: 'iPad Pro 13 (screen 1032x1376), 100x50 window',
      context: { ...ipad, viewport: { width: 100, height: 50 }, screen: { width: 1032, height: 1376 } },
      expect: { width: 440, height: 720, layout: 'compact', device: 'tablet' },
    },
    {
      label: 'iPad Air 11 (screen 820x1180), 470x90 window (the sliver)',
      context: { ...ipad, viewport: { width: 470, height: 90 }, screen: { width: 820, height: 1180 } },
      expect: { width: 440, height: 660, layout: 'compact', device: 'tablet' },
    },
    {
      label: 'iPad mini (screen 744x1133), 100x50 window',
      context: { ...ipad, viewport: { width: 100, height: 50 }, screen: { width: 744, height: 1133 } },
      expect: { width: 440, height: 600, layout: 'compact', device: 'tablet' },
    },
    {
      // Landscape keeps the portrait device-width on iOS; Playwright models that by leaving
      // `screen` alone, which is what is done here. The size must not change with orientation.
      label: 'iPad Pro 13 in landscape, 100x50 window',
      context: { ...ipad, viewport: { width: 100, height: 50 }, screen: { width: 1032, height: 1376 }, isLandscape: true },
      expect: { width: 440, height: 720, layout: 'compact', device: 'tablet' },
    },
    {
      // Split View or Slide Over: the iPad presents the popup as a sheet the SYSTEM sizes, narrower
      // than the popover would be. A fixed 440px there would overflow sideways; the document
      // adopts the window instead, after mount.
      label: 'iPad in Slide Over, 320x900 system-sized sheet',
      context: { ...ipad, viewport: { width: 320, height: 900 }, screen: { width: 1032, height: 1376 } },
      expect: { lateWidth: 320, lateHeight: 900, layout: 'compact', device: 'tablet', noOverflow: true },
    },
    {
      // A popover Safari clamped shorter than asked (a short landscape screen): the document
      // shrinks to it, so the composer is not drawn below the popover's bottom edge.
      label: 'iPad mini, popover clamped to 440x560',
      context: { ...ipad, viewport: { width: 440, height: 560 }, screen: { width: 744, height: 1133 } },
      expect: { lateWidth: 440, lateHeight: 560, layout: 'compact', device: 'tablet', noOverflow: true },
    },
  ];

  const browser = await playwright.webkit.launch();
  const failures = [];
  try {
    for (const c of cases) {
      const context = await browser.newContext(c.context);

      // With no script at all. `load` fires after the module has run, so "before mount" below is
      // only as early as the harness can look at a live page; this is the document as its
      // stylesheets alone lay it out, which is the thing a popover is first measured from.
      const bare = await context.newPage();
      await bare.route('**/*.js', (route) => route.abort());
      await bare.goto(`http://127.0.0.1:${port}/popup.html`, { waitUntil: 'load' });
      const unscripted = await bare.evaluate(() => {
        const r = document.documentElement.getBoundingClientRect();
        return { mounted: !!document.querySelector('.app'), width: Math.round(r.width), height: Math.round(r.height) };
      });
      await bare.close();
      if (unscripted.mounted) failures.push(`${c.label}: the script-free load still mounted the app, so it measured nothing`);

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
          device: document.querySelector('.app').getAttribute('data-device'),
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          width: Math.round(r.width),
          height: Math.round(r.height),
          overflow: document.documentElement.scrollWidth > window.innerWidth || document.documentElement.scrollHeight > window.innerHeight,
        };
      });

      console.log(`[preview] ${c.label}`);
      console.log(`[preview]   (pointer: fine) ${early.fine}`);
      console.log(`[preview]   no script       <html> ${unscripted.width}x${unscripted.height}`);
      console.log(`[preview]   before mount    <html> ${early.width}x${early.height}`);
      console.log(`[preview]   after mount     <html> ${late.width}x${late.height}  data-layout=${late.layout}`);

      if (late.layout !== c.expect.layout) {
        failures.push(`${c.label}: data-layout is ${late.layout}, expected ${c.expect.layout}`);
      }
      if (c.expect.width) {
        // Both measurements, because a size that only appears after React mounts is a size the
        // popover was never offered.
        for (const [when, got] of [['with no script', unscripted], ['before mount', early], ['after mount', late]]) {
          if (got.width !== c.expect.width || got.height !== c.expect.height) {
            failures.push(`${c.label}: ${when} the document is ${got.width}x${got.height}, expected ${c.expect.width}x${c.expect.height}`);
          }
        }
      }
      // A phone's sheet is the system's size, so the document must be exactly its window: not the
      // Mac's size, not the iPad's, and not marked as a tablet.
      if (c.expect.notPinned && (late.device || late.width !== late.innerWidth || late.height !== late.innerHeight)) {
        failures.push(`${c.label}: the sheet was pinned to a popover size (${late.width}x${late.height} in a ${late.innerWidth}x${late.innerHeight} window, data-device=${late.device})`);
      }
      if ((c.expect.device ?? null) !== late.device) failures.push(`${c.label}: data-device is ${late.device}, expected ${c.expect.device ?? null}`);
      if (c.expect.lateWidth && (late.width !== c.expect.lateWidth || late.height !== c.expect.lateHeight)) {
        failures.push(`${c.label}: after mount the document is ${late.width}x${late.height}, expected it to adopt ${c.expect.lateWidth}x${c.expect.lateHeight}`);
      }
      if (c.expect.noOverflow && late.overflow) failures.push(`${c.label}: the document overflows the window it was given`);
      await page.close();
      await context.close();
    }
  } finally {
    await browser.close();
  }
  if (failures.length) fail(`the popup document would size a popover wrongly:\n  ${failures.join('\n  ')}`);
  console.log('[preview] every case as expected: a content-sized popover would get 420x560 on a Mac and 440x600/660/720 on an iPad, and the iPhone sheet is untouched.');
}

/**
 * How much of an iPhone the transcript gets.
 *
 * The owner's report from a real phone was that the chat could not be seen for everything stacked
 * above and below it. That is a number, so this measures it: the long fixture, at two iPhone sizes
 * with the keyboard down and one with it up, and for each the height of `.messages` that is
 * actually visible, in pixels and as a share of what the user can see.
 *
 * The keyboard-up case keeps the window at 390x844 and tells the page its visual viewport is 500px
 * tall (?keyboard=500, see the stub), because that is how iOS reports a keyboard and it is the
 * code path App.tsx's --keyboard-inset takes. The share there is of the 500px above the keyboard.
 *
 * Headless WebKit has no notch and no home indicator: every env(safe-area-inset-*) is 0 here. On a
 * phone with a home indicator the numbers are a little lower, by whatever the top bar and the
 * composer pad themselves with.
 */
const MEASURE_CASES = [
  { name: 'iphone-390x844', width: 390, height: 844, keyboard: 0, min: 0.7 },
  { name: 'iphone-430x932', width: 430, height: 932, keyboard: 0, min: 0.7 },
  { name: 'iphone-390x844-keyboard', width: 390, height: 844, keyboard: 500, min: 0.45 },
  // An iPad shows the popup as a popover, sized from the document (popup-size.css): 440x660 on an
  // 11-inch. This is the compact shell at that size, with an iPad's screen behind it so the engine
  // takes the iPad rule, to be looked at as much as measured.
  { name: 'ipad-popover-440x660', width: 440, height: 660, keyboard: 0, min: 0.7, ipad: true, screen: { width: 820, height: 1180 } },
];

async function measureTranscript(dir, label) {
  let playwright;
  try {
    playwright = await import('playwright');
  } catch {
    fail('playwright is not installed', 'npm install, then `npx playwright install webkit`.');
  }
  fs.mkdirSync(dir, { recursive: true });
  const browser = await playwright.webkit.launch();
  const rows = [];
  const failures = [];
  try {
    for (const c of MEASURE_CASES) {
      for (const theme of ['dark', 'light']) {
        const descriptor = c.ipad ? playwright.devices['iPad Pro 11'] : playwright.devices['iPhone 14'];
        const context = await browser.newContext({ ...descriptor, viewport: { width: c.width, height: c.height }, screen: c.screen ?? { width: c.width, height: c.height } });
        const page = await context.newPage();
        const q = `fixture=long&theme=${theme}${c.keyboard ? `&keyboard=${c.keyboard}` : ''}`;
        await page.goto(`http://127.0.0.1:${port}/popup.html?${q}`, { waitUntil: 'load' });
        await page.locator('.messages .msg').first().waitFor({ state: 'visible', timeout: 15000 });
        if (c.keyboard) {
          // A keyboard is up because a field has focus; put it there, as a thumb would have.
          await page.locator('.composer textarea').focus();
        }
        await page.waitForTimeout(400);
        const m = await page.evaluate((keyboard) => {
          const visible = keyboard || window.innerHeight;
          const r = document.querySelector('.messages').getBoundingClientRect();
          const top = Math.max(0, r.top);
          const bottom = Math.min(visible, r.bottom);
          return {
            layout: document.querySelector('.app').getAttribute('data-layout'),
            visible,
            transcript: Math.max(0, Math.round(bottom - top)),
            overflowX: document.documentElement.scrollWidth > window.innerWidth,
          };
        }, c.keyboard);
        const share = m.transcript / m.visible;
        rows.push({ case: c.name, theme, visible: m.visible, transcript: m.transcript, share });
        if (m.layout !== 'compact') failures.push(`${c.name}: data-layout is ${m.layout}, expected compact`);
        if (m.overflowX) failures.push(`${c.name}/${theme}: the page scrolls sideways`);
        if (label !== 'before' && share < c.min) {
          failures.push(`${c.name}/${theme}: the transcript gets ${m.transcript}px of ${m.visible}px (${(share * 100).toFixed(1)}%), under the ${c.min * 100}% floor`);
        }
        const out = path.join(dir, `${label}-${c.name}-${theme}.png`);
        await page.screenshot({ path: out, clip: { x: 0, y: 0, width: c.width, height: m.visible } });
        if (label !== 'before' && theme === 'dark' && !c.keyboard && !c.ipad && c.width === 390) {
          failures.push(...(await compactShellChecks(page, dir, label)));
        }
        await page.close();
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`[preview] transcript height, long fixture, ${label}:`);
  for (const r of rows) {
    console.log(`[preview]   ${r.case.padEnd(26)} ${r.theme.padEnd(5)} ${String(r.transcript).padStart(4)}px of ${String(r.visible).padStart(4)}px  ${(r.share * 100).toFixed(1)}%`);
  }
  if (failures.length) fail(`the compact chat view is not what it should be:\n  ${failures.join('\n  ')}`);
}

/**
 * What the compact shell promises, asserted in the engine Safari ships.
 *
 * A content-first phone UI is mostly things that are NOT on screen, which is exactly what a
 * screenshot cannot vouch for. So this opens every sheet the chat view has the way a thumb would,
 * and checks the parts that fail quietly: that each is a real modal dialog with a name, that focus
 * goes in and comes back out to the control that opened it, that the page behind is inert, that
 * nothing taller than 85% of the screen is drawn, that every control has an accessible name that
 * does not depend on a hover tooltip, and that every target is 44px where a thumb lands on it.
 * It saves a PNG of each sheet on the way, because they are also the screens nobody sees otherwise.
 */
async function compactShellChecks(page, dir, label) {
  const problems = [];
  const shot = (name) => page.screenshot({ path: path.join(dir, `${label}-sheet-${name}.png`) });

  // Names and target sizes, for whatever is on screen right now.
  const audit = async (where) => {
    const found = await page.evaluate(() => {
      const out = [];
      const scope = document.querySelector('.sheet') ?? document.querySelector('.app');
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' && !el.closest('[inert]');
      };
      for (const el of scope.querySelectorAll('button, summary, select, textarea, input:not([type=hidden]):not([hidden]), a[href], [role=option]')) {
        if (!visible(el)) continue;
        // Inside a closed <details> only the summary is real.
        const closed = el.closest('details:not([open])');
        if (closed && el.tagName !== 'SUMMARY') continue;
        if (closed && el.tagName === 'SUMMARY' && el.parentElement !== closed) continue;
        const what = `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).join('.') : ''}`;
        // The accessible name, WITHOUT title: a name that only exists as a tooltip is a name that
        // only exists on hover, and a phone has no hover.
        const labelled = el.getAttribute('aria-labelledby');
        const name = (el.getAttribute('aria-label') || (labelled && document.getElementById(labelled)?.textContent) || el.labels?.[0]?.textContent || el.textContent || el.getAttribute('placeholder') || '').trim();
        if (!name) out.push(`${what}: no accessible name`);
        // A switch inside its <label> is pressed by pressing the label, so the label is the target.
        const r = (el.matches('input[type=checkbox]') && el.closest('label') ? el.closest('label') : el).getBoundingClientRect();
        let h = r.height;
        let w = r.width;
        // A control drawn small and hit large carries its target on ::before.
        const before = getComputedStyle(el, '::before');
        if (before.content !== 'none' && before.position === 'absolute') {
          h += -(parseFloat(before.top) || 0) - (parseFloat(before.bottom) || 0);
          w += -(parseFloat(before.left) || 0) - (parseFloat(before.right) || 0);
        }
        if (h < 43.5 || w < 43.5) out.push(`${what} "${name.slice(0, 30)}": target is ${Math.round(w)}x${Math.round(h)}, under 44px`);
      }
      return out;
    });
    for (const f of found) problems.push(`${where}: ${f}`);
  };

  if (await page.locator('.popup-nav').count()) problems.push('the compact shell still has a bottom navigation bar');
  await audit('chat view');

  const sheetState = () =>
    page.evaluate(() => {
      const el = document.querySelector('.sheet');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const root = document.querySelector('.sheet-root');
      const others = Array.from(root.parentElement.children).filter((c) => c !== root);
      return {
        role: el.getAttribute('role'),
        modal: el.getAttribute('aria-modal'),
        title: (document.getElementById(el.getAttribute('aria-labelledby') ?? '')?.textContent ?? '').trim(),
        focusInside: el.contains(document.activeElement),
        behindInert: others.length > 0 && others.every((c) => c.inert),
        share: r.height / window.innerHeight,
        bottom: Math.round(window.innerHeight - r.bottom),
      };
    });

  /** Open a sheet from `opener`, check it, close it with `how`, check where focus went. */
  const roundTrip = async (name, opener, how, returnsTo = opener) => {
    await page.locator(opener).click();
    const opened = await page.locator('.sheet').waitFor({ state: 'visible', timeout: 5000 }).then(() => true, () => false);
    // The slide-up first, so the sheet is measured, and photographed, at rest.
    await page.waitForTimeout(260);
    const st = opened ? await sheetState() : null;
    if (!st) {
      problems.push(`${name}: no sheet opened from ${opener}`);
      return;
    }
    if (st.role !== 'dialog' || st.modal !== 'true') problems.push(`${name}: not a modal dialog (role=${st.role}, aria-modal=${st.modal})`);
    if (!st.title) problems.push(`${name}: the dialog has no name`);
    if (!st.focusInside) problems.push(`${name}: focus did not move into the sheet`);
    if (!st.behindInert) problems.push(`${name}: the shell behind the sheet is not inert`);
    if (st.share > 0.851) problems.push(`${name}: ${(st.share * 100).toFixed(0)}% of the screen, over the 85% cap`);
    if (st.bottom !== 0) problems.push(`${name}: the sheet floats ${st.bottom}px above the bottom edge`);
    await audit(name);
    // Tab must stay inside, however many times it is pressed.
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
    if (!(await page.evaluate(() => document.querySelector('.sheet')?.contains(document.activeElement)))) problems.push(`${name}: Tab left the sheet`);
    await shot(name);
    if (how === 'escape') await page.keyboard.press('Escape');
    else if (how === 'backdrop') await page.locator('.sheet-backdrop').click({ position: { x: 20, y: 20 } });
    else await page.locator('.sheet-close').click();
    await page.locator('.sheet').waitFor({ state: 'detached', timeout: 5000 }).catch(() => problems.push(`${name}: did not close on ${how}`));
    const back = await page.evaluate((sel) => document.activeElement === document.querySelector(sel), returnsTo);
    if (!back) problems.push(`${name}: focus did not return to ${returnsTo} after ${how}`);
  };

  await roundTrip('chats', '[data-action="chat-sheet"]', 'escape');
  await roundTrip('model', '[data-action="model-chip"]', 'close');
  await roundTrip('add', '[data-action="add"]', 'backdrop');
  await roundTrip('draft', '[data-action="draft-sheet"]', 'escape');
  await roundTrip('menu', '[data-action="menu"]', 'close');

  // A sheet opened from a sheet replaces it, and closing lands on the chat with focus on "+".
  await page.locator('[data-action="add"]').click();
  await page.locator('.sheet [data-action="model"]').click();
  const stacked = await page.locator('.sheet').count();
  const title = await page.locator('.sheet-title').first().textContent();
  if (stacked !== 1 || title?.trim() !== 'Model') problems.push(`"+" then Model: expected one sheet called Model, got ${stacked} called "${title}"`);
  await page.keyboard.press('Escape');
  await page.locator('.sheet').waitFor({ state: 'detached', timeout: 5000 }).catch(() => problems.push('"+" then Model: did not close'));
  if (!(await page.evaluate(() => document.activeElement === document.querySelector('[data-action="add"]')))) problems.push('"+" then Model: focus did not return to "+"');

  // Picking a model is two taps from the chat: the chip, then the model.
  await page.locator('[data-action="model-chip"]').click();
  await page.locator('.sheet [data-testid="model-option"][data-model="claude-sonnet-5"]').click();
  await page.locator('.sheet').waitFor({ state: 'detached', timeout: 5000 }).catch(() => problems.push('model: picking a model did not close the sheet'));
  const chip = (await page.locator('[data-testid="model-chip"]').textContent())?.trim();
  if (chip !== 'claude-sonnet-5') problems.push(`model: the chip says "${chip}" after picking claude-sonnet-5`);

  // The way to Mods and back is the menu and then "Chat" in the bar.
  await page.locator('[data-action="menu"]').click();
  await page.locator('.sheet [data-action="view-mods"]').click();
  await page.locator('[data-action="back-to-chat"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('menu: Mods has no way back to the chat in its bar'));
  await page.waitForTimeout(200);
  await audit('mods view');
  await page.screenshot({ path: path.join(dir, `${label}-view-mods.png`) });
  const more = page.locator('[data-action="mod-more"]').first();
  if (await more.count()) {
    await more.click();
    await page.locator('.sheet').waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('mods: the overflow did not open a sheet'));
    await page.waitForTimeout(260);
    await audit('mod actions');
    await shot('mod-actions');
    await page.keyboard.press('Escape');
  } else problems.push('mods: a mod card has no overflow button');
  await page.locator('[data-action="menu"]').click();
  await page.locator('.sheet [data-action="view-settings"]').click();
  await page.waitForTimeout(300);
  await audit('settings view');
  await page.screenshot({ path: path.join(dir, `${label}-view-settings.png`) });
  await page.locator('[data-action="back-to-chat"]').click();
  await page.locator('.composer.compact').waitFor({ state: 'visible', timeout: 5000 }).catch(() => problems.push('back: "Chat" did not return to the chat view'));

  return problems;
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
  if (!shots && !webkitShots && !probe && !popoverSize && !measure) {
    console.log('[preview] stubbed extension APIs: layout only, nothing runs. Ctrl-C to stop.');
    return;
  }
  try {
    if (shots) await screenshotViews(path.resolve(ROOT, shots));
    if (webkitShots) await webkitCapture(path.resolve(ROOT, webkitShots));
    if (popoverSize) await measurePopoverSize();
    if (measure) await measureTranscript(path.resolve(ROOT, measure), measureLabel);
    if (probe) await probeBrowser();
  } finally {
    server.close();
  }
});
