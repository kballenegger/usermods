#!/usr/bin/env node
// Serve the built Safari popup as an ordinary web page, so it can be looked at on a real iPhone.
//
//   node scripts/safari-preview.mjs                 serve on http://127.0.0.1:4173/popup.html
//   node scripts/safari-preview.mjs --shots out/    serve, then screenshot each view on the
//                                                   booted iOS simulator and exit
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
      const el = document.querySelector('.popup-nav [data-view="' + wanted + '"]');
      if (el) { el.click(); clearInterval(tick); }
      else if (++tries > 100) { clearInterval(tick); console.error('preview: no ' + wanted + ' button'); }
    }, 50);
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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
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
    const html = fs.readFileSync(file, 'utf8').replace('<head>', '<head><script src="/__preview.js"></script>');
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

server.listen(port, '127.0.0.1', async () => {
  console.log(`[preview] http://127.0.0.1:${port}/popup.html  (views: ${VIEWS.map((v) => `?view=${v}`).join(' ')})`);
  if (!shots) {
    console.log('[preview] stubbed extension APIs: layout only, nothing runs. Ctrl-C to stop.');
    return;
  }
  try {
    await screenshotViews(path.resolve(ROOT, shots));
  } finally {
    server.close();
  }
});
