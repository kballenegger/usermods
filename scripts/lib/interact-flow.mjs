// The `interact` smoke flow (npm run smoke:interact), driven from scripts/screenshots.mjs, which passes
// in its browser helpers.
//
// It drives the built extension's content messages exactly as the background will: every step goes
// from the service worker through chrome.tabs.sendMessage to the content script, and the action code
// does the rest. A Playwright click is trusted input and would prove nothing, so Playwright only
// observes here: what the fixture page recorded, what its server received, what the bar's closed root
// holds. The single exception is on purpose: one real mouse click on the bar's Stop, because "honours
// only trusted clicks" needs one of each to mean anything.
//
// No model and no mock backend are involved, and the page is this flow's own server on 127.0.0.1.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const fail = (m) => {
  throw new Error(`interact: ${m}`);
};

function check(cond, what, seen) {
  if (!cond) fail(`${what}${seen === undefined ? '' : `\n  saw: ${typeof seen === 'string' ? seen : JSON.stringify(seen)}`}`);
}

/** The fixture and a second page, and a record of every form post, which is the ground truth. */
async function startSite() {
  const page = fs.readFileSync(path.join(process.cwd(), 'test/fixtures/page/interact/index.html'), 'utf8');
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posts.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Posted</title><h1>Thanks</h1>');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/' || req.url === '/routed') res.end(page);
    else res.end('<!doctype html><title>Second</title><h1>Second page</h1><a id="home" href="/">Home</a>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { base: `http://127.0.0.1:${port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

export async function interactFlow({ launch, log }) {
  const site = await startSite();
  const b = await launch('light');
  try {
    let [sw] = b.ctx.serviceWorkers();
    if (!sw) sw = await b.ctx.waitForEvent('serviceworker', { timeout: 20_000 });

    const page = await b.ctx.newPage();
    await page.setViewportSize({ width: 1000, height: 800 });
    await page.goto(`${site.base}/`, { waitUntil: 'load' });

    /** Send a content message from the service worker: the same path a run's steps take. */
    const send = (msg) =>
      sw.evaluate(
        async ([base, m]) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((t) => t.url?.startsWith(base));
          if (!tab) throw new Error('no fixture tab');
          return chrome.tabs.sendMessage(tab.id, m);
        },
        [site.base, msg],
      );
    const ready = async () => {
      const end = Date.now() + 20_000;
      for (;;) {
        const up = await send({ type: 'ping' }).catch(() => null);
        if (up?.ok) return;
        if (Date.now() > end) fail('the content script never answered a ping');
        await new Promise((r) => setTimeout(r, 100));
      }
    };
    await ready();

    /** Refs are read from the model's own view, as a model would read them. */
    const refFor = async (selector) => {
      const { text } = await send({ type: 'query', selector, limit: 1 });
      const m = /ref=(k[0-9a-z]*e\d+)/.exec(text);
      check(m, `find_elements gave ${selector} no ref`, text);
      return m[1];
    };
    let actId = 0;
    /** Describe, then act with the signature that came back: the path every real step takes. */
    const act = async (step) => {
      const read = await send({ type: 'describe', step });
      if (!read?.ok) return { described: read, result: read };
      const result = await send({ type: 'act', id: `a${++actId}`, step, expect: read.signature });
      return { described: read.described, signature: read.signature, result };
    };
    const events = (id, type) => page.evaluate(([i, t]) => window.__events.filter((e) => e.id === i && (!t || e.type === t)), [id, type]);
    const wipeEvents = () => page.evaluate(() => (window.__events.length = 0));

    // --- find_elements: a ref on every match, and the same element keeps it.
    const q = await send({ type: 'query', selector: '#show', limit: 5 });
    check(/^1\. #show \[stable: id\] ref=k[0-9a-z]*e\d+ \[/m.test(q.text), 'find_elements lines carry a ref', q.text);
    const showRef = await refFor('#show');
    check((await refFor('#show')) === showRef, 'an element keeps its ref across calls');

    // --- The inventory: nested, with values withheld.
    await send({ type: 'act', id: 'noop', step: { do: 'scroll_to', target: { selector: '#nope' } }, expect: '' }).then((r) => check(r?.ok === false && r.code === 'broken', 'an act on nothing is broken', r));
    const inv = await send({ type: 'inventory' });
    check(/- navigation "Pagination"\n {2}- link "Next page" \[ref=k[0-9a-z]*e\d+\] → \/page2/.test(inv.text), 'the inventory nests a link under its landmark', inv.text);
    check(/form "New expense"/.test(inv.text) && /button "Submit expense"/.test(inv.text), 'the inventory names the form and its button', inv.text);
    check(!/Unseen/.test(inv.text), 'a hidden control stays out of the inventory', inv.text);
    check(/generic "A clickable div"/.test(inv.text), 'cursor:pointer is an operable last resort', inv.text);
    const scoped = await send({ type: 'query', operable: true, selector: 'nav' });
    check(/Next page/.test(scoped.text) && !/Submit expense/.test(scoped.text), 'find_elements can scope the inventory', scoped.text);

    // --- A click: the pointer sequence reaches the page, with coordinates, and is untrusted.
    let { result } = await act({ target: { ref: showRef }, do: 'click' });
    check(result.ok, 'clicking Show more', result);
    check(/^Clicked button "Show more" \(/.test(result.text), 'the result says what was clicked', result.text);
    check(/1 added \(div\.more\)/.test(result.text), 'the delta names what appeared', result.text);
    check(/New: link "permalink"\. find_elements to get refs\./.test(result.text), 'the delta names the new control', result.text);
    check(/URL unchanged/.test(result.text), 'the delta says the URL did not change', result.text);
    const seq = await events('show');
    check(seq.map((e) => e.type).join() === 'pointerdown,mousedown,pointerup,mouseup,click', 'the full pointer sequence, in order', seq);
    check(seq.every((e) => e.trusted === false), 'everything the extension dispatches is untrusted', seq);
    check(seq.every((e) => e.x > 0 && e.y > 0), 'the events carry coordinates', seq);

    // --- A pointerdown menu, which el.click() alone would not open.
    ({ result } = await act({ target: { selector: '#menu-open' }, do: 'click' }));
    check(result.ok, 'clicking the menu button', result);
    check(await page.evaluate(() => document.getElementById('menu').classList.contains('open')), 'a pointerdown handler ran');

    // --- A controlled input, a native select, a checkbox, a rich editor.
    ({ result } = await act({ target: { ref: await refFor('#merchant') }, do: 'fill', text: 'hunter2-typed' }));
    check(result.ok, 'filling a field', result);
    check((await page.evaluate(() => window.__merchant)) === 'hunter2-typed', 'a controlled input saw the input event');
    check(!/hunter2/.test(JSON.stringify(result)), 'what was typed is nowhere in the result', result);
    const afterFill = await send({ type: 'inventory' });
    check(/textbox "Merchant" \[ref=k[0-9a-z]*e\d+\] value=\(filled\)/.test(afterFill.text), 'the inventory says a field holds something', afterFill.text);
    check(!/hunter2/.test(afterFill.text), 'and never what', afterFill.text);
    ({ result } = await act({ target: { selector: '#delivery' }, do: 'select', text: 'Express' }));
    check(result.ok && (await page.inputValue('#delivery')) === 'exp', 'choosing in a native select', result);
    ({ result } = await act({ target: { selector: '#agree' }, do: 'check' }));
    check(result.ok && (await page.isChecked('#agree')), 'ticking a checkbox', result);
    ({ result } = await act({ target: { selector: '#rich' }, do: 'fill', text: 'A rich note' }));
    check(result.ok && (await page.textContent('#rich')).includes('A rich note'), 'typing into a contenteditable', result);

    // --- A control that is covered, disabled or hidden fails by name, with no click delivered.
    await wipeEvents();
    ({ result } = await act({ target: { selector: '#covered' }, do: 'click' }));
    check(result.code === 'covered' && /covered by span#cookie-wall/.test(result.message), 'a covered control says what covers it', result);
    check(!(await events('covered')).length, 'and receives nothing');
    ({ result } = await act({ target: { selector: '#disabled' }, do: 'click' }));
    check(result.code === 'disabled', 'a disabled control says so', result);
    ({ result } = await act({ target: { selector: '#hidden' }, do: 'click' }));
    check(result.code === 'hidden', 'a hidden control says so', result);

    // --- A target that changed between the question and the step is refused.
    const rename = { target: { selector: '#rename' }, do: 'click' };
    const before = await send({ type: 'describe', step: rename });
    check(before.ok && before.described.name === 'Save', 'the description is read from the element', before);
    await page.evaluate(() => window.renameIt());
    await wipeEvents();
    const changed = await send({ type: 'act', id: 'renamed', step: rename, expect: before.signature });
    check(changed.code === 'changed' && /Delete account/.test(changed.message), 'a renamed control is refused', changed);
    check(!(await events('rename')).length, 'and nothing was delivered');

    // --- The never list, in the page.
    await wipeEvents();
    for (const [what, step] of [
      ['typing a password', { target: { selector: '#password' }, do: 'fill', text: 'hunter2-typed' }],
      ['typing a one-time code', { target: { selector: '#otp' }, do: 'fill', text: '123456' }],
      ['clicking a form holding a password', { target: { selector: '#sign-in' }, do: 'click' }],
      ['Enter in a form holding a password', { target: { selector: '#username' }, do: 'press', text: 'Enter' }],
    ]) {
      const { result: r } = await act(step);
      check(r.ok === false && r.code === 'never', `${what} is refused`, r);
      check(/wait_for with ask_user/.test(r.message), `and the model is told to hand ${what} over`, r);
    }
    check((await page.inputValue('#password')) === '', 'the password field is untouched');
    check(!(await events('sign-in', 'click')).length, 'the login button got no click');
    check(!site.posts.length, 'no form was posted', site.posts);

    // --- A repeat that answers late, until none is left, with the count.
    await wipeEvents();
    const first = await refFor('button.unsub');
    ({ result } = await act({ target: { ref: first }, do: 'click', repeat: 10 }));
    check(result.ok && result.clicks === 3, 'three rows clicked', result);
    check(/3 times; none left\./.test(result.text), 'the result says none is left', result.text);
    await page.waitForFunction(() => !document.querySelector('.unsub'), null, { timeout: 5000 });

    // --- Open shadow roots and same-origin frames.
    ({ result } = await act({ target: { selector: '#in-shadow' }, do: 'click' }));
    check(result.ok, 'a button in an open shadow root', result);
    const frameRead = await send({ type: 'describe', step: { target: { selector: '#in-frame' }, do: 'hover' } });
    check(frameRead.ok && frameRead.described.name === 'In the frame', 'a button in a same-origin frame', frameRead);

    // --- A re-render rebinds a ref, once, and says so.
    const before2 = await refFor('#rerender-me');
    await page.evaluate(() => window.rerenderIt());
    const rebound = await send({ type: 'describe', step: { target: { ref: before2 }, do: 'click' } });
    check(rebound.ok && rebound.rebound === true, 'a re-rendered element rebinds its ref, and the description says so', rebound);
    check(rebound.described.fingerprint.css === '#rerendered', 'onto the new element', rebound);
    ({ result } = await act({ target: { ref: before2 }, do: 'click' }));
    check(result.ok, 'and the ref now works', result);

    // --- The strict replay: the recording's name is what binds, and a broken step says what is near.
    const replay = await send({ type: 'describe', step: { target: { at: { css: '#rename' }, role: 'button', name: 'Save' }, do: 'click' } });
    check(replay.ok === false && replay.broken === 'changed', 'a button now reading something else is broken, whatever the selector says', replay);
    const gone = await send({ type: 'describe', step: { target: { at: { css: '#gone' }, role: 'button', name: 'Submit' }, do: 'click' } });
    check(gone.ok === false && gone.broken === 'none' && gone.closest.some((c) => c.name === 'Submit expense'), 'a broken step carries the closest matches', gone);
    const good = await send({ type: 'describe', step: { target: { at: { css: '#merchant', in: 'form "New expense"' }, role: 'textbox', name: 'Merchant' }, do: 'fill' } });
    check(good.ok && good.described.fingerprint.css === '#merchant', 'a live recording resolves', good);
    check(good.described.fingerprint.landmark === 'form "New expense"', 'with its landmark', good);

    // --- Refs and identity: a route change keeps them, a real navigation does not.
    const keeper = await refFor('#far');
    ({ result } = await act({ target: { selector: '#route' }, do: 'click' }));
    check(result.ok && /URL is now .*\/routed/.test(result.text), 'a route change is reported in the delta', result);
    check(page.url().endsWith('/routed'), 'the page routed');
    const kept = await send({ type: 'describe', step: { target: { ref: keeper }, do: 'hover' } });
    check(kept.ok, 'a ref survives pushState', kept);

    // --- The outline: drawn in its own host, never on the element, gone after the flash.
    await send({ type: 'highlight', target: { selector: '#far' }, mode: 'hold', label: 'Far below' });
    check(await page.evaluate(() => !!document.querySelector('[data-usermods="outline"]')), 'a held outline is up');
    await send({ type: 'highlight', mode: 'clear' });
    check(await page.evaluate(() => !document.querySelector('[data-usermods="outline"]')), 'and cleared');
    check(await page.evaluate(() => !document.getElementById('far').hasAttribute('style')), 'the element itself was not touched');

    // --- The bar: a closed root the page cannot enter, and buttons only a real click can press.
    await sw.evaluate(() => {
      globalThis.__barSeen = [];
      chrome.runtime.onMessage.addListener((m) => {
        if (typeof m?.type === 'string' && m.type.startsWith('usermods:bar')) globalThis.__barSeen.push(m.type);
      });
    });
    const up = await send({ type: 'indicator', state: { bar: { status: 'usermods is driving this page · step 1', handoff: true } } });
    check(up.up === true, 'the bar reports it is up', up);
    const pageView = await page.evaluate(() => {
      const host = document.querySelector('[data-usermods="bar"]');
      return { host: !!host, root: host ? host.shadowRoot : 'no host' };
    });
    check(pageView.host && pageView.root === null, 'the page sees a host and no root', pageView);

    // What is inside, through the debugger the page does not have: the closed root's real contents.
    const cdp = await b.ctx.newCDPSession(page);
    const { root: dom } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const buttons = [];
    const texts = [];
    const walk = (n) => {
      if (n.nodeName === 'BUTTON') buttons.push(n);
      if (n.nodeType === 3) texts.push(n.nodeValue);
      for (const k of n.children ?? []) walk(k);
      for (const k of n.shadowRoots ?? []) walk(k);
      if (n.contentDocument) walk(n.contentDocument);
    };
    const hostNode = (function find(n) {
      if ((n.attributes ?? []).join(' ').includes('data-usermods bar')) return n;
      for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const hit = find(k);
        if (hit) return hit;
      }
      return null;
    })(dom);
    check(hostNode, 'the bar host is in the tree', null);
    check(hostNode.shadowRoots?.[0]?.shadowRootType === 'closed', 'its root is closed', hostNode.shadowRoots);
    walk(hostNode);
    const labelled = (n) => (n.children ?? []).map((k) => k.nodeValue).join('');
    check(buttons.map(labelled).join() === 'I HAVE DONE IT,STOP', 'the bar carries I have done it and Stop, and nothing else', buttons.map(labelled));
    check(texts.some((t) => /driving this page · step 1/.test(t)), 'and the status', texts);

    // A click the page can make: on the host from outside, and at the point itself. Neither counts.
    const stop = buttons[1];
    const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: stop.backendNodeId });
    const [x1, y1, , , x3, y3] = model.content;
    const at = { x: (x1 + x3) / 2, y: (y1 + y3) / 2 };
    await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      el.click();
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: x, clientY: y }));
    }, at);
    await new Promise((r) => setTimeout(r, 300));
    check((await sw.evaluate(() => globalThis.__barSeen)).length === 0, 'an untrusted click from the page does nothing', await sw.evaluate(() => globalThis.__barSeen));

    // The one real click in this flow: Stop reaches the background.
    await page.mouse.click(at.x, at.y);
    const end = Date.now() + 5000;
    while (!(await sw.evaluate(() => globalThis.__barSeen)).includes('usermods:bar-stop') && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    check((await sw.evaluate(() => globalThis.__barSeen)).join() === 'usermods:bar-stop', 'a real click on Stop reaches the background', await sw.evaluate(() => globalThis.__barSeen));

    // Hidden for a screenshot, then down.
    await send({ type: 'indicator', state: { hidden: true } });
    check(await page.evaluate(() => document.querySelector('[data-usermods="bar"]').style.display === 'none'), 'the bar hides for a screenshot');
    await send({ type: 'indicator', state: { hidden: false } });

    // A page removing the bar is put back a few times, and then the run hears about it when it asks.
    await page.evaluate(() => document.querySelector('[data-usermods="bar"]').remove());
    await page.waitForFunction(() => !!document.querySelector('[data-usermods="bar"]'), null, { timeout: 3000 });
    const stubborn = await page.evaluate(async () => {
      for (let i = 0; i < 10; i++) {
        document.querySelector('[data-usermods="bar"]')?.remove();
        await new Promise((r) => setTimeout(r, 30));
      }
      return !!document.querySelector('[data-usermods="bar"]');
    });
    check(stubborn === false, 'after a few restores the bar stays gone');
    const asked = await send({ type: 'indicator', state: { hidden: false } });
    check(asked.up === false, 'and the run can read that', asked);
    await send({ type: 'indicator', state: { bar: null } });

    // --- A real submit, gated by nobody here: the described facts, then the one post it makes.
    await page.goto(`${site.base}/`, { waitUntil: 'load' });
    await ready();
    const submit = { target: { selector: '#submit-expense' }, do: 'click' };
    const facts = await send({ type: 'describe', step: submit });
    check(facts.ok && facts.described.submits === true, 'the extension reads that it submits', facts);
    check(facts.described.form.method === 'post' && facts.described.form.action === '/submit', 'with what method and where', facts);
    const posted = await send({ type: 'act', id: 'post', step: submit, expect: facts.signature });
    check(posted.ok && posted.navigating === true, 'the step reports the page leaving, rather than being lost with it', posted);
    const postEnd = Date.now() + 5000;
    while (!site.posts.length && Date.now() < postEnd) await new Promise((r) => setTimeout(r, 50));
    check(site.posts.length === 1 && site.posts[0].url === '/submit', 'the form posted exactly once', site.posts);
    await page.waitForURL(`${site.base}/submit`, { timeout: 15_000 });

    // --- A go, and a ref from before a real navigation is stale on the new page.
    await page.goto(`${site.base}/`, { waitUntil: 'load' });
    await ready();
    const oldRef = await refFor('#far');
    const go = await act({ do: 'go', text: '/page2' });
    check(go.result.ok && go.result.navigating === true, 'go answers before it leaves', go.result);
    await page.waitForURL(`${site.base}/page2`, { timeout: 15_000 });
    await ready();
    const stale = await send({ type: 'describe', step: { target: { ref: oldRef }, do: 'hover' } });
    check(stale.ok === false && stale.broken === 'stale', 'a ref from before a real navigation is stale', stale);
    const script = await act({ do: 'go', text: 'javascript:alert(1)' });
    check(script.result.code === 'never', 'a go to a script address is refused', script.result);

    log('interact flow ok');
  } finally {
    await b.close();
    await site.close();
  }
}
