// The check harness against a local node:http page, never a live site.

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { chromium, type Browser } from 'playwright';
import { addEntry, combine, KEEP, type CheckEntry } from '../src/check/records.ts';
import { checkUrl, type CheckSpec } from '../src/check/run.ts';
import { matchesUrl, parseMeta } from '../src/check/userscript.ts';

// A page whose promo box arrives after load, the way feeds fill in.
const PAGE = `<!doctype html><html><head><title>fixture</title></head><body>
<main><p class="post">one</p><p class="post">two</p></main>
<script>setTimeout(() => { const d = document.createElement('div'); d.className = 'promo'; d.textContent = 'ad'; document.body.append(d); }, 300);</script>
</body></html>`;

function script(body: string, runAt = 'document-start', match = 'http://127.0.0.1/*'): string {
  return `// ==UserScript==
// @name test
// @match ${match}
// @run-at ${runAt}
// @grant GM_addStyle
// ==/UserScript==
${body}`;
}

const spec: CheckSpec = {
  urls: [],
  loggedOut: true,
  waitFor: '.promo',
  settleMs: 200,
  baseline: "document.querySelector('.promo')?.checkVisibility() === true",
  expect: "document.querySelector('.promo') !== null && !document.querySelector('.promo').checkVisibility()",
  intact: "document.querySelectorAll('.post').length === 2",
};

let server: Server;
let browser: Browser;
let url: string;

before(async () => {
  let wallHits = 0;
  server = createServer((req, res) => {
    const html = (body: string) => res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    if (req.url?.startsWith('/recaptcha/')) return html('<!doctype html><p>captcha widget</p>');
    // Every load carries a reCAPTCHA iframe, the way Reddit's pages do.
    if (req.url === '/feed-with-frame') return html(PAGE.replace('</main>', '</main><iframe src="/recaptcha/anchor"></iframe>'));
    // The first load gets the page, later loads a bot wall.
    if (req.url === '/wall-second') return html(wallHits++ === 0 ? PAGE : '<!doctype html><p>Our systems have detected unusual traffic</p>');
    // Etsy's DataDome reload: the first visit carries a cross-site frame that stays busy while the
    // top page reloads itself, so the frame detaches while the harness is looking in it for a
    // consent button. The reloaded page has the consent button in the main frame.
    if (req.url === '/busy-frame') return html('<!doctype html><script>const t = Date.now() + 3000; while (Date.now() < t);</script>');
    if (req.url === '/consent-reload') {
      if (/consent=1/.test(req.headers.cookie ?? '')) {
        return html(PAGE.replace('<main>', '<div id="cmp"><button onclick="this.parentNode.remove()">Accept all</button></div><main>'));
      }
      const port = (server.address() as AddressInfo).port;
      return html(`<!doctype html><title>check</title><iframe src="http://localhost:${port}/busy-frame"></iframe>
<script>setTimeout(() => { document.cookie = 'consent=1; path=/'; location.reload(); }, 500);</script>`);
    }
    html(PAGE);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/feed`;
  browser = await chromium.launch({ channel: 'chromium', headless: true });
});

after(async () => {
  await browser.close();
  server.close();
});

async function run(source: string, s: CheckSpec = spec, path = '/feed') {
  return checkUrl(browser, url.replace('/feed', path), s, { source, meta: parseMeta(source) }, { timeoutMs: 20_000, userAgent: 'test' });
}

describe('checkUrl', () => {
  test('passes a script that hides the target with GM_addStyle at document-start', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');"));
    assert.equal(r.result, 'pass', r.note ?? '');
  });

  test('runs document-idle scripts after load', async () => {
    const r = await run(script("document.documentElement.dataset.ran = document.readyState;", 'document-idle'), {
      ...spec,
      expect: "document.documentElement.dataset.ran === 'complete'",
    });
    assert.equal(r.result, 'pass', r.note ?? '');
  });

  test('fails when expect is false', async () => {
    const r = await run(script('// does nothing'));
    assert.equal(r.result, 'fail');
    assert.match(r.note ?? '', /expect was false/);
  });

  test('fails with the error when the script throws', async () => {
    const r = await run(script("throw new Error('boom');"));
    assert.equal(r.result, 'fail');
    assert.match(r.note ?? '', /script threw: Error: boom/);
  });

  test('fails when the script breaks the page (intact false)', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }'); addEventListener('DOMContentLoaded', () => document.querySelector('main').remove());"));
    assert.equal(r.result, 'fail');
    assert.match(r.note ?? '', /intact was false/);
  });

  test('is blocked, not passed, when the target is absent without the script', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');"), { ...spec, waitFor: '.never', settleMs: 0, baseline: "document.querySelector('.never') !== null" });
    assert.equal(r.result, 'blocked');
    assert.match(r.note ?? '', /target not present/);
  });

  test('fails, not blocked, when a captcha frame is on every load and the script does nothing', async () => {
    const r = await run(script('// does nothing'), spec, '/feed-with-frame');
    assert.equal(r.plain.wall, 'captcha frame');
    assert.equal(r.result, 'fail', r.note ?? '');
    assert.match(r.note ?? '', /expect was false/);
  });

  test('passes with a captcha frame on every load when the assertions hold', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');"), spec, '/feed-with-frame');
    assert.equal(r.result, 'pass', r.note ?? '');
  });

  test('is blocked when a wall shows up only on the load with the script', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');"), { ...spec, waitFor: undefined, settleMs: 500 }, '/wall-second');
    assert.equal(r.result, 'blocked', r.note ?? '');
    assert.match(r.note ?? '', /unusual traffic/);
  });

  test('runs actions before the assertions', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');"), {
      ...spec,
      actions: "document.body.dataset.acted = '1';",
      expect: `${spec.expect} && document.body.dataset.acted === '1'`,
    });
    assert.equal(r.result, 'pass', r.note ?? '');
  });

  test('finds the consent button when the page reloads during the consent scan', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');"), spec, '/consent-reload');
    assert.equal(r.plain.error, undefined);
    assert.equal(r.plain.consent, 'Accept all');
    assert.equal(r.result, 'pass', r.note ?? '');
  });

  test('does not inject when @match does not cover the URL', async () => {
    const r = await run(script("GM_addStyle('.promo { display: none !important; }');", 'document-start', 'https://example.com/*'));
    assert.equal(r.result, 'fail');
  });
});

describe('userscript metadata', () => {
  test('match patterns', () => {
    const meta = parseMeta(script('', 'document-start', 'https://*.youtube.com/*'));
    assert.ok(matchesUrl(meta, 'https://www.youtube.com/watch?v=1'));
    assert.ok(matchesUrl(meta, 'https://youtube.com/'));
    assert.ok(!matchesUrl(meta, 'https://notyoutube.com/'));
    assert.ok(!matchesUrl(meta, 'http://www.youtube.com/'));
  });

  test('rejects grants other than none and GM_addStyle', () => {
    assert.throws(() => parseMeta(script('').replace('GM_addStyle', 'GM_xmlhttpRequest')), /not allowed/);
  });
});

describe('records', () => {
  const entry = (at: string, result: CheckEntry['result'] = 'pass'): CheckEntry => ({
    at, result, url: 'https://x/', scriptSha: 'a'.repeat(64), browser: 'chromium 1', via: 'local',
  });

  test('keeps the newest entries first, at most KEEP per page', () => {
    let file = {};
    for (let i = 0; i < KEEP + 3; i++) file = addEntry(file, 'site/task', entry(`2026-11-${String(i + 1).padStart(2, '0')}T00:00:00Z`));
    const list = (file as Record<string, CheckEntry[]>)['site/task'] ?? [];
    assert.equal(list.length, KEEP);
    assert.equal(list[0]?.at, '2026-11-13T00:00:00Z');
  });

  test('one result per page: any fail wins, url is the first URL that did not pass', () => {
    assert.deepEqual(combine([{ url: 'a', result: 'pass' }, { url: 'b', result: 'pass' }]), { result: 'pass', url: 'a' });
    const c = combine([{ url: 'a', result: 'pass' }, { url: 'b', result: 'blocked', note: 'wall' }, { url: 'c', result: 'fail', note: 'x' }]);
    assert.equal(c.result, 'fail');
    assert.equal(c.url, 'b');
    assert.equal(combine([{ url: 'a', result: 'blocked', note: 'wall' }]).result, 'blocked');
  });
});
