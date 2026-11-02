// The skills smoke flow (npm run smoke:skills), driven from scripts/screenshots.mjs, which passes in
// its browser helpers. See docs/specs/skills.md, section 9.
//
// Three fictional sites answer through Playwright routes, so the hosts in a recorded file are the ones
// the spec names and a compiled file can be compared byte for byte. The scripted model records each
// example once; every replay after that has no model behind it, and that is asserted from the mock's
// own record of what it was asked. What decides "wrong element" is the page: each variant marks what
// must never be touched with data-wrong, and the page counts every event that reaches one.
//
// Playwright clicks what a person would, in the panel, and what a person does on a Your turn step.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { SKILLS } from '../mock-llm.mjs';
import { readBar } from './act-flow.mjs';
import { gistEditorPage, gistViewPage } from './share-fixtures.mjs';
import { OFFLINE_HOSTS, holdExtensionTabs } from './share-flows.mjs';

const fail = (m) => {
  throw new Error(`skills: ${m}`);
};
const check = (cond, what, seen) => {
  if (!cond) fail(`${what}${seen === undefined ? '' : `\n  saw: ${typeof seen === 'string' ? seen : JSON.stringify(seen)}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FIX = path.join(process.cwd(), 'test/fixtures/skill');
const read = (rel) => fs.readFileSync(path.join(FIX, rel), 'utf8');
const html = (body, status = 200) => ({ status, contentType: 'text/html; charset=utf-8', body });
const today = /on \d{4}-\d{2}-\d{2} from/;

export const VARIANTS = ['renamed-class', 'moved', 'reordered', 'decoy', 'renamed-button', 'removed'];

/** What every fixture page starts with: its variant, and the count of events on what it must not touch. */
const preamble = (variant) => `<script>
window.__variant = ${JSON.stringify(variant)};
for (const t of ['click', 'input', 'change', 'pointerdown']) document.addEventListener(t, (e) => {
  if (e.target && e.target.closest && e.target.closest('[data-wrong]')) sessionStorage.__wrong = String(Number(sessionStorage.__wrong || 0) + 1);
}, true);
</script>`;

/** The three sites. `state.variant` is what the next page load is. */
async function routeSites(ctx, state) {
  const page = (file) => html(preamble(state.variant) + read(file));
  await ctx.route('https://expenses.example.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'POST') {
      state.posts.push({ url: u.pathname, body: req.postData() ?? '' });
      return route.fulfill(html(read('expense-form/filed.html')));
    }
    if (u.pathname === '/expenses') return route.fulfill(html('<!doctype html><title>Expenses</title><h1>Expenses</h1>'));
    return route.fulfill(page('expense-form/index.html'));
  });
  await ctx.route('https://billing.example.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname.endsWith('.csv')) {
      state.csv.push(u.pathname);
      return route.fulfill({ status: 200, contentType: 'text/csv', headers: { 'content-disposition': 'attachment' }, body: 'number\nINV-2001\n' });
    }
    if (u.pathname === '/invoices') return route.fulfill(page('export-invoices/invoices.html'));
    return route.fulfill(page('export-invoices/index.html'));
  });
  await ctx.route('https://photos.example.com/**', (route) => route.fulfill(page('album-links/index.html')));
  // A form and a link for the hand-written skills: skill-submit, skill-never, skill-offsite.
  await ctx.route('https://forms.example.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'POST') {
      state.posts.push({ url: u.pathname, body: req.postData() ?? '' });
      return route.fulfill(html('<!doctype html><title>Thanks</title><h1>Thanks</h1>'));
    }
    if (u.pathname === '/redirect') return route.fulfill({ status: 302, headers: { location: 'https://elsewhere.example.org/landing' } });
    return route.fulfill(
      html(`<!doctype html><meta charset="utf-8"><title>Forms</title><main>
<form id="pay" aria-label="Pay" method="post" action="/pay"><button id="send" type="submit">Submit payment</button></form>
<form id="login" aria-label="Sign in" method="post" action="/login"><label for="pw">Password</label><input id="pw" name="pw" type="password"><button id="signin" type="submit">Sign in</button></form>
<p><a id="away" href="https://elsewhere.example.org/landing">Elsewhere</a></p>
<p><button id="row-a" class="r" type="button">Edit</button> <button id="row-b" class="r" type="button">Edit</button></p>
<p><button id="slow" type="button" onclick="fetch('/slow',{method:'POST'});">Process it</button></p>
</main>`),
    );
  });
  await ctx.route('https://elsewhere.example.org/**', (route) => route.fulfill(html('<!doctype html><title>Elsewhere</title><h1>Elsewhere</h1>')));
}

/** A hand-written skill: the shape a stranger's file has. */
const handWritten = (name, steps, { start = 'https://forms.example.com/', inputs = 'inputs: {}', outputs = 'outputs: {}', match = '*://forms.example.com/*' } = {}) => `---
usermods-skill: 1
name: ${name}
description: A hand-written skill for the smoke flow.
namespace: smoke
version: 1.0.0
match:
  - "${match}"
start: ${start}
${inputs}
${outputs}
---

# ${name}

\`\`\`steps
${steps}
\`\`\`
`;

export async function skillsFlow({ launch, openPanel, openSite, waitForComposer, sendPrompt, startNewChat, stopServiceWorker, fetchRequests, clearViolations, fetchViolations, log }) {
  const state = { variant: 'none', posts: [], csv: [] };
  const b = await launch('light', { args: OFFLINE_HOSTS });
  await holdExtensionTabs(b.ctx);
  await routeSites(b.ctx, state);
  let panel = null;
  try {
    await clearViolations();
    panel = await openPanel(b.ctx, b.extId);
    // This flow is about runs with no model behind them: a repair (a skill made here repairs by default,
    // and the mock counts as connected) has its own flow, scripts/lib/skills-model-flow.mjs.
    await panel.evaluate(async () => chrome.storage.local.set({ settings: { ...(await chrome.storage.local.get('settings')).settings, repairSkills: 'never' } }));
    const page = await openSite(b.ctx, 'https://expenses.example.com/expenses/new');
    await waitForComposer(panel);

    // New chat is off on a chat with nothing in it, which is where a new host opens.
    const fresh = async () => {
      await waitForComposer(panel);
      await panel.locator('.messages .empty, .messages .msg, .messages .note, .messages [data-testid="page-card"], .messages .tool').first().waitFor({ timeout: 60_000 });
      await sleep(250);
      if (!(await panel.locator('.messages .empty').count())) await startNewChat(panel);
    };
    const question = (kind) => panel.locator(`[data-testid="question"][data-question="${kind}"]`);
    const anyQuestion = panel.locator('[data-testid="question"]');
    const action = (name) => panel.locator(`[data-action="${name}"]`);
    const assistant = (text) => panel.locator('.messages .msg.assistant', { hasText: text });
    const rpc = async (p, req) => {
      const r = await p.evaluate((m) => chrome.runtime.sendMessage(m), req);
      if (!r?.ok) throw new Error(`rpc ${req.type}: ${r?.error}`);
      return r.data;
    };
    const stored = (p = panel) => p.evaluate(async () => (await chrome.storage.local.get('skills')).skills ?? []);
    const tabIdOf = (bb, urlStart) => bb.ctx.serviceWorkers()[0].evaluate(async (u) => (await chrome.tabs.query({})).find((t) => t.url?.startsWith(u))?.id, urlStart);
    const modelCalls = async () => (await fetchRequests()).length;

    /** The card on screen fits a 360px panel. The picture is for reading by eye. */
    const shotAt360 = async (name) => {
      const was = panel.viewportSize();
      await panel.setViewportSize({ width: 360, height: 780 });
      check(!(await panel.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)), `${name} fits at 360px`);
      if (process.env.SKILL_SHOT_DIR) await panel.screenshot({ path: path.join(process.env.SKILL_SHOT_DIR, name) });
      if (was) await panel.setViewportSize(was);
    };

    // ----- a. Record, compile, draft, save. The compiled file is compared byte for byte.
    const record = async ({ conv, name, description, url, start, fieldsAs = {}, outputs = {}, onHandoff }) => {
      await page.goto(url);
      await page.bringToFront();
      await fresh();
      await sendPrompt(panel, conv.prompt);
      const end = Date.now() + 90_000;
      for (;;) {
        if (await assistant(conv.done).count()) break;
        check(Date.now() < end, `the ${name} conversation finished`, await panel.locator('.messages').textContent());
        if (await anyQuestion.count()) {
          const kind = await anyQuestion.getAttribute('data-question');
          if (kind === 'operate' || kind === 'allow') await action('question-allow').click();
          else if (kind === 'handoff') {
            check(onHandoff, 'a handoff this recording did not expect');
            await onHandoff();
            await question('handoff').waitFor({ state: 'detached', timeout: 30_000 });
          } else fail(`an unexpected question: ${kind}`);
        }
        await sleep(80);
      }
      await action('save-as-skill').last().click();
      const card = panel.locator('[data-testid="save-card"]');
      await card.waitFor({ timeout: 10_000 });
      await card.locator('[data-testid="save-name"]').fill(name);
      await card.locator('[data-testid="save-description"]').fill(description);
      if (start) await card.locator('[data-testid="save-start"]').fill(start);
      for (const [label, how] of Object.entries(fieldsAs)) {
        const field = card.locator(`[data-testid="save-field"][data-label="${label}"]`);
        if (how.constant) await field.locator('[data-testid="save-as"]').selectOption('constant');
        if (how.name) await field.locator('[data-testid="save-input-name"]').fill(how.name);
        if (how.optional) await field.locator('[data-testid="save-input-optional"]').check();
      }
      for (const [selector, o] of Object.entries(outputs)) {
        const look = card.locator(`[data-testid="save-look"][data-selector="${selector}"]`);
        await look.locator('[data-testid="save-look-keep"]').check();
        await look.locator('[data-testid="save-look-name"]').fill(o.name);
        await look.locator('[data-testid="save-look-label"]').fill(o.label);
        await look.locator('[data-testid="save-look-take"]').selectOption(o.take);
        if (o.list) await look.locator('[data-testid="save-look-list"]').check();
      }
      for (const l of await card.locator('[data-testid="save-look"]').all()) {
        if (!outputs[await l.getAttribute('data-selector')]) await l.locator('[data-testid="save-look-keep"]').uncheck();
      }
      await shotAt360('skill-save-card-360.png');
      await card.locator('[data-testid="save-submit"]').click();
      await panel.locator('[data-testid="artifact"]', { hasText: name }).waitFor({ timeout: 10_000 });
      const artifactText = await panel.locator('[data-testid="artifact"]').textContent();
      check(/Draft skill/i.test(artifactText), 'the draft panel says it is a skill', artifactText);
      const chatIdNow = await panel.evaluate(async () => (await chrome.storage.local.get('chats')).chats?.[0]?.id);
      const artifact = await rpc(panel, { type: 'artifact.get', chatId: chatIdNow });
      const source = artifact.versions.at(-1).code;
      await panel.locator('[data-testid="artifact-save"]').click();
      await panel.locator('[data-testid="artifact-status"]', { hasText: 'Saved' }).waitFor({ timeout: 10_000 });
      const saved = (await stored()).find((s) => s.name === name);
      check(saved?.origin === 'local' && saved.walked === true && saved.allowedSteps.length === 0, 'a skill saved from a run is local and has nothing to walk', saved);
      return { source, id: saved.id };
    };

    const compare = (name, source, file) => {
      const want = read(file);
      const got = source.replace(today, 'on 2026-11-02 from');
      if (got !== want) {
        if (process.env.SKILLS_WRITE_EXPECTED) fs.writeFileSync(path.join(FIX, file), got);
        else fail(`${name} did not compile to ${file}, byte for byte.\n--- got\n${got}\n--- wanted\n${want}`);
      }
    };

    const expense = await record({
      conv: SKILLS.expense,
      name: 'File an expense',
      description: 'Fills the new-expense form from your inputs and stops before Submit so you press it.',
      url: 'https://expenses.example.com/expenses/new',
      fieldsAs: { Note: { optional: true } },
      onHandoff: async () => {
        await page.bringToFront();
        check((await page.inputValue('#merchant')) === 'Blue Bottle', 'the recording typed the merchant');
        await page.locator('#submit').click();
      },
    });
    compare('File an expense', expense.source, 'expense-form/expected.skill.md');
    check(!expense.source.includes('Blue Bottle') && !expense.source.includes('42.00') && !expense.source.includes('team lunch'), 'nothing typed is in the file', expense.source);
    const journal = await panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    const inRecord = (await stored()).find((s) => s.id === expense.id);
    check(!JSON.stringify(inRecord).includes('Blue Bottle'), 'nor in the record', inRecord);
    check(!/"kind":"act"[^}]*Blue Bottle/.test(journal), 'nor in the journal');

    state.csv.length = 0;
    const invoices = await record({
      conv: SKILLS.invoices,
      name: "Export this month's invoices",
      description: 'Filters the invoices page to this month, lists the invoice numbers and downloads the CSV.',
      url: 'https://billing.example.com/',
      fieldsAs: { Period: { constant: true } },
      outputs: { 'table tbody tr td.number': { name: 'invoices', label: 'Invoice numbers', take: 'text', list: true } },
    });
    compare("Export this month's invoices", invoices.source, 'export-invoices/expected.skill.md');

    const album = await record({
      conv: SKILLS.album,
      name: 'Album download links',
      description: 'Loads every photo in an album and collects the download links.',
      url: 'https://photos.example.com/albums/2026-kyoto',
      start: 'https://photos.example.com/albums/',
      outputs: { 'a.photo-download': { name: 'links', label: 'Download links', take: 'href', list: true } },
    });
    compare('Album download links', album.source, 'album-links/expected.skill.md');
    log('skills: a OK (three examples recorded, compiled byte for byte, and saved as local)');

    // ----- Probe S-a. A synthetic click on <a download> with no user activation, in Chromium.
    const downloads = [];
    const onDownload = (d) => downloads.push(d.suggestedFilename());
    page.on('download', onDownload);

    // ----- b. Replay, with the model never asked. The Mods row, the card, the rows, the bar, the outputs.
    await page.goto('https://expenses.example.com/expenses');
    await page.bringToFront();
    const callsBefore = await modelCalls();
    await panel.locator('[data-view="mods"]').first().click();
    const rowFor = (name) => panel.locator('[data-testid="skill-row"]', { has: panel.locator('h4', { hasText: name }) });
    await rowFor('File an expense').locator('[data-testid="skill-run-row"]').click();
    const runCard = panel.locator('[data-testid="skill-run-card"]');
    await runCard.waitFor({ timeout: 60_000 });
    const summary = await panel.locator('[data-testid="skill-run-summary"]').textContent();
    check(/6 steps on expenses\.example\.com · fills 3 fields · one step is yours/.test(summary), 'the run card computes what it will do', summary);
    check(!(await panel.locator('[data-testid="skill-run-first"]').count()), 'a skill made here does not walk');
    check(await panel.locator('[data-testid="skill-run"]').isDisabled(), 'RUN waits for the required inputs');
    await shotAt360('skill-run-card-360.png');
    const inp = (name) => panel.locator(`[data-testid="skill-run-input"][data-input="${name}"]`);
    await inp('merchant').fill('Corner Cafe');
    await inp('amount').fill('12.50');
    await panel.locator('[data-testid="skill-run"]').click();
    await question('handoff').waitFor({ timeout: 30_000 });
    const bar = await readBar(b.ctx, page);
    check(/your turn/i.test(bar.text), 'the bar hands over on Your turn', bar.text);
    check(bar.buttons['I HAVE DONE IT'] && !bar.buttons.ALLOW, 'with I have done it, and no Allow', bar);
    check((await page.inputValue('#merchant')) === 'Corner Cafe' && (await page.inputValue('#amount')) === '12.50' && (await page.inputValue('#note')) === '', 'the inputs were typed, and the empty optional was skipped');
    const rows = (await panel.locator('[data-testid="touched"] summary').allTextContents()).join(' | ');
    check(/1\/6 · went to \/expenses\/new/.test(rows) && /2\/6 · filled "Merchant"/.test(rows) && /skipped · no note/.test(rows), 'the rows are numbered, and name no value', rows);
    check(!rows.includes('Corner Cafe'), 'no row holds a value', rows);
    await page.locator('#submit').click();
    await panel.locator('[data-testid="page-card"]', { hasText: 'File an expense' }).last().waitFor({ timeout: 30_000 });
    check(state.posts.at(-1).body.includes('merchant=Corner'), 'the form went with the inputs', state.posts.at(-1));

    await page.goto('https://billing.example.com/invoices');
    await page.bringToFront();
    await fresh();
    state.csv.length = 0;
    downloads.length = 0;
    await panel.locator('[data-testid="empty-skill"]', { hasText: 'Export this month' }).click();
    await runCard.waitFor({ timeout: 60_000 });
    await panel.locator('[data-testid="skill-run"]').click();
    const card = panel.locator('[data-testid="page-card"]', { hasText: 'Export this month' }).last();
    await card.waitFor({ timeout: 30_000 });
    const out = await card.locator('[data-testid="page-card-output"]').textContent();
    check(/Invoice numbers · 3/.test(out) && /INV-2003/.test(out), 'the card carries the output', out);
    await sleep(800);
    const probeA = { clicked: true, fetched: state.csv.length, events: downloads.length };
    log(`skills: probe S-a: a synthetic click on <a download>: ${probeA.events} download event(s), ${probeA.fetched} request(s)`);
    page.off('download', onDownload);

    await page.goto('https://photos.example.com/albums/2026-kyoto');
    await page.bringToFront();
    await fresh();
    await panel.locator('[data-testid="composer-add"]').click();
    await panel.locator('[data-testid="menu-run-skill"]').click();
    await panel.locator('[data-testid="skill-picker"]').waitFor({ timeout: 5000 });
    await panel.locator('[data-testid="skill-pick"]', { hasText: 'Album download links' }).click();
    await runCard.waitFor({ timeout: 60_000 });
    await panel.locator('[data-testid="skill-run"]').click();
    const albumCard = panel.locator('[data-testid="page-card"]', { hasText: 'Album download links' }).last();
    await albumCard.waitFor({ timeout: 45_000 });
    const albumOut = await albumCard.locator('[data-testid="page-card-output"]').textContent();
    check(/Download links · 9/.test(albumOut) && /https:\/\/photos\.example\.com\/photos\/9\.jpg/.test(albumOut), 'the album output is all nine links', albumOut);
    await albumCard.locator('[data-action="output-csv"]').click();
    await albumCard.locator('[data-action="output-csv"]', { hasText: 'Copied' }).waitFor({ timeout: 5000 });
    // Written just after the card goes up, so on a loaded machine it can be a moment behind it.
    const readNote = () => panel.evaluate(async () => {
      const all = await chrome.storage.local.get(null);
      return Object.entries(all).find(([k, v]) => /:note$/.test(k) && typeof v === 'string' && v.includes('photos/9.jpg'))?.[1] ?? '';
    });
    let noteKey = await readNote();
    for (let i = 0; i < 30 && !noteKey; i++) {
      await sleep(500);
      noteKey = await readNote();
    }
    check(/Outputs of the skill/.test(noteKey), 'and goes to the chat’s note', noteKey);
    check(!noteKey.includes('Download links'), 'by its key: an author\'s label is not model input', noteKey);
    check((await modelCalls()) === callsBefore, 'nothing asked the model during the replays', { before: callsBefore, after: await modelCalls() });
    await shotAt360('skill-outputs-360.png');

    // Off its site, Run opens where it starts: the card says so, the chat is the site's, and the run lands there.
    await page.goto('https://expenses.example.com/expenses');
    await page.bringToFront();
    await panel.locator('[data-view="mods"]').first().click();
    const elsewhereRow = rowFor('Album download links');
    check(/runs on photos\.example\.com/.test(await elsewhereRow.locator('[data-testid="skill-row-meta"]').textContent()), 'the row says where it runs');
    await elsewhereRow.locator('[data-testid="skill-run-row"]').click();
    await panel.locator('[data-testid="skill-run-opens"]').waitFor({ timeout: 60_000 });
    await panel.locator('[data-testid="skill-run"]').click();
    await page.waitForURL('https://photos.example.com/albums/', { timeout: 30_000 });
    await panel.locator('[data-testid="page-card"]', { hasText: 'Album download links' }).last().waitFor({ timeout: 45_000 });
    check((await modelCalls()) === callsBefore, 'and the model is still not asked');
    log('skills: b OK (all three replay from the row, the empty state and the + menu, with the model never asked)');

    // ----- c. The stability matrix. Started through the same RPC the card sends, and stopped from the page's side.
    const matrix = [];
    const inputsFor = { 'expense-form': { merchant: 'M', amount: '1', note: 'n' }, 'export-invoices': {}, 'album-links': {} };
    const runVariant = async (fixture, skillId, url, variant) => {
      state.variant = variant;
      await page.goto(url);
      await page.evaluate(() => sessionStorage.removeItem('__wrong'));
      await page.bringToFront();
      const host = new URL(url).hostname;
      const chat = await rpc(panel, { type: 'chats.create', host });
      await rpc(panel, { type: 'skills.run', chatId: chat.id, tabId: await tabIdOf(b, `https://${host}`), skillId, inputs: inputsFor[fixture], allowSite: true });
      const total = (await stored()).find((s) => s.id === skillId).steps.length;
      let stopped = 0;
      let resolved = total;
      const end = Date.now() + 60_000;
      for (;;) {
        check(Date.now() < end, `${fixture}/${variant} finished`);
        const st = await rpc(panel, { type: 'agent.attach' });
        const q = st.questions?.[chat.id];
        if (q?.kind === 'skill-broken') {
          stopped = 1;
          resolved = q.n - 1;
          await panel.evaluate((id) => chrome.runtime.connect({ name: 'agent' }).postMessage({ type: 'abort', chatId: id }), chat.id);
          break;
        }
        if (q?.kind === 'handoff') await rpc(panel, { type: 'act.answer', chatId: chat.id, questionId: q.id, answer: { kind: 'done' } });
        else if (q) fail(`${fixture}/${variant} asked ${q.kind}: ${JSON.stringify(q)}`);
        if (!st.running[chat.id] && !q) break;
        await sleep(60);
      }
      await sleep(150);
      const wrong = Number(await page.evaluate(() => sessionStorage.__wrong || 0).catch(() => 0));
      matrix.push({ fixture, variant, resolved, total, stopped, wrong });
      state.variant = 'none';
    };
    const cases = [
      ['expense-form', expense.id, 'https://expenses.example.com/expenses/new'],
      ['export-invoices', invoices.id, 'https://billing.example.com/invoices'],
      ['album-links', album.id, 'https://photos.example.com/albums/2026-kyoto'],
    ];
    for (const [fixture, id, url] of cases) for (const variant of VARIANTS) await runVariant(fixture, id, url, variant);
    log('skills: matrix  fixture           variant         resolved  stopped  wrong element');
    for (const m of matrix) log(`skills: matrix  ${m.fixture.padEnd(17)} ${m.variant.padEnd(15)} ${`${m.resolved}/${m.total}`.padEnd(9)} ${String(m.stopped).padEnd(8)} ${m.wrong}`);
    check(matrix.every((m) => m.wrong === 0), 'wrong element is 0 on every variant', matrix.filter((m) => m.wrong));
    // The count can read something other than 0: a step on what the page marks wrong, answered yes.
    await panel.evaluate(async (s) => {
      const { skills = [] } = await chrome.storage.local.get('skills');
      await chrome.storage.local.set({ skills: [...skills, s] });
    }, { ...(await stored()).find((x) => x.id === album.id), id: 'control', name: 'Control', steps: [{ verb: 'click', target: 'button "Delete album"', at: { css: '#delete' } }] });
    await page.goto('https://photos.example.com/albums/2026-kyoto');
    await page.evaluate(() => sessionStorage.removeItem('__wrong'));
    await page.bringToFront();
    const controlChat = await rpc(panel, { type: 'chats.create', host: 'photos.example.com' });
    await rpc(panel, { type: 'skills.run', chatId: controlChat.id, tabId: await tabIdOf(b, 'https://photos.example.com'), skillId: 'control', inputs: {}, allowSite: true });
    await waitFor(async () => (await rpc(panel, { type: 'agent.attach' })).questions?.[controlChat.id]?.kind === 'allow', 'the control step to ask');
    const controlQ = (await rpc(panel, { type: 'agent.attach' })).questions[controlChat.id];
    await rpc(panel, { type: 'act.answer', chatId: controlChat.id, questionId: controlQ.id, answer: { kind: 'allow' } });
    await waitFor(async () => Number(await page.evaluate(() => sessionStorage.__wrong || 0)) > 0, 'the page to count a touch on what it marks wrong');
    await waitFor(async () => !(await rpc(panel, { type: 'agent.attach' })).running[controlChat.id], 'the control run to end');
    for (const m of matrix) if (m.variant === 'decoy' || m.variant === 'renamed-button' || m.variant === 'removed') check(m.stopped === 1, `${m.fixture}/${m.variant} must stop`, m);
    log('skills: c OK (wrong element is 0 on every variant; decoy, renamed-button and removed stop)');

    // ----- d. A skill's gate: skill-submit, a standing allowance for local only, and skill-never and skill-offsite.
    const forms = 'https://forms.example.com/';
    const openForms = async () => {
      await page.goto(forms);
      await page.bringToFront();
      await fresh();
    };
    const install = async (source, origin = 'imported') => {
      const before = new Set((await stored()).map((s) => s.id));
      await rpc(panel, { type: 'skills.install', source, origin });
      return (await stored()).find((s) => !before.has(s.id));
    };
    const force = (skill) => panel.evaluate(async (s) => {
      const { skills = [] } = await chrome.storage.local.get('skills');
      await chrome.storage.local.set({ skills: [...skills.filter((x) => x.id !== s.id), s] });
    }, skill);
    const runForms = async (id) => {
      await panel.locator('[data-testid="empty-skill"][data-skill-id="' + id + '"]').click();
      await runCard.waitFor({ timeout: 60_000 });
      await panel.locator('[data-testid="skill-run"]').click();
    };
    const submitSrc = handWritten('Submit payment', '- click: button "Submit payment"\n  at: { css: "#send", in: \'form "Pay"\' }\n  why: pay the bill');
    const imported = await install(submitSrc);
    check(imported.origin === 'imported' && imported.walked === false && imported.allowedSteps.length === 0, 'an imported skill must walk', imported);
    await openForms();
    state.posts.length = 0;
    await panel.locator('[data-testid="empty-skill"][data-skill-id="' + imported.id + '"]').click();
    await runCard.waitFor({ timeout: 60_000 });
    check(await panel.locator('[data-testid="skill-run-first"]').count(), 'the card says the first run walks');
    await panel.locator('[data-testid="skill-run"]').click();
    await question('allow').waitFor({ timeout: 30_000 });
    await shotAt360('skill-allow-360.png');
    const asked = await question('allow').textContent();
    check(/click button "Submit payment"/.test(asked) && /submits a form/.test(asked) && /step 1 of 1 of Submit payment/.test(asked) && /the skill says: pay the bill/.test(asked), 'the card reads from the live element and labels the skill’s words', asked);
    check(!state.posts.length, 'none without an answer', state.posts);
    check(!(await action('question-every').count()), 'an imported skill is offered no standing allowance');
    await action('question-decline').click();
    await panel.locator('[data-testid="page-card"]', { hasText: 'Submit payment' }).last().waitFor({ timeout: 20_000 });
    check(!state.posts.length, 'declined, nothing went', state.posts);
    check((await stored()).find((s) => s.id === imported.id).walked === false, 'a walk that stopped is not a walk');

    // Local: the same file, recorded here. Do not ask again holds, and Settings lists it, and an edit clears it.
    const localSkill = { ...imported, id: 'local-submit', name: 'Local payment', origin: 'local', walked: true, allowedSteps: [] };
    await force(localSkill);
    await openForms();
    await runForms('local-submit');
    await question('allow').waitFor({ timeout: 30_000 });
    check(/Do not ask again for this step/.test(await action('question-every').textContent()), 'a local skill is offered it');
    await action('question-every').click();
    await panel.locator('[data-testid="page-card"]', { hasText: 'Local payment' }).last().waitFor({ timeout: 20_000 });
    check(state.posts.filter((p) => p.url === '/pay').length === 1, 'allowed, exactly one post', state.posts);
    const kept = (await stored()).find((s) => s.id === 'local-submit').allowedSteps;
    check(kept.length === 1, 'the step is remembered on the skill', kept);
    await openForms();
    await runForms('local-submit');
    await panel.locator('[data-testid="page-card"]', { hasText: 'Local payment' }).last().waitFor({ timeout: 20_000 });
    check(!(await anyQuestion.count()) && state.posts.filter((p) => p.url === '/pay').length === 2, 'and no question the second time', state.posts);
    await panel.locator('[data-view="settings"]').first().click();
    await panel.locator('[data-testid="operating-steps"]', { hasText: 'Local payment' }).waitFor({ timeout: 10_000 });
    await panel.locator('[data-action="operating-step-remove"]').click();
    await panel.locator('[data-testid="operating-steps"]').waitFor({ state: 'detached', timeout: 10_000 });
    check((await stored()).find((s) => s.id === 'local-submit').allowedSteps.length === 0, 'Remove takes it off the skill');
    await force({ ...(await stored()).find((s) => s.id === 'local-submit'), allowedSteps: kept });
    await panel.locator('[data-view="chat"]').first().click();
    await waitForComposer(panel);
    await rpc(panel, { type: 'skills.save', id: 'local-submit', source: submitSrc.replace('pay the bill', 'pay it') });
    const edited = (await stored()).find((s) => s.id === 'local-submit');
    check(edited.origin === 'edited' && edited.walked === false && edited.allowedSteps.length === 0, 'a hand edit costs the walk and every allowance', edited);
    log('skills: d1 OK (skill-submit: one question from the live element, no answer no post; a standing allowance only for local, cleared by an edit)');

    // skill-never: refused at install; forced in by test, denied at run time.
    const neverSrc = handWritten('Type the password', '- fill: hunter2\n  into: textbox "Password"\n  at: { css: "#pw", in: \'form "Sign in"\' }');
    const refused = await rpc(panel, { type: 'skills.preview', source: neverSrc });
    check(!refused.ok && /password/i.test(JSON.stringify(refused.refusals)), 'a fill into a password field is refused at install', refused.refusals);
    const parsed = { ...imported, id: 'never', name: 'Never', origin: 'local', walked: true, allowedSteps: [], source: neverSrc, steps: [{ verb: 'fill', value: 'hunter2', target: 'textbox "Password"', at: { css: '#pw', in: 'form "Sign in"' } }] };
    await force(parsed);
    await openForms();
    await runForms('never');
    await panel.locator('.messages .error, .messages .msg.error', { hasText: 'step 1 was refused' }).first().waitFor({ timeout: 20_000 });
    check(/password/.test(await panel.locator('.messages').textContent()), 'and it says why');
    check((await page.inputValue('#pw')) === '', 'the field is empty');
    log('skills: d2 OK (skill-never: refused at install and denied at run time)');

    // skill-offsite: a go off site refused at install; forced, the gate refuses; a link off site pauses.
    const offsiteSrc = handWritten('Go away', '- go: https://elsewhere.example.org/landing');
    const offsite = await rpc(panel, { type: 'skills.preview', source: offsiteSrc });
    check(!offsite.ok, 'a go off its site is refused at install', offsite.refusals);
    await force({ ...imported, id: 'off-go', name: 'Off go', origin: 'local', walked: true, source: offsiteSrc, steps: [{ verb: 'go', to: 'https://elsewhere.example.org/landing' }] });
    await openForms();
    await runForms('off-go');
    await panel.locator('.messages', { hasText: 'step 1 was refused' }).waitFor({ timeout: 20_000 });
    check(page.url().startsWith(forms), 'the page stayed', page.url());
    await force({ ...imported, id: 'off-link', name: 'Off link', origin: 'local', walked: true, steps: [{ verb: 'click', target: 'link "Elsewhere"', at: { css: '#away' } }, { verb: 'wait', condition: { ms: 100 } }] });
    await openForms();
    await runForms('off-link');
    await question('left-site').waitFor({ timeout: 30_000 });
    await action('question-back').click();
    await panel.locator('[data-testid="page-card"]', { hasText: 'Off link' }).last().waitFor({ timeout: 30_000 });
    check(page.url().startsWith(forms), 'Go back came back', page.url());
    log('skills: d3 OK (skill-offsite: refused at install, denied by the gate, and a link off the site pauses)');

    // A run from elsewhere on the site lands on `start` first, shown as a step.
    await force({ ...imported, id: 'wander', name: 'Wander', origin: 'local', walked: true, steps: [{ verb: 'wait', condition: { ms: 50 } }] });
    await page.goto(`${forms}other`);
    await page.bringToFront();
    await fresh();
    await runForms('wander');
    await panel.locator('[data-testid="page-card"]', { hasText: 'Wander' }).last().waitFor({ timeout: 30_000 });
    check(page.url() === forms, 'it went to start first', page.url());
    check(/went to \//.test((await panel.locator('[data-testid="touched"] summary').allTextContents()).join(' | ')), 'and said so');

    // A sibling host its match covers and it names: not refused as leaving the site, and step 1 runs there.
    await force({ ...imported, id: 'sibling', name: 'Sibling', origin: 'local', walked: true, matches: ['*://*.example.com/*'], start: forms, steps: [{ verb: 'wait', condition: { ms: 50 } }] });
    await page.goto('https://billing.example.com/invoices');
    await page.bringToFront();
    await fresh();
    await runForms('sibling');
    await page.waitForURL(forms, { timeout: 30_000 });
    // Its card is in the chat it ran in. The panel follows the page's host once the run lets go, so it is read from storage.
    const siblingFinished = async () => panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)).includes('on the page · Sibling'));
    for (let i = 0; i < 60 && !(await siblingFinished()); i++) await sleep(500);
    check(await siblingFinished(), 'and every step was reached there', await panel.locator('.chat').textContent().catch(() => ''));

    // A start that redirects off its match: the run is pinned to `start`, so it pauses before any step.
    await force({ ...imported, id: 'redirected', name: 'Redirected', origin: 'local', walked: true, start: `${forms}redirect`, steps: [{ verb: 'wait', condition: { ms: 50 } }] });
    await page.goto('https://expenses.example.com/expenses');
    await page.bringToFront();
    await panel.locator('[data-view="mods"]').first().click();
    await rowFor('Redirected').locator('[data-testid="skill-run-row"]').click();
    await panel.locator('[data-testid="skill-run-opens"]').waitFor({ timeout: 60_000 });
    await panel.locator('[data-testid="skill-run"]').click();
    await question('left-site').waitFor({ timeout: 30_000 });
    // The page itself is a browser error here: a redirected request does not come back through the route.
    check(/forms\.example\.com[\s\S]*elsewhere\.example\.org/.test(await question('left-site').textContent()), 'the question names both', await question('left-site').textContent());
    check(!(await action('question-continue').count()), 'and another site is not one button away');
    await action('question-stop').click();
    // As with the sibling, the panel follows the page once the run lets go.
    await waitFor(() => panel.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)).includes('stopped by you · Redirected')), 'the run stopped where it paused');
    log('skills: d4 OK (a start on a sibling is on the site, and one that redirects away pauses before any step)');

    // Same-named siblings told apart only by position: a stop, on every run, so never the wrong one.
    await force({ ...imported, id: 'nth', name: 'Nth', origin: 'local', walked: true, steps: [{ verb: 'click', target: 'button "Edit"', at: { css: 'p > button.r:nth-of-type(2)', nth: 1 } }] });
    await openForms();
    await runForms('nth');
    await question('skill-broken').waitFor({ timeout: 30_000 });
    check(/2 elements match button "Edit"/.test(await question('skill-broken').textContent()), 'an ordinal alone stops', await question('skill-broken').textContent());
    await action('question-stop').click();
    await panel.locator('[data-testid="page-card"]', { hasText: 'Nth' }).last().waitFor({ timeout: 20_000 });

    // A broken step: CONTINUE FROM and TRY AGAIN.
    state.variant = 'removed';
    await page.goto('https://photos.example.com/albums/2026-kyoto');
    await page.bringToFront();
    await fresh();
    await panel.locator('[data-testid="empty-skill"]', { hasText: 'Album' }).click();
    await runCard.waitFor({ timeout: 60_000 });
    await panel.locator('[data-testid="skill-run"]').click();
    await question('skill-broken').waitFor({ timeout: 30_000 });
    await shotAt360('skill-broken-360.png');
    const brokenText = await question('skill-broken').textContent();
    check(/Stopped at 1 of 3/.test(brokenText) && /could not find button "Load more"/.test(brokenText), 'it says which step and why', brokenText);
    await action('question-try-again').click();
    await question('skill-broken').waitFor({ timeout: 30_000 });
    await action('question-continue-from').click();
    state.variant = 'none';
    const contCard = panel.locator('[data-testid="page-card"]', { hasText: 'Album download links' }).last();
    await contCard.waitFor({ timeout: 30_000 });
    check(/you did 1 yourself/.test(await contCard.textContent()), 'a step done by hand is the user’s on the card', await contCard.textContent());
    log('skills: d4 OK (an ordinal stops; broken step: try again, continue from, journalled as the user’s)');

    // ----- e. Resume never replays. The worker stops between the journal's write and the result.
    let slowPosts = 0;
    await b.ctx.route('https://forms.example.com/slow', (route) => {
      slowPosts++;
      return route.fulfill({ status: 200, body: 'ok' });
    });
    await force({ ...imported, id: 'slow', name: 'Slow', origin: 'local', walked: true, steps: [{ verb: 'click', target: 'button "Process it"', at: { css: '#slow' }, repeat: 3 }, { verb: 'wait', condition: { ms: 50 } }] });
    await openForms();
    await runForms('slow');
    await waitFor(() => slowPosts === 1, 'the step reached the server');
    const killed = await stopServiceWorker(b.ctx, panel);
    if (!killed) log('skills: e SKIPPED: this Chromium would not stop the service worker over CDP');
    else {
      await panel.locator('[data-testid="resume-row"]').waitFor({ timeout: 30_000 });
      const pendingText = await panel.locator('[data-testid="resume-pending"]').textContent();
      check(/may or may not have happened: click button "Process it"/.test(pendingText) && /ask you/.test(pendingText), 'the Resume block says what may have happened', pendingText);
      const record = await panel.evaluate(async () => (await chrome.storage.local.get('runs')).runs ?? {});
      const rec = Object.values(record).find((r) => r.skill?.id === 'slow');
      check(rec?.pending?.kind === 'skill' && rec.skill.step === 0, 'the record names the skill, the step and that it was in flight', rec);
      await sleep(1200);
      check(slowPosts === 1, 'nothing resumed by itself', slowPosts);
      await page.bringToFront();
      await panel.locator('[data-action="resume"]').click();
      await question('did-happen').waitFor({ timeout: 30_000 });
      await shotAt360('skill-did-happen-360.png');
      const did = await question('did-happen').textContent();
      check(/Did this happen\?/.test(did) && /click button "Process it"/.test(did) && /continue from 2/i.test(did), 'the card asks', did);
      check(slowPosts === 1, 'and has not replayed it', slowPosts);
      await action('question-it-did').click();
      await panel.locator('[data-testid="page-card"]', { hasText: 'Slow' }).last().waitFor({ timeout: 30_000 });
      check(slowPosts === 1, 'IT DID continues past it without running it', slowPosts);
      const after = await panel.evaluate(async () => (await chrome.storage.local.get('runs')).runs ?? {});
      check(!Object.values(after).some((r) => r.pending), 'the journal is clear', after);
      // DO IT AGAIN goes back through the gate.
      await openForms();
      await runForms('slow');
      await waitFor(() => slowPosts === 2, 'the step reached the server again');
      check(await stopServiceWorker(b.ctx, panel), 'the worker stops again');
      await panel.locator('[data-testid="resume-row"]').waitFor({ timeout: 30_000 });
      await page.bringToFront();
      await panel.locator('[data-action="resume"]').click();
      await question('did-happen').waitFor({ timeout: 30_000 });
      await action('question-do-again').click();
      await panel.locator('[data-testid="page-card"]', { hasText: 'Slow' }).last().waitFor({ timeout: 30_000 });
      check(slowPosts >= 3, 'DO IT AGAIN does it', slowPosts);
      log('skills: e OK (a pending step is asked about, never replayed; IT DID goes past it and DO IT AGAIN goes through the gate)');
    }

    // ----- f. Stop from the panel, between repeats, and the wording on the bar.
    state.variant = 'none';
    await force({ ...imported, id: 'waiter', name: 'Waiter', origin: 'local', walked: true, steps: [{ verb: 'wait', condition: { selector: '#never-there', state: 'attached' }, timeoutMs: 20000 }] });
    await openForms();
    await runForms('waiter');
    await waitFor(async () => /usermods is running Waiter · 1 of 1/.test((await readBar(b.ctx, page)).text), 'the bar says it is running');
    check(/running Waiter · 1 of 1/.test(await panel.locator('.activity').textContent()), 'and so does the line', await panel.locator('.activity').textContent());
    await panel.locator('.activity .activity-action').click();
    await panel.locator('[data-testid="page-card"]', { hasText: 'stopped by you' }).last().waitFor({ timeout: 20_000 });
    await waitFor(async () => !(await readBar(b.ctx, page)).up, 'the bar comes down');
    log('skills: f OK (the bar and the line say running, and Stop stops it)');

    // The dashboard: the badge, the filter and the count.
    const dash = await b.ctx.newPage();
    await dash.goto(`chrome-extension://${b.extId}/dashboard.html#chats`);
    await dash.locator('[data-testid="chat-kind"]').selectOption('ran');
    await dash.locator('[data-testid="chat-ran-skill"]', { hasText: 'ran Waiter' }).first().waitFor({ timeout: 60_000 });
    check(/skills/.test(await dash.locator('[data-testid="overview"]').textContent()), 'the overview counts skills');
    await dash.close();
    await panel.bringToFront();

    const violations = await fetchViolations();
    check(!violations.length, 'every request the mock saw was valid', violations.slice(0, 3));

    // ----- g. Share, install in a second profile, run. The first run there walks; the second does not.
    await shareInstallRun({ b, panel, expenseId: expense.id, launch, openPanel, openSite, waitForComposer, rpc, stored, log, modelCalls, routeSites });

    // ----- h. No model connected at all.
    await noModel({ launch, openSite, waitForComposer, routeSites, sources: { expense: expense.source, invoices: invoices.source, album: album.source }, modelCalls, log });

    log(`skills flow ok ${JSON.stringify({ matrix, probeA })}`);
  } catch (e) {
    // What the panel showed when it went wrong: under load a timeout says little by itself.
    if (panel) {
      await panel.screenshot({ path: path.join(process.env.SKILL_SHOT_DIR ?? '/tmp', 'skills-failed.png') }).catch(() => {});
      log(`skills: the panel read: ${(await panel.locator('.chat').textContent().catch(() => '')).slice(-1500)}`);
    }
    throw e;
  } finally {
    await b.close();
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

/** The gist road: filled, pressed by the user, recorded; the raw link in a profile that has never seen it. */
async function shareInstallRun({ b, panel, expenseId, launch, openPanel, openSite, waitForComposer, rpc, stored, log, modelCalls, routeSites }) {
  const USER = 'smokeuser';
  const gists = new Map();
  // The worker was stopped on purpose above, so the wrapper has to go on the one running now.
  await holdExtensionTabs(b.ctx);
  await b.ctx.route('https://gist.github.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (req.method() === 'POST') {
      const form = new URLSearchParams(req.postData() ?? '');
      const names = form.getAll('gist[contents][][name]');
      const values = form.getAll('gist[contents][][value]');
      const id = `${(gists.size + 1).toString(16)}${'c'.repeat(31)}`;
      gists.set(id, { files: names.map((name, i) => ({ name, content: values[i] ?? '' })) });
      return route.fulfill({ status: 302, headers: { location: `https://gist.github.com/${USER}/${id}` } });
    }
    if (u.pathname === '/' || u.pathname === '/new') return route.fulfill(html(gistEditorPage({ mode: 'new', variant: 'default' })));
    const m = u.pathname.match(/^\/smokeuser\/([0-9a-f]+)$/);
    if (m && gists.get(m[1])) return route.fulfill(html(gistViewPage({ user: USER, id: m[1], files: gists.get(m[1]).files })));
    return route.fulfill(html('<title>Not found</title>', 404));
  });
  await panel.bringToFront();
  await panel.locator('[data-view="mods"]').first().click();
  const row = panel.locator('[data-testid="skill-row"]', { has: panel.locator('h4', { hasText: 'File an expense' }) });
  await row.locator('[data-testid="skill-export"]').click();
  const [tab] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 60_000 }), panel.locator('[data-testid="skill-export-menu"] [data-testid="export-gist"]').click()]);
  await tab.waitForLoadState('domcontentloaded');
  await tab.locator('.js-gist-filename').waitFor({ timeout: 60_000 });
  await tab.waitForFunction(() => document.querySelector('.js-gist-filename')?.value?.endsWith('.skill.md'), null, { timeout: 60_000 });
  await tab.locator('button', { hasText: 'Create secret gist' }).click();
  await tab.waitForURL(/gist\.github\.com\/smokeuser\//, { timeout: 60_000, waitUntil: "domcontentloaded" });
  const gistId = [...gists.keys()][0];
  const published = gists.get(gistId).files[0];
  check(published.name === 'file-an-expense.skill.md', 'the gist holds the skill', published.name);
  check(!published.content.includes('Blue Bottle'), 'with nothing typed in it');
  const raw = `https://gist.githubusercontent.com/${USER}/${gistId}/raw/${published.name}`;
  await tab.close();
  check((await stored()).find((s) => s.id === expenseId).origin === 'local', 'sharing a version bump keeps it local');

  const b2 = await launch('light', { args: OFFLINE_HOSTS });
  try {
    await routeSites(b2.ctx, { variant: 'none', posts: [], csv: [] });
    await b2.ctx.route('https://gist.githubusercontent.com/**', (r) => r.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: published.content }));
    const panel2 = await openPanel(b2.ctx, b2.extId);
    const page = await b2.ctx.newPage();
    await page.goto(raw).catch(() => {});
    await page.waitForURL(/install\.html#/, { timeout: 60_000, waitUntil: "domcontentloaded" });
    await page.locator('[data-testid="skill-install"]').click();
    await page.locator('.card.hero', { hasText: 'Installed' }).waitFor({ timeout: 60_000 });
    const installed = (await stored(panel2))[0];
    check(installed.origin === 'installed' && installed.walked === false && installed.allowedSteps.length === 0, 'installed from a link, it must walk', installed);

    const site = await openSite(b2.ctx, 'https://expenses.example.com/expenses/new');
    await panel2.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposer(panel2);
    await panel2.locator('[data-testid="empty-skill"]').first().click();
    await panel2.locator('[data-testid="skill-run-card"]').waitFor({ timeout: 60_000 });
    check(await panel2.locator('[data-testid="skill-run-first"]').count(), 'the card says the first run walks');
    check(await panel2.locator('[data-testid="skill-run-operate"]').count(), 'and asks about the site in one card');
    await panel2.locator('[data-testid="skill-run-input"][data-input="merchant"]').fill('Second Profile');
    await panel2.locator('[data-testid="skill-run-input"][data-input="amount"]').fill('3');
    await panel2.locator('[data-testid="skill-run"]').click();
    const q = (kind) => panel2.locator(`[data-testid="question"][data-question="${kind}"]`);
    // Every step is shown before it happens.
    await q('walk').waitFor({ timeout: 30_000 });
    check(/Step 1 of 6/.test(await q('walk').textContent()), 'the walk starts at step 1', await q('walk').textContent());
    check(!(await panel2.locator('[data-testid="question-standing"]').count()), 'nothing asks about the site again');
    await panel2.locator('[data-action="question-next"]').click();
    for (const headline of ['textbox "Merchant"', 'textbox "Amount"']) {
      await q('walk').filter({ hasText: headline }).waitFor({ timeout: 30_000 });
      if (headline.includes('Merchant')) check((await site.inputValue('#merchant')) === '', 'nothing is typed before NEXT');
      await panel2.locator('[data-action="question-next"]').click();
    }
    // Note is empty: skipped. The wait, then Your turn.
    await q('walk').filter({ hasText: 'wait' }).waitFor({ timeout: 30_000 });
    await panel2.locator('[data-action="question-rest"]').click();
    await q('handoff').waitFor({ timeout: 30_000 });
    await site.bringToFront();
    await site.locator('#submit').click();
    await panel2.locator('[data-testid="page-card"]', { hasText: 'File an expense' }).last().waitFor({ timeout: 30_000 });
    check((await stored(panel2))[0].walked === true, 'a complete walk is written down');
    // The update check goes through the review screen; a new version clears the walk.
    const bumped = published.content.replace('version: 1.0.0', 'version: 9.0.0');
    await rpc(panel2, { type: 'skills.install', source: bumped, origin: 'installed', downloadUrl: raw, replaceId: installed.id });
    check((await stored(panel2))[0].walked === false, 'an update starts the walk over');
    log('skills: g OK (share, install in a second profile, walk, run; an update clears the walk)');
  } finally {
    await b2.close();
  }
  await panel.locator('[data-view="chat"]').first().click();
  void modelCalls;
}

/** A profile with no connection at all: a skill still installs and runs, start to finish. */
async function noModel({ launch, openSite, waitForComposer, routeSites, sources, modelCalls, log }) {
  const b3 = await launch('light', { args: OFFLINE_HOSTS });
  const state = { variant: 'none', posts: [], csv: [] };
  try {
    await routeSites(b3.ctx, state);
    const before = await modelCalls();
    // A profile that has never had a provider: nothing seeded but the first-run notice, acknowledged.
    const panel = await b3.ctx.newPage();
    await panel.goto(`chrome-extension://${b3.extId}/sidepanel.html`, { waitUntil: 'domcontentloaded' });
    await panel.evaluate(() => chrome.storage.local.set({ consent: { version: 1, acceptedAt: Date.now() } }));
    for (const source of Object.values(sources)) {
      const r = await panel.evaluate((src) => chrome.runtime.sendMessage({ type: 'skills.install', source: src, origin: 'imported' }), source);
      check(r?.ok, 'it installs with no model', r);
    }
    const page = await openSite(b3.ctx, 'https://photos.example.com/albums/2026-kyoto');
    await panel.reload({ waitUntil: 'domcontentloaded' });
    await waitForComposer(panel);
    await panel.locator('.composer textarea').fill('hello');
    const send = panel.locator('.composer .cbtn.send');
    // The panel reads its connections after it paints.
    await panel.locator('.composer .cbtn.send[disabled]').waitFor({ timeout: 60_000 });
    check(/Connect a provider/.test(await send.getAttribute('title')), 'and it says why', await send.getAttribute('title'));
    await panel.locator('.composer textarea').fill('');
    await panel.locator('[data-testid="empty-skill"]').first().click();
    await panel.locator('[data-testid="skill-run"]').click();
    await panel.locator('[data-testid="question"][data-question="walk"]').waitFor({ timeout: 30_000 });
    await panel.locator('[data-action="question-rest"]').click();
    const card = panel.locator('[data-testid="page-card"]', { hasText: 'Album download links' }).last();
    await card.waitFor({ timeout: 45_000 });
    check(/Download links · 9/.test(await card.locator('[data-testid="page-card-output"]').textContent()), 'it ran to the end and read the links');
    // A second run does not walk.
    await page.reload();
    await page.bringToFront();
    const walked = await panel.evaluate(async () => (await chrome.storage.local.get('skills')).skills.find((s) => s.name === 'Album download links').walked);
    check(walked === true, 'and it is walked', walked);
    check((await modelCalls()) === before, 'and not one request reached a model', { before, after: await modelCalls() });
    log('skills: h OK (with no model connected a skill installs, walks and runs to its outputs)');
  } finally {
    await b3.close();
  }
}
