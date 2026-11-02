// The `act` smoke flow (npm run smoke:act), driven from scripts/screenshots.mjs, which passes in its
// browser helpers.
//
// A scripted model (scripts/mock-llm.mjs, ACT) operates a fixture through the built extension: panel,
// background, content script. What is asserted is mostly what the fixture's own server received, since
// that is the ground truth a transcript could be wrong about: declining means nothing arrives, allowing
// means exactly one thing does, and a step cut off by a dead worker does not arrive twice.
//
// Playwright clicks only what a person would, in the panel, and the one real click on the bar. The
// exception is the forgery check: a content-script world sending the messages a panel sends, which has
// to get nowhere.
import http from 'node:http';
import { ACT } from '../mock-llm.mjs';

const fail = (m) => {
  throw new Error(`act: ${m}`);
};
const check = (cond, what, seen) => {
  if (!cond) fail(`${what}${seen === undefined ? '' : `\n  saw: ${typeof seen === 'string' ? seen : JSON.stringify(seen)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fixture(port) {
  return `<!doctype html><meta charset="utf-8"><title>Expenses</title>
<h1>Expenses</h1>
<form id="expense" method="post" action="/expense">
  <label>Merchant <input id="merchant" name="merchant"></label>
  <button id="submit">Submit expense</button>
</form>
<form id="login" method="post" action="/login" aria-label="Sign in">
  <label>Password <input id="password" name="password" type="password"></label>
  <button id="signin">Sign in</button>
</form>
<p>
  <button id="one" onclick="this.dataset.pressed = (Number(this.dataset.pressed) || 0) + 1">One</button>
  <button id="two" onclick="this.dataset.pressed = (Number(this.dataset.pressed) || 0) + 1">Two</button>
</p>
<p><a id="away" href="http://localhost:${port}/elsewhere">Elsewhere</a></p>
<p><button id="more">More rows</button></p>
<ul id="rows"></ul>
<p><button id="process">Process it</button></p>
<script>
  window.__more = 0;
  document.getElementById('more').addEventListener('click', () => {
    window.__more++;
    setTimeout(() => {
      const li = document.createElement('li');
      li.textContent = 'row ' + window.__more;
      document.getElementById('rows').append(li);
    }, 50);
  });
  // Answers the server and leaves the page alone, so a repeat sits waiting for a change that does not come.
  document.getElementById('process').addEventListener('click', () => void fetch('/processed', { method: 'POST' }));
</script>`;
}

async function startSite() {
  const posts = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posts.push({ url: req.url, body });
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Thanks</title><h1>Thanks</h1><p>Recorded.</p>');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url === '/elsewhere') res.end('<!doctype html><title>Elsewhere</title><h1>Elsewhere</h1>');
    else res.end(fixture(port));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  return { base: `http://127.0.0.1:${port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

/** What the bar says and where its buttons are, through the debugger, since its root is closed. */
export async function readBar(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  try {
    const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
    const host = (function find(n) {
      if ((n.attributes ?? []).join(' ').includes('data-usermods bar')) return n;
      for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) {
        const hit = find(k);
        if (hit) return hit;
      }
      return null;
    })(root);
    if (!host) return { up: false, text: '', buttons: {} };
    const texts = [];
    const buttons = {};
    const walk = (n) => {
      if (n.nodeType === 3) texts.push(n.nodeValue);
      if (n.nodeName === 'BUTTON') buttons[(n.children ?? []).map((k) => k.nodeValue).join('')] = n.backendNodeId;
      for (const k of [...(n.children ?? []), ...(n.shadowRoots ?? [])]) walk(k);
    };
    walk(host);
    return { up: true, text: texts.join(' '), buttons };
  } finally {
    await cdp.detach().catch(() => {});
  }
}

async function clickBar(ctx, page, label) {
  const bar = await readBar(ctx, page);
  check(bar.buttons[label], `the bar has ${label}`, bar);
  const cdp = await ctx.newCDPSession(page);
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: bar.buttons[label] });
  await cdp.detach().catch(() => {});
  const [x1, y1, , , x3, y3] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
}

export async function actFlow({ launch, openPanel, openSite, waitForComposer, sendPrompt, startNewChat, stopServiceWorker, requestsFor, clearViolations, fetchViolations, log }) {
  const site = await startSite();
  const b = await launch('light');
  try {
    await clearViolations();
    const panel = await openPanel(b.ctx, b.extId);
    const page = await openSite(b.ctx, `${site.base}/`);
    await waitForComposer(panel);

    const question = (kind) => panel.locator(`[data-testid="question"][data-question="${kind}"]`);
    const anyQuestion = panel.locator('[data-testid="question"]');
    const action = (name) => panel.locator(`[data-action="${name}"]`);
    const assistant = (text) => panel.locator('.messages .msg.assistant', { hasText: text });
    const touched = () => panel.locator('[data-testid="touched"] summary').allTextContents();
    const pressed = (id) => page.evaluate((i) => Number(document.getElementById(i)?.dataset.pressed ?? 0), id);
    const noBar = async () => {
      const end = Date.now() + 10_000;
      while ((await readBar(b.ctx, page)).up && Date.now() < end) await sleep(100);
      check(!(await readBar(b.ctx, page)).up, 'the bar comes down when the run ends');
    };
    const home = async () => {
      await page.goto(`${site.base}/`, { waitUntil: 'load' });
      await page.bringToFront();
    };
    const fresh = async () => {
      await home();
      await startNewChat(panel);
    };
    /** Answer as a page would be able to, from a content-script world. */
    const forge = async (message) =>
      b.ctx.serviceWorkers()[0].evaluate(
        async ([baseUrl, m]) => {
          const [tab] = (await chrome.tabs.query({})).filter((t) => t.url?.startsWith(baseUrl));
          const [r] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'ISOLATED',
            args: [m],
            func: async (msg) => {
              const reply = await chrome.runtime.sendMessage(msg).catch((e) => ({ threw: String(e) }));
              const port = chrome.runtime.connect({ name: 'agent' });
              const cut = await new Promise((res) => {
                port.onDisconnect.addListener(() => res(true));
                setTimeout(() => res(false), 800);
              });
              return { reply, cut };
            },
          });
          return r.result;
        },
        [site.base, message],
      );

    // ----- a. The form. The first step asks to operate the site; "do not ask again" is the user's box.
    await sendPrompt(panel, ACT.form.prompt);
    await question('operate').waitFor({ timeout: 45_000 });
    check(/operate 127\.0\.0\.1/i.test(await question('operate').textContent()), 'the question names the site');
    check(/mislead the model/.test(await question('operate').textContent()), 'and says a page can mislead the model');
    check((await page.inputValue('#merchant')) === '', 'nothing is typed before the answer');
    check(!/driving/.test((await readBar(b.ctx, page)).text), 'the bar does not say it is driving while it waits', (await readBar(b.ctx, page)).text);
    check(/waiting for you in the side panel/.test((await readBar(b.ctx, page)).text), 'the bar sends you to the panel', (await readBar(b.ctx, page)).text);
    check(!(await readBar(b.ctx, page)).buttons['ALLOW'], 'and carries no Allow');
    await panel.locator('[data-testid="question-standing"]').check();
    await action('question-allow').click();
    await panel.locator('.messages .label', { hasText: 'you allowed usermods to operate 127.0.0.1' }).waitFor({ timeout: 15_000 });

    // The consequential submit: named from the read, and the model only labelled.
    await question('allow').waitFor({ timeout: 30_000 });
    check((await page.inputValue('#merchant')) === ACT.form.value, 'the field was filled, through the page', await page.inputValue('#merchant'));
    const headline = await panel.locator('[data-testid="question-headline"]').textContent();
    check(headline === 'click button "Submit expense"', 'the headline is what the extension read', headline);
    check(/the model says: submit the expense/.test(await question('allow').textContent()), 'the model is labelled as the model');
    check((await touched()).some((t) => t === 'filled "Merchant"'), 'the fill is a touched row', await touched());
    check(!(await touched()).join(' ').includes(ACT.form.value), 'and its row does not say what was typed', await touched());
    const activityNow = await panel.locator('.activity').textContent();
    check(/waiting for you · allow click button "Submit expense"\?/.test(activityNow), 'the activity line waits on the user', activityNow);
    check(await panel.locator('.activity.warn').count(), 'in the warn tone');

    // A page answering it, with the right id, in the message a panel sends, gets nowhere.
    const attach = await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'agent.attach' }));
    const [[chatId, up]] = Object.entries(attach.data.questions);
    check(up.kind === 'allow', 'a panel opening now would see the question', up);
    const forged = await forge({ type: 'act.answer', chatId, questionId: up.id, answer: { kind: 'allow' } });
    check(forged.reply?.ok === false, 'a page cannot answer a question', forged);
    check(forged.cut === true, 'a page cannot open the agent port', forged);
    await sleep(300);
    check(await question('allow').count(), 'the question is still up', await anyQuestion.count());
    check(site.posts.length === 0, 'and nothing was posted', site.posts);

    // Declining: the endpoint records nothing, and the model is told.
    await action('question-decline').click();
    await question('allow').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    await panel.locator('[data-testid="touched"]', { hasText: 'not done · you declined: click button "Submit expense"' }).waitFor({ timeout: 15_000 });
    check(site.posts.length === 0, 'declining means the endpoint records nothing', site.posts);
    await waitFor(async () => (await requestsFor('act-form')).length >= 3, 'the model hears about it');
    const told = JSON.stringify((await requestsFor('act-form'))[2].messages.at(-1));
    check(/The user declined this step/.test(told), 'and the model is told', told.slice(0, 400));

    // Allowing: exactly one post, and the bar is back on the page it landed on while the run goes on.
    await question('allow').waitFor({ timeout: 30_000 });
    check(site.posts.length === 0, 'asking again sent nothing either', site.posts);
    await action('question-allow').click();
    await assistant(ACT.form.done).waitFor({ timeout: 45_000 });
    check(site.posts.length === 1 && site.posts[0].url === '/expense', 'allowing runs it once', site.posts);
    check(site.posts[0].body.includes(ACT.form.value), 'with what was typed', site.posts);
    await panel.locator('[data-testid="page-card"]').waitFor({ timeout: 15_000 });
    const card = await panel.locator('[data-testid="page-card"]').textContent();
    check(/on the page · 2 actions/i.test(card), 'the card counts what was recorded', card);
    check(/1 click · 1 field · you allowed 1/.test(card), 'and how', card);
    check(!/\bdone\b/i.test(await panel.locator('[data-testid="page-card"] .label').textContent()), 'it does not claim done', card);
    await noBar();
    await waitFor(async () => (await chatIndex(panel, chatId))?.actions === 2, 'the chat index counts the actions');
    const runsAfter = await panel.evaluate(async () => (await chrome.storage.local.get('runs')).runs ?? {});
    check(!runsAfter[chatId], 'nothing is pending once the run is over', runsAfter);
    log('act: a OK (operate asked, a page cannot answer, decline posts nothing, allow posts once, the card and the index count)');

    // At 360px, what a question looks like, and nothing leaves the column.
    await fresh();
    await panel.setViewportSize({ width: 360, height: 640 });
    await sendPrompt(panel, ACT.form.prompt);
    await question('allow').waitFor({ timeout: 45_000 });
    const overflow = await panel.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `a question at 360px stays in the column`, overflow);
    if (process.env.ACT_SHOT_DIR) await panel.screenshot({ path: `${process.env.ACT_SHOT_DIR}/act-allow-360.png` });
    await action('question-decline').click();
    await question('allow').waitFor({ timeout: 30_000 });
    await action('question-decline').click();
    await assistant(ACT.form.done).waitFor({ timeout: 45_000 });
    await panel.setViewportSize({ width: 420, height: 800 });
    await noBar();
    check(site.posts.length === 1, 'two more declines posted nothing', site.posts);

    // ----- b. The never list, and handing over: refused, with the field untouched.
    await fresh();
    await sendPrompt(panel, ACT.never.prompt);
    await question('handoff').waitFor({ timeout: 45_000 });
    check((await page.inputValue('#password')) === '', 'a password field stays empty');
    const refusedRows = await touched();
    check(refusedRows.filter((t) => /^refused/.test(t)).length === 2, 'the fill and the submit are both refused', refusedRows);
    check(!refusedRows.join(' ').includes(ACT.never.secret), 'and the secret is on no row', refusedRows);
    check(site.posts.every((p) => p.url !== '/login'), 'a form holding a password is not submitted', site.posts);
    const handoff = await question('handoff').textContent();
    check(/Sign in to this site yourself\./.test(handoff), 'Your turn carries the model’s words', handoff);
    const bar = await readBar(b.ctx, page);
    check(/your turn: Sign in to this site yourself/.test(bar.text), 'so does the bar', bar);
    check(bar.buttons['I HAVE DONE IT'] && bar.buttons['STOP'] && Object.keys(bar.buttons).length === 2, 'it carries I have done it and Stop, and nothing else', bar);
    check(/your turn/.test(await panel.locator('.activity').textContent()), 'the line says whose turn it is');
    // A forged "I have done it" from a script on the page is not a click; the real one ends it.
    await page.evaluate(() => document.querySelector('[data-usermods="bar"]').click());
    await sleep(200);
    check(await question('handoff').count(), 'a script clicking the bar does nothing');
    await clickBar(b.ctx, page, 'I HAVE DONE IT');
    await panel.locator('.messages .label', { hasText: 'you did this step: Sign in to this site yourself.' }).waitFor({ timeout: 15_000 });
    // The second handoff ends by itself, when the page shows what it was waiting for.
    await panel.locator('[data-testid="question"]', { hasText: 'Press One' }).waitFor({ timeout: 30_000 });
    check(/continues by itself/.test(await anyQuestion.textContent()), 'it says it will go on by itself');
    await page.click('#one');
    await assistant(ACT.never.done).waitFor({ timeout: 45_000 });
    await noBar();
    log('act: b OK (a password fill and its form are refused, Your turn ends by the bar and by the page)');

    // ----- c. The page leaves the site: the next tool waits, and Go back goes back.
    await fresh();
    await sendPrompt(panel, ACT.offsite.prompt);
    await question('left-site').waitFor({ timeout: 45_000 });
    const left = await question('left-site').textContent();
    check(/The page left 127\.0\.0\.1/i.test(left) && /now on localhost/.test(left), 'the question says where it went', left);
    check(!(await action('question-continue').count()), 'no Continue onto an unrelated host');
    check(new URL(page.url()).hostname === 'localhost', 'the page really is elsewhere', page.url());
    check(!(await panel.locator('.messages .tool', { hasText: 'find_elements' }).count()), 'the next tool has not run');
    await action('question-back').click();
    await assistant(ACT.offsite.done).waitFor({ timeout: 45_000 });
    check(new URL(page.url()).hostname === '127.0.0.1', 'Go back took the page back', page.url());
    check(await panel.locator('.messages .tool', { hasText: 'find_elements' }).count(), 'and only then did the tool run');
    await noBar();
    log('act: c OK (an off-site navigation pauses the run before its next tool)');

    // ----- d. Leaving the tab holds a driving run, and coming back releases it.
    await fresh();
    await sendPrompt(panel, ACT.tab.prompt);
    await waitFor(async () => (await pressed('one')) === 1, 'the first step ran');
    await panel.bringToFront();
    await waitFor(async () => (await panel.locator('.activity').textContent().catch(() => '')).includes('you left the tab'), 'the line says the run is paused');
    check(await panel.locator('.activity.warn').count(), 'a pause is in the warn tone');
    await sleep(600);
    check((await pressed('two')) === 0, 'the next step waits for the tab', await pressed('two'));
    await page.bringToFront();
    await assistant(ACT.tab.done).waitFor({ timeout: 45_000 });
    check((await pressed('two')) === 1, 'and runs when you come back', await pressed('two'));
    await noBar();
    log('act: d OK (a driving run pauses off its tab and picks up on it)');

    // ----- e. Stop, in the panel and on the page, within half a second, between repeats.
    for (const [conv, how] of [[ACT.stop, 'panel'], [ACT.barstop, 'bar']]) {
      await fresh();
      await sendPrompt(panel, conv.prompt);
      await waitFor(async () => (await page.evaluate(() => window.__more)) >= 2, 'the repeat got going');
      const up = await readBar(b.ctx, page);
      check(/driving this page · step 1 · click button "More rows"/.test(up.text), 'the bar says what it is doing', up.text);
      if (how === 'panel') await panel.locator('.activity .activity-action').click();
      else await clickBar(b.ctx, page, 'STOP');
      const at = Date.now();
      await sleep(Math.max(0, 500 - (Date.now() - at)));
      const settled = await page.evaluate(() => window.__more);
      await sleep(1000);
      const later = await page.evaluate(() => window.__more);
      check(later === settled, `Stop from the ${how} ends the repeat within 500 ms`, { settled, later });
      check(settled < 50, 'it did not run to the end', settled);
      await panel.locator('[data-testid="page-card"]', { hasText: 'stopped by you' }).waitFor({ timeout: 20_000 });
      check(!(await assistant(conv.done).count()), 'the model did not go on');
      await noBar();
    }
    log('act: e OK (Stop in the panel and on the page ends a repeat within 500 ms)');

    // ----- f. The worker dies during a step. It is written down, the panel says so, and nothing replays it.
    await fresh();
    const postsBefore = site.posts.length;
    await sendPrompt(panel, ACT.resume.prompt);
    await waitFor(async () => site.posts.filter((p) => p.url === '/processed').length === 1, 'the step reached the server');
    const killed = await stopServiceWorker(b.ctx, panel);
    if (!killed) log('act: f SKIPPED: this Chromium would not stop the service worker over CDP');
    else {
      const row = panel.locator('[data-testid="resume-row"]');
      await row.waitFor({ timeout: 30_000 });
      const pendingText = await panel.locator('[data-testid="resume-pending"]').textContent();
      check(/may or may not have happened: click button "Process it"/.test(pendingText), 'the Resume block says what may have happened', pendingText);
      const before = (await requestsFor('act-resume')).length;
      await sleep(1200);
      check((await requestsFor('act-resume')).length === before, 'it does not resume by itself');
      await page.bringToFront();
      await panel.locator('[data-action="resume"]').click();
      await assistant(ACT.resume.done).waitFor({ timeout: 45_000 });
      const reqs = await requestsFor('act-resume');
      check(/may or may not have happened/.test(JSON.stringify(reqs.at(-2).messages.at(-1))), 'the model is told on resume', JSON.stringify(reqs.at(-2).messages.at(-1)).slice(0, 300));
      check(/ACTFLOW-RESUME-LOOKED/.test(await panel.locator('.messages').textContent()), 'and looks first');
      check(site.posts.filter((p) => p.url === '/processed').length === 1, 'a pending step is not replayed on resume', site.posts);
      check(site.posts.length === postsBefore + 1, 'nothing else went out', site.posts);
      const chats = await panel.evaluate(async () => (await chrome.storage.local.get('runs')).runs ?? {});
      check(!Object.values(chats).some((r) => r.pending), 'the journal is clear once the warning is delivered', chats);
      log('act: f OK (a step cut off by a dead worker is journalled, told, and not replayed)');
    }

    // ----- g. Settings: the standing allowance is listed and can go; Ask before every step asks.
    await panel.locator('[data-view="settings"]').first().click();
    const section = panel.locator('[data-testid="settings-operating"]');
    await section.waitFor({ timeout: 10_000 });
    check(/127\.0\.0\.1/.test(await panel.locator('[data-testid="operating-sites"]').textContent()), 'Settings lists what was allowed');
    await panel.locator('[data-testid="setting-ask-every-step"]').check();
    await panel.locator('[data-testid="settings-saved"]', { hasText: 'all changes saved' }).waitFor({ timeout: 10_000 });
    await section.scrollIntoViewIfNeeded();
    if (process.env.ACT_SHOT_DIR) await panel.screenshot({ path: `${process.env.ACT_SHOT_DIR}/act-settings.png` });
    await panel.locator('[data-action="operating-remove"]').click();
    await panel.locator('[data-testid="operating-none"]').waitFor({ timeout: 10_000 });
    check(/asks the first time in each chat/.test(await panel.locator('[data-testid="operating-none"]').textContent()), 'and says what happens with none');
    const stored = await panel.evaluate(async () => (await chrome.storage.local.get('allowances')).allowances);
    check(!stored.sites['127.0.0.1'], 'Remove removes it', stored);
    await panel.locator('[data-view="chat"]').first().click();
    await fresh();
    await sendPrompt(panel, ACT.every.prompt);
    await question('script').waitFor({ timeout: 45_000 });
    check(/rename the tab/.test(await question('script').textContent()), 'a script asks, by its description');
    check(/ACTFLOW-RAN/.test(await question('script').textContent()), 'and shows its code');
    await action('question-decline').click();
    await question('allow').waitFor({ timeout: 30_000 });
    check((await page.title()) === 'Expenses', 'a declined script did not run', await page.title());
    check(/usermods has not operated/.test(await question('allow').textContent()), 'a first step with every-step on asks about the site too');
    check(!(await action('question-every').count()), 'and offers no "every", since every step asks');
    await action('question-allow').click();
    await assistant(ACT.every.done).waitFor({ timeout: 45_000 });
    await noBar();
    log('act: g OK (Settings lists and removes an allowance; every step and every script asks with the switch on)');

    const violations = await fetchViolations();
    check(!violations.length, 'every request the mock saw was valid', violations.slice(0, 3));
    log('act flow ok');
  } finally {
    await b.close();
    await site.close();
  }

  async function waitFor(fn, what, timeout = 30_000) {
    const end = Date.now() + timeout;
    for (;;) {
      if (await fn()) return;
      if (Date.now() > end) fail(`timed out waiting: ${what}`);
      await sleep(100);
    }
  }
}

async function chatIndex(panel, chatId) {
  const chats = await panel.evaluate(async () => (await chrome.storage.local.get('chats')).chats ?? []);
  return chats.find((c) => c.id === chatId);
}
