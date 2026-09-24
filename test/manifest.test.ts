// The per-browser manifest. A build-time decision, so it is a pure function and tested as one
// rather than by unzipping an artifact.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { CHROME_MIN_VERSION, POPUP_PATH, SAFARI_MIN_VERSION, SAFARI_ONLY_ICON_SIZES, actionFor, buildManifest, isSafariOnlyIcon, isSafariTarget, permissionsFor } from '../lib/manifest.ts';

test('only safari is the safari target', () => {
  assert.equal(isSafariTarget('safari'), true);
  for (const b of ['chrome', 'firefox', 'edge', 'chromium', '']) assert.equal(isSafariTarget(b), false);
});

test('safari is not asked for permissions it does not have', () => {
  const safari = permissionsFor('safari');
  // Both would be an unknown permission in a package that has to load cleanly, and WebKit has
  // shipped neither: see docs/browsers.md for the API-by-API check.
  assert.ok(!safari.includes('userScripts'));
  assert.ok(!safari.includes('sidePanel'));
  for (const p of ['storage', 'scripting', 'tabs', 'declarativeNetRequest']) {
    assert.ok(safari.includes(p), `safari still needs ${p}`);
  }
});

test('chrome keeps every permission it shipped with', () => {
  const chrome = permissionsFor('chrome');
  for (const p of ['sidePanel', 'storage', 'scripting', 'tabs', 'declarativeNetRequest', 'userScripts']) {
    assert.ok(chrome.includes(p), `chrome must keep ${p}`);
  }
});

test('safari gets a toolbar popup and chrome does not', () => {
  // Safari has no side panel, so the popup is the surface. On Chrome a popup would replace the panel
  // the action click opens, which is a downgrade there.
  assert.equal(actionFor('safari').default_popup, POPUP_PATH);
  assert.equal(actionFor('chrome').default_popup, undefined);
});

test('the action keeps one title and its four icon sizes on both', () => {
  // The same tooltip on both, so the toolbar button is the same button.
  assert.equal(actionFor('safari').default_title, actionFor('chrome').default_title);
  for (const b of ['safari', 'chrome']) {
    const a = actionFor(b);
    assert.equal(a.default_title, 'Open usermods');
    assert.deepEqual(Object.keys(a.default_icon!).sort(), ['128', '16', '32', '48']);
  }
});

test('each build states its own minimum and not the other one', () => {
  const chrome = buildManifest('chrome');
  const safari = buildManifest('safari');
  assert.equal(chrome.minimum_chrome_version, CHROME_MIN_VERSION);
  assert.equal(chrome.browser_specific_settings, undefined);
  assert.equal(safari.minimum_chrome_version, undefined);
  // 16.4 is where Safari got the MV3 service-worker background. The rest of what the Safari build
  // uses bottoms out at 15.4; the background is the binding constraint.
  assert.equal(safari.browser_specific_settings?.safari?.strict_min_version, SAFARI_MIN_VERSION);
});

test('what both builds share is shared', () => {
  const chrome = buildManifest('chrome');
  const safari = buildManifest('safari');
  for (const m of [chrome, safari]) {
    assert.equal(m.name, 'usermods');
    assert.deepEqual(m.host_permissions, ['<all_urls>']);
    assert.equal(m.options_ui?.page, 'dashboard.html');
    assert.equal(m.options_ui?.open_in_tab, true);
    assert.deepEqual(m.web_accessible_resources?.[0]?.resources, ['install.html']);
  }
});

test('the chrome manifest keeps the key order it shipped with', () => {
  // Not pedantry. The Chrome build's manifest.json is a committed, reviewed artifact, and moving the
  // manifest out of wxt.config.ts was supposed to leave it byte for byte what it was. Key order is
  // the only part of that a pure test can hold on to, so it holds on to it.
  assert.deepEqual(Object.keys(buildManifest('chrome')), [
    'name',
    'description',
    'permissions',
    'host_permissions',
    'action',
    'options_ui',
    'minimum_chrome_version',
    'web_accessible_resources',
  ]);
  assert.deepEqual(Object.keys(buildManifest('safari')), [
    'name',
    'description',
    'permissions',
    'host_permissions',
    'action',
    'options_ui',
    'web_accessible_resources',
    'browser_specific_settings',
  ]);
});

test('no build asks for a permission twice', () => {
  for (const b of ['chrome', 'safari', 'firefox']) {
    const p = permissionsFor(b);
    assert.equal(new Set(p).size, p.length, `${b} lists a permission twice`);
  }
});

test('the large icon renders are Safari-only, so the Chrome package is unchanged', () => {
  // 256 and 512 exist for Safari's Extensions list, which draws the mark large enough that
  // upscaling the 128 would show the blur. Chrome has no surface that picks either size, and its
  // manifest.json is a committed artifact with a test pinning its shape, so the files are filtered
  // out of the non-Safari packages by the build:publicAssets hook in wxt.config.ts rather than
  // being listed for everyone.
  assert.deepEqual(SAFARI_ONLY_ICON_SIZES, [256, 512]);
  for (const size of SAFARI_ONLY_ICON_SIZES) {
    assert.equal(isSafariOnlyIcon(`icon/${size}.png`), true, `icon/${size}.png should be Safari-only`);
  }
  // The five every target ships stay put. Filtering one of these would leave Chrome's toolbar
  // button without the render it names in action.default_icon.
  for (const size of [16, 32, 48, 96, 128]) {
    assert.equal(isSafariOnlyIcon(`icon/${size}.png`), false, `icon/${size}.png must ship everywhere`);
  }
  // Only icon paths, and only exact ones: a hook that matched loosely would drop real assets.
  for (const path of ['theme-boot.js', 'icon/128x128.png', 'assets/256.png', 'icon/256.png.map', '']) {
    assert.equal(isSafariOnlyIcon(path), false, `${path} is not a Safari-only icon`);
  }
});

test('the hook that drops them is actually wired to the build', async () => {
  // isSafariOnlyIcon is only useful if something calls it. This is the kind of wiring that fails by
  // doing nothing: the files simply ship everywhere again and the manifest quietly grows two keys.
  // So run the real build:publicAssets hook from wxt.config.ts on a file list, per target.
  const config = (await import('../wxt.config.ts')).default as {
    hooks: { 'build:publicAssets': (wxt: unknown, files: { relativeDest: string }[]) => void };
  };
  const hook = config.hooks['build:publicAssets'];
  const files = () => ['icon/16.png', 'icon/128.png', 'icon/256.png', 'icon/512.png', 'theme-boot.js'].map((relativeDest) => ({ relativeDest }));

  const chrome = files();
  hook({ config: { browser: 'chrome' } }, chrome);
  assert.deepEqual(chrome.map((f) => f.relativeDest), ['icon/16.png', 'icon/128.png', 'theme-boot.js']);

  const safari = files();
  hook({ config: { browser: 'safari' } }, safari);
  assert.deepEqual(safari.map((f) => f.relativeDest), files().map((f) => f.relativeDest));
});
