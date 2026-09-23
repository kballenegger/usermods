#!/usr/bin/env node
// Captures the real extension for the launch video's demo beat.
//
//   npm run video:capture     (builds the test extension first, then runs this)
//
// It drives the REAL side panel (the USERMODS_TEST_BUILD output) against the repo's scripted mock
// backend (scripts/mock-llm.mjs), on the live Hacker News "Show HN" page, and writes stills into
// video/assets/capture/. No API key, no real model endpoint and no local model server is involved:
// every reply the panel shows is the mock's `hacker-news-dark` script.
//
// It follows the same rules as scripts/screenshots.mjs (see the notes at the top of that file):
//
//  - The panel page is opened in a normal tab at side-panel proportions, because Playwright cannot
//    see the real side panel. It is the same page, so it looks and behaves the same.
//  - chrome.userScripts does not exist in an automated profile, so the panel's first-run setup
//    notice and the proposal card's "not tested on this page" line are hidden with the same CSS
//    masks the README captures use.
//  - For the same reason "Run once" cannot execute inside this profile. The "after" still of the
//    page is therefore made by evaluating the mod's exact proposed code in the page with
//    Playwright, which is what Run once would have injected. The script is read back out of the
//    proposal card, not retyped here.
//
//
// Token-by-token streaming. The mock streams whole words 12ms apart, faster than anything can be
// photographed. So the panel does not talk to the mock directly: it talks to a small pacing proxy
// in this file, which forwards each request to the mock, then re-streams the reply to the panel in
// token-sized pieces (1-4 characters, seeded), holding the stream after every piece until the
// panel has rendered it and been photographed. Every streaming frame is therefore a real render of
// the real panel mid-reply, including its "writing" status bar. Tool calls are forwarded whole, and
// the panel really runs them against the page between requests.
//
// Outputs (lossless WebP, device scale 2):
//   site-before.webp, site-after.webp            the HN tab, SITE viewport
//   panel-00-empty.webp                          the panel, idle
//   panel-01-type-NN.webp                        the composer, one typed character per frame
//   panel-02-stream-NNN.webp                     one frame per streamed piece / tool row / wait
//   panel-03-proposal.webp                       the proposal card, scrolled into view
//   panel-04-saved.webp                          after Save
//   panel-05-mods.webp                           the Mods tab with the new mod enabled
//   capture.json, capture.js                     the frame list (each stream frame tagged text,
//                                                tool, tool-done or wait) and the card/button
//                                                boxes the composition points at

import { chromium } from 'playwright';
import sharp from 'sharp';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extDir } from '../../scripts/build-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXT_DIR = extDir(ROOT, { requireTestBuild: true });
const OUT = path.join(ROOT, 'video', 'assets', 'capture');
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8797);
const MOCK_ORIGIN = `http://127.0.0.1:${PORT}`;
const PROXY_PORT = PORT + 1;
/** What the panel is pointed at: the pacing proxy, which forwards to the mock. */
const BASE_URL = `http://127.0.0.1:${PROXY_PORT}/v1`;

/** Sized so the site and the panel fill the video's browser frame side by side at 1x. */
const SITE = { width: 1340, height: 852 };
const PANEL = { width: 440, height: 852 };
const SCALE = 2;

const PROMPT = 'make hacker news dark';
// Show HN rather than the front page: a launch video should not carry whatever the day's news is.
const SITE_URL = 'https://news.ycombinator.com/show';

/**
 * The mock titles every chat with one canned string ("Full-width Wikipedia articles."), because
 * its title reply is shared by all its scripts. A real model titles the chat from the request, so
 * the capture shows the title a real run would plausibly get. Display only; storage is untouched.
 */
const CANNED_TITLE = 'Full-width Wikipedia articles'; // the panel strips the quotes and the period
const SHOWN_TITLE = 'Hacker News dark';

const MASK = [
  '.app > .notice, .dash-inner > .notice { display: none !important; }',
  '.card .label.untested { display: none !important; }',
  // No blinking caret in stills: its phase would differ frame to frame and read as flicker.
  'textarea { caret-color: transparent !important; }',
].join('\n');

const log = (...a) => console.log('[capture]', ...a);

/** Seeded PRNG, so the token split is the same on every capture. */
function prng(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split text the way a tokenizer roughly does: short words (with their trailing space and
 * punctuation) are one piece, longer ones break into 2-4 character sub-word pieces. Every piece is
 * 1-4 characters.
 */
function tokenize(text, rand) {
  const out = [];
  for (const word of text.match(/\S+\s*/g) ?? []) {
    let rest = word;
    while (rest.length > 4) {
      const n = 2 + Math.floor(rand() * 3); // 2..4
      // Never leave a lone trailing space or punctuation mark as its own piece.
      const take = rest.length - n < 2 ? rest.length - 2 : n;
      out.push(rest.slice(0, take));
      rest = rest.slice(take);
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * The pacing proxy. Holds each streamed piece until `onGate` (the photographer) resolves it.
 * Requests without tools (the chat-title call) and non-chat routes pass straight through.
 */
function startProxy(onGate) {
  const rand = prng(20260923);
  const sseLine = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const upstream = await fetch(MOCK_ORIGIN + req.url, {
      method: req.method,
      headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
    const text = await upstream.text();
    let parsed = null;
    try {
      parsed = req.method === 'POST' && req.url.includes('/chat/completions') ? JSON.parse(String(body)) : null;
    } catch {}
    const paced = parsed && Array.isArray(parsed.tools) && parsed.tools.length > 0 && upstream.ok;
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', '*');
    if (!paced) {
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(text);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    // The panel is now waiting on this request: after a tool ran, or right after Send.
    await onGate(parsed.messages.some((m) => m.role === 'tool') ? 'tool-done' : 'wait');
    const events = text
      .split('\n')
      .filter((l) => l.startsWith('data: ') && l !== 'data: [DONE]')
      .map((l) => JSON.parse(l.slice(6)));
    let toolPending = false;
    for (const ev of events) {
      const delta = ev.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string' && delta.content) {
        for (const piece of tokenize(delta.content, rand)) {
          res.write(sseLine({ ...ev, choices: [{ ...ev.choices[0], delta: { content: piece } }] }));
          await onGate('text');
        }
        continue;
      }
      res.write(sseLine(ev));
      if (delta.tool_calls) toolPending = true;
      if (ev.choices?.[0]?.finish_reason && toolPending) await onGate('tool');
    }
    res.end('data: [DONE]\n\n');
  });
  return new Promise((resolve) => server.listen(PROXY_PORT, '127.0.0.1', () => resolve(server)));
}

/** Screenshots are stored as lossless WebP: pixel-identical to the PNG, a fraction of the size. */
async function save(buf, name) {
  await sharp(buf).webp({ lossless: true, effort: 5 }).toFile(path.join(OUT, name));
  return name;
}

async function startMock() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm.mjs'), String(PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('mock-llm did not start')), 10_000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('listening')) {
        clearTimeout(t);
        resolve();
      }
    });
    child.on('exit', (c) => reject(new Error(`mock-llm exited with ${c}`)));
  });
  return child;
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const mock = await startMock();
  // The photographer: whoever is waiting on the proxy's gate gets a screenshot, then the stream goes on.
  let gateWaiter = null;
  const gates = [];
  const proxy = await startProxy((kind) => new Promise((release) => {
    gates.push({ kind, release });
    if (gateWaiter) gateWaiter();
  }));
  log(`mock backend on ${MOCK_ORIGIN}, pacing proxy on ${BASE_URL}`);

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-video-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    colorScheme: 'dark',
    viewport: PANEL,
    deviceScaleFactor: SCALE,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const manifest = { prompt: PROMPT, site: SITE_URL, typeFrames: [], streamFrames: [] };

  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
    const extId = new URL(sw.url()).host;

    // The panel, seeded the way the README captures seed it: the mock under the name a reader sees.
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
    await panel.evaluate(
      async ([base]) => {
        await chrome.storage.local.set({
          settings: { provider: 'openai-compatible', baseUrl: base, apiKey: '', model: 'demo', theme: 'dark' },
          consent: { version: 1, acceptedAt: Date.now() },
          connections: { v: 1, list: [{ id: 'capture', kind: 'openai-compatible', label: 'Anthropic', baseUrl: base, apiKey: '', extraModels: ['claude-opus-5'] }] },
          modelChoice: { connectionId: 'capture', model: 'claude-opus-5', label: 'Anthropic' },
        });
      },
      [BASE_URL],
    );
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await panel.addStyleTag({ content: MASK });

    // The site, made the active tab so the panel targets it.
    const site = await ctx.newPage();
    await site.setViewportSize(SITE);
    await site.goto(SITE_URL, { waitUntil: 'networkidle', timeout: 60_000 });
    await site.bringToFront();
    await save(await site.screenshot(), 'site-before.webp');
    log('site-before.webp');

    await panel.locator('textarea:not([disabled])').waitFor({ state: 'visible', timeout: 30_000 });
    await panel.addStyleTag({ content: MASK });
    await panel.waitForTimeout(800);
    await save(await panel.screenshot(), 'panel-00-empty.webp');

    // Typing, one character per frame: the user types, so this stays a typewriter.
    for (let n = 1; n <= PROMPT.length; n++) {
      await panel.locator('textarea').fill(PROMPT.slice(0, n));
      await panel.waitForTimeout(40);
      manifest.typeFrames.push(await save(await panel.screenshot(), `panel-01-type-${String(n - 1).padStart(2, '0')}.webp`));
    }

    await panel.evaluate(([from, to]) => {
      const fix = () => {
        for (const o of document.querySelectorAll('.chatbar option')) {
          if (o.textContent.includes(from)) o.textContent = o.textContent.replace(from, to);
        }
      };
      new MutationObserver(fix).observe(document.body, { subtree: true, childList: true, characterData: true });
      fix();
    }, [CANNED_TITLE, SHOWN_TITLE]);

    // Send, then photograph every gate the proxy raises until the proposal card is up and the
    // stream has gone quiet. Identical consecutive frames reuse the previous file.
    await panel.locator('.composer .cbtn.send').click();
    const t0 = Date.now();
    const card = panel.locator('.messages .card h4').first();
    let lastHash = '';
    let lastName = '';
    let k = 0;
    const settle = () => panel.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    while (Date.now() - t0 < 180_000) {
      if (!gates.length) {
        const quiet = await Promise.race([
          new Promise((r) => { gateWaiter = () => r(false); }),
          new Promise((r) => setTimeout(() => r(true), 1500)),
        ]);
        gateWaiter = null;
        if (quiet && !gates.length && (await card.count())) break;
        continue;
      }
      const { kind, release } = gates.shift();
      await panel.waitForTimeout(kind === 'text' ? 30 : 120);
      await settle();
      const buf = await panel.screenshot();
      const h = crypto.createHash('sha1').update(buf).digest('hex');
      if (h !== lastHash) {
        lastName = await save(buf, `panel-02-stream-${String(k).padStart(3, '0')}.webp`);
        lastHash = h;
        k++;
      }
      manifest.streamFrames.push({ name: lastName, kind });
      release();
    }
    await card.waitFor({ timeout: 60_000 });
    await panel.waitForTimeout(900);
    await panel.addStyleTag({ content: MASK });
    // Scroll the transcript so the proposal card sits in view.
    await panel.locator('[data-testid="proposal-card"]').first().scrollIntoViewIfNeeded();
    await panel.waitForTimeout(300);
    await save(await panel.screenshot(), 'panel-03-proposal.webp');
    const kinds = manifest.streamFrames.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] ?? 0) + 1 }), {});
    log(`${manifest.streamFrames.length} stream gates (${k} distinct frames) ${JSON.stringify(kinds)} in ${Date.now() - t0} ms`);

    // Where the buttons sit, so the composition can point at them without guessing.
    const box = async (loc) => (await loc.count() ? await loc.first().boundingBox() : null);
    manifest.runOnceBox = await box(panel.locator('[data-testid="proposal-card"] button', { hasText: 'Run once' }));
    manifest.saveBox = await box(panel.locator('[data-testid="card-save"]'));
    manifest.cardBox = await box(panel.locator('[data-testid="proposal-card"]'));

    // "Run once": the mod's exact code, taken from the card, applied to the live page.
    const code = await panel.locator('[data-testid="proposal-card"] pre').first().textContent();
    if (!code || !code.includes('#hnmain')) throw new Error('proposal card did not carry the HN script');
    await site.evaluate((src) => new Function(src)(), code);
    await site.waitForTimeout(400);
    await save(await site.screenshot(), 'site-after.webp');
    log('site-after.webp');

    // Save, for real: the mod lands in storage.
    await panel.locator('[data-testid="card-save"]').click();
    await panel.locator('[data-testid="card-saved"]').first().waitFor({ timeout: 10_000 });
    await panel.waitForTimeout(500);
    await panel.addStyleTag({ content: MASK });
    await save(await panel.screenshot(), 'panel-04-saved.webp');
    const mods = await panel.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? []);
    if (mods.length !== 1) throw new Error(`expected 1 saved mod, found ${mods.length}`);
    // The saved source's metadata block, for the "plain userscripts" beat: what Save actually wrote.
    const src = String(mods[0].source ?? '');
    manifest.savedMod = { name: mods[0].name, enabled: mods[0].enabled, header: src.slice(0, src.indexOf('==/UserScript==') + 15) };

    // The Mods tab, showing the mod installed and on.
    await panel.getByRole('button', { name: /^mods$/i }).first().click().catch(async () => {
      await panel.locator('text=MODS').first().click();
    });
    await panel.waitForTimeout(700);
    await panel.addStyleTag({ content: MASK });
    await save(await panel.screenshot(), 'panel-05-mods.webp');

    const v = await (await fetch(`${MOCK_ORIGIN}/__violations`)).json();
    if (v.violations.length) throw new Error(`mock saw ${v.violations.length} invalid request(s)`);

    fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(manifest, null, 2));
    // The same, as a script the composition loads synchronously (no fetch at render time).
    fs.writeFileSync(path.join(OUT, 'capture.js'), `window.CAPTURE = ${JSON.stringify(manifest, null, 2)};\n`);
    log('done →', path.relative(ROOT, OUT));
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    mock.kill();
    proxy.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
