// Follow the Chrome Web Store reviewer's test instructions against the STORE build, from a fresh
// profile, the way a reviewer meets it: no seeded settings, no test ids, only the words on screen.
//
//   npm run reviewer-walkthrough        (builds the store package first)
//
// The instructions in docs/store/reviewer-notes.md name buttons and fields by their visible text. A
// label that drifts from those words is a reviewer who cannot get the extension working, and the
// rejection for that ("functionality not working") costs a review cycle. The smoke flows cannot
// catch it: they run the test build, seed their settings through storage and find things by test id.
//
// It starts where a reviewer starts: a fresh install with "Allow User Scripts" off. It checks the
// extension says so, turns the toggle on through chrome://extensions under the service worker that
// is already running (no restart, as for a person), and then does the whole test for real: the
// scripted model (scripts/mock-llm.mjs) runs its script on the page, proposes it, and the saved mod
// is applied again when the page is reloaded.
//
// The toggle is an ordinary control on an ordinary page, so it can be clicked. That a fresh install
// worked at all after turning it on is exactly what this caught failing on 2026-09-30, in the
// package that had been submitted: see readProbe in lib/exec/engine.ts and prepareEngine in
// entrypoints/background.ts.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, '.output', 'store-chrome-mv3');
const PORT = Number(process.env.MOCK_LLM_PORT ?? 8797);
const BASE_URL = `http://127.0.0.1:${PORT}/v1`;
const PAGE_URL = 'https://en.wikipedia.org/wiki/Common_kingfisher';
/** A model id the mock does not list, as the reviewer's is typed rather than picked. */
const MODEL = 'review-model';

/** A script installed BEFORE the toggle is turned on, to prove it gets registered afterwards. */
const SEED_URL = 'https://example.com/';
const SEED = `// ==UserScript==
// @name Seeded before the toggle
// @match https://example.com/*
// ==/UserScript==
document.documentElement.setAttribute('data-usermods-seed', '1');`;

const log = (...a) => console.log('[reviewer-walkthrough]', ...a);
const fail = (m) => {
  throw new Error(`reviewer-walkthrough: ${m}`);
};

async function startMock() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-llm.mjs'), String(PORT)], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('mock-llm did not start in time')), 10_000);
    child.stdout.on('data', (b) => {
      if (String(b).includes('listening')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`mock-llm exited early with code ${code}`)));
  });
  return child;
}

async function main() {
  const manifestPath = path.join(EXT_DIR, 'manifest.json');
  if (!fs.existsSync(manifestPath)) fail(`no store build at ${EXT_DIR}; run it through "npm run reviewer-walkthrough"`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  log(`store build ${manifest.version}`);

  const mock = await startMock();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-reviewer-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    headless: true,
    channel: 'chromium',
    viewport: { width: 420, height: 820 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  try {
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20_000 });
    const extId = new URL(sw.url()).host;

    // The panel, opened as a tab: an automated profile has no way to click the toolbar icon.
    const panel = await ctx.newPage();
    await panel.goto(`chrome-extension://${extId}/sidepanel.html`);

    // "Accept the notice."
    await panel.getByRole('button', { name: 'I understand', exact: true }).click({ timeout: 15_000 });
    log('first-run notice accepted');

    // A fresh install has the toggle off, and the extension has to say so itself.
    const notice = panel.locator('.notice', { hasText: 'Allow User Scripts' });
    await notice.waitFor({ timeout: 15_000 });
    log('toggle off: the setup banner is shown');

    // Someone who installs a script before finding the toggle: it is saved, and cannot run yet.
    const seeded = await panel.evaluate((source) => chrome.runtime.sendMessage({ type: 'mods.install', source }), SEED);
    if (!seeded?.ok) fail(`could not install the seed script with the toggle off: ${JSON.stringify(seeded)}`);

    // "chrome://extensions > usermods > Details > turn on Allow User Scripts."
    const ext = await ctx.newPage();
    await ext.goto(`chrome://extensions/?id=${extId}`);
    const toggle = ext.locator('#allow-user-scripts').getByRole('button');
    await toggle.click({ timeout: 15_000 });
    // Nothing is clicked in the panel: it keeps asking while the banner shows, and clears it itself.
    await notice.waitFor({ state: 'detached', timeout: 15_000 });
    log('toggle on: the banner is gone, with no restart');

    // The script saved while the toggle was off is registered now, with nothing saved since.
    const seedPage = await ctx.newPage();
    const seedRan = async () => {
      await seedPage.goto(SEED_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return seedPage.waitForFunction(() => document.documentElement.getAttribute('data-usermods-seed') === '1', null, { timeout: 10_000 }).then(() => true, () => false);
    };
    if (!(await seedRan())) fail('a script installed before the toggle was turned on did not run afterwards');
    log('a script installed before the toggle runs now');

    // Off and on again, under the same worker: still working, and the panel says so in between.
    await toggle.click();
    await panel.evaluate(() => window.dispatchEvent(new Event('focus')));
    await notice.waitFor({ timeout: 15_000 });
    await toggle.click();
    await notice.waitFor({ state: 'detached', timeout: 15_000 });
    if (!(await seedRan())) fail('after turning the toggle off and on again the installed script no longer runs');
    await seedPage.close();
    await ext.close();
    log('toggle off and on again: the banner came back and went, and the script still runs');

    // "Settings > Add provider > Custom OpenAI API. Paste Base URL and API key."
    await panel.getByRole('button', { name: 'Settings', exact: true }).click();
    await panel.getByText('Add provider', { exact: true }).waitFor({ timeout: 10_000 });
    const presets = await panel.locator('[data-testid="add-provider"]').allTextContents();
    if (presets.some((p) => /chatgpt|supergrok|subscription/i.test(p))) fail(`the store build offers a subscription preset: ${JSON.stringify(presets)}`);
    await panel.getByRole('button', { name: 'Custom OpenAI API', exact: true }).click();
    const baseUrl = panel.getByLabel('Base URL');
    await baseUrl.waitFor({ timeout: 10_000 });
    if ((await baseUrl.inputValue()) !== 'http://localhost:') fail(`Base URL starts as ${JSON.stringify(await baseUrl.inputValue())}, the notes say http://localhost:`);
    await baseUrl.fill(BASE_URL);
    await panel.getByLabel('API key').fill('reviewer-test-key');
    await panel.getByLabel('API key').blur();
    // It autosaves; there is no Save button to click.
    await panel.waitForFunction(
      async (url) => {
        const { connections } = await chrome.storage.local.get('connections');
        return (connections?.list ?? []).some((c) => c.baseUrl === url && c.apiKey === 'reviewer-test-key');
      },
      BASE_URL,
      { timeout: 10_000 },
    );
    log(`provider saved (presets offered: ${presets.join(', ')})`);

    // The page under test, made the active tab so the panel targets it.
    const site = await ctx.newPage();
    await site.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await site.bringToFront();

    // "Chat > click 'Pick a model', type the model name, press Enter."
    await panel.getByRole('button', { name: 'Chat', exact: true }).click();
    const pick = panel.getByRole('button', { name: /Pick a model/ });
    await pick.click({ timeout: 15_000 });
    await panel.getByLabel('Filter models, or type a model id').fill(MODEL);
    await panel.keyboard.press('Enter');
    await panel.getByRole('button', { name: new RegExp(`^Model: ${MODEL}`) }).waitFor({ timeout: 10_000 });
    log(`model "${MODEL}" chosen by typing it`);

    // "Send: hide the table of contents."
    const tocShown = () => site.evaluate(() => getComputedStyle(document.querySelector('.vector-column-start')).display !== 'none');
    if (!(await tocShown())) fail('the table of contents is already hidden before anything ran; the page changed and this check proves nothing');
    const composer = panel.getByPlaceholder('What should this page do differently?');
    await composer.fill('hide the table of contents');
    await composer.press('Enter');
    const save = panel.getByRole('button', { name: 'Save & enable', exact: true });
    await save.waitFor({ timeout: 60_000 });
    if (!(await panel.getByRole('button', { name: 'Run once', exact: true }).first().isVisible())) fail('the proposal card has no "Run once" button');
    // The model's trial run really ran on the page, and the card does not carry the untested line.
    if (await tocShown()) fail('run_script reported back but the table of contents is still showing');
    if (await panel.locator('.card .label.untested').count()) fail('the proposal is marked "not tested on this page" although the run succeeded');
    const failedCalls = await panel.locator('.messages .tool summary .dot.error').count();
    if (failedCalls) fail(`${failedCalls} tool call(s) failed in the transcript`);
    log('the model inspected the page, ran its script there, and proposed a tested mod');

    // "Click 'Save & enable'."
    await save.click();
    await panel.getByRole('button', { name: 'Saved · enabled', exact: true }).waitFor({ timeout: 10_000 });
    const mods = await panel.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? []);
    const saved = mods.find((m) => m.name !== 'Seeded before the toggle');
    if (mods.length !== 2 || !saved?.enabled) fail(`expected the seed and one new enabled mod after saving, got ${JSON.stringify(mods.map((m) => ({ name: m.name, enabled: m.enabled })))}`);
    log(`saved and enabled: ${saved.name}`);

    // "Reload." The saved mod is registered, so the change is there on a fresh load with nobody asking.
    await site.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await site.waitForFunction(() => getComputedStyle(document.querySelector('.vector-column-start')).display === 'none', null, { timeout: 15_000 }).catch(() => fail('after a reload the saved mod did not run: the table of contents is back'));
    log('after a reload the mod applies by itself');

    // Mods > Delete, which the longer notes mention for cleaning up.
    await panel.getByRole('button', { name: /^Mods/ }).click();
    panel.once('dialog', (d) => void d.accept());
    await panel.locator('.card', { hasText: saved.name }).getByRole('button', { name: 'Delete', exact: true }).click({ timeout: 10_000 });
    await panel.waitForFunction(async (name) => !((await chrome.storage.local.get('mods')).mods ?? []).some((m) => m.name === name), saved.name, { timeout: 10_000 });
    await site.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    await site.waitForTimeout(1500);
    if (!(await tocShown())) fail('the mod was deleted but still runs after a reload');
    log('deleted from the Mods tab, and gone from the page after a reload');

    log('ok: every step in the reviewer instructions matched the store build');
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
    mock.kill();
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
