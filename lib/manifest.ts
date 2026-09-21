/**
 * The manifest, per browser.
 *
 * It lives here rather than inline in wxt.config.ts so the differences between targets are a pure
 * function the node tests can assert on (test/manifest.test.ts). A manifest mistake is not the kind
 * that shows up as a stack trace: the wrong permission on Safari is a load-time refusal, and a
 * `sidePanel` permission a browser has never heard of is a silent warning at install. Pinning the
 * shape in tests is the only cheap way to notice.
 *
 * What actually differs, and why (every version below is from docs/browsers.md, which cites MDN's
 * browser-compat-data):
 *
 *  - **`userScripts`**: Chrome and Firefox only. Safari has never shipped it, which is the whole
 *    reason lib/exec/ has a second engine. Asking for a permission that does not exist is not
 *    harmless there, so it is dropped rather than left in and ignored.
 *  - **`sidePanel`**: Chrome only. Safari has no sidebar surface for extensions at all, so the panel
 *    becomes a toolbar popup, set by `action.default_popup`, which on iOS is the extension's whole UI.
 *  - **`minimum_chrome_version`**: meaningless outside Chrome.
 *  - **`browser_specific_settings.safari.strict_min_version`**: 16.4, set by the newest API the
 *    extension actually calls. `scripting.executeScript` and `declarativeNetRequest.updateDynamicRules`
 *    both land at 15.4, but an MV3 background in Safari is a service worker, and that is 16.4. iOS
 *    16.4 shipped March 2023.
 */

/** Manifest keys this module sets. Structural, so the module imports nothing and node can load it. */
export interface BuiltManifest {
  name: string;
  description: string;
  permissions: string[];
  host_permissions: string[];
  action: {
    default_title: string;
    default_icon: Record<string, string>;
    default_popup?: string;
  };
  options_ui: { page: string; open_in_tab: boolean };
  web_accessible_resources: { resources: string[]; matches: string[] }[];
  minimum_chrome_version?: string;
  browser_specific_settings?: { safari?: { strict_min_version: string } };
}

export const CHROME_MIN_VERSION = '135';
export const SAFARI_MIN_VERSION = '16.4';

/** The popup document. Safari's only UI surface, and never built for Chrome. */
export const POPUP_PATH = 'popup.html';

/**
 * Icon sizes only Safari has a use for.
 *
 * Safari's Extensions list — the macOS Settings pane and the iOS one — draws the mark far larger
 * than a Chrome row does, and with nothing above 128 it upscales the 128 and the pixel art blurs,
 * which is the one failure the whole generated-and-verified icon pipeline exists to prevent.
 * Chrome has no surface that picks either size.
 *
 * They are listed here rather than simply dropped in public/icon/ because WXT discovers every
 * `public/icon/N.png` and writes them all into `icons` for every target. Two extra keys in the
 * Chrome build's manifest.json would be behaviourally harmless and still wrong: that file is a
 * committed, reviewed artifact and the branch has a test pinning it. wxt.config.ts uses this list
 * in a `build:publicAssets` hook to keep the files out of the non-Safari packages entirely, so
 * Chrome's manifest AND its zip are unchanged. test/manifest.test.ts covers both sides.
 */
export const SAFARI_ONLY_ICON_SIZES = [256, 512];

/** Whether a public asset is one of those Safari-only icons. */
export function isSafariOnlyIcon(relativePath: string): boolean {
  const m = /^icons?[/\\](\d+)\.png$/.exec(relativePath);
  return m ? SAFARI_ONLY_ICON_SIZES.includes(Number(m[1])) : false;
}

/** Permissions every target needs, in the order the Chrome build has always listed them. */
const BASE_PERMISSIONS = ['storage', 'scripting', 'tabs', 'declarativeNetRequest'];

export function isSafariTarget(browser: string): boolean {
  return browser === 'safari';
}

/**
 * The permission list for a target.
 *
 * No `activeTab` anywhere: `host_permissions: ['<all_urls>']` already covers everything it would
 * grant (captureVisibleTab, content-script injection), and nothing in the code depends on it.
 */
export function permissionsFor(browser: string): string[] {
  if (isSafariTarget(browser)) return [...BASE_PERMISSIONS];
  // The order is the order the shipped Chrome manifest has, so moving this list out of
  // wxt.config.ts leaves that build's manifest.json byte-for-byte what it was.
  return ['sidePanel', 'storage', 'scripting', 'tabs', 'userScripts', 'declarativeNetRequest'];
}

/**
 * The toolbar button.
 *
 * `default_icon` is spelled out rather than left to the top-level `icons` fallback: browsers do fall
 * back, but the toolbar is where the mark is seen most, and naming the sizes keeps the 16/32
 * pixel-art renders (not a downscale of 128) the ones picked at 1x and 2x.
 *
 * Safari gets `default_popup`, which changes what a click does: the browser opens the popup itself
 * and `action.onClicked` never fires. That is the intended behaviour there, because the popup is
 * the only place the UI can live, and it is why background.ts guards its onClicked handler rather
 * than assuming the click is its to handle.
 */
export function actionFor(browser: string): BuiltManifest['action'] {
  const action: BuiltManifest['action'] = {
    default_title: 'Open usermods',
    default_icon: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    } as unknown as Record<string, string>,
  };
  if (isSafariTarget(browser)) action.default_popup = POPUP_PATH;
  return action;
}

export function buildManifest(browser: string): BuiltManifest {
  const safari = isSafariTarget(browser);
  return {
    name: 'usermods',
    description: 'Vibe-code userscripts in place. Customize any website by chatting with any LLM.',
    permissions: permissionsFor(browser),
    host_permissions: ['<all_urls>'],
    action: actionFor(browser),
    // The dashboard doubles as the options page, which is what puts it behind "Extension options"
    // in the browser's extension list and in the toolbar icon's context menu. open_in_tab because it
    // is a full page with every chat and every mod, not a popup-sized settings dialog.
    options_ui: { page: 'dashboard.html', open_in_tab: true },
    // Key order matters here and nowhere else: it is the order the shipped Chrome manifest.json has,
    // and keeping it means moving this out of wxt.config.ts leaves that file byte for byte what it
    // was. test/manifest.test.ts asserts the order, not just the values.
    ...(safari ? {} : { minimum_chrome_version: CHROME_MIN_VERSION }),
    // The .user.js redirect rule sends navigations to this page, so it must be web accessible.
    web_accessible_resources: [{ resources: ['install.html'], matches: ['<all_urls>'] }],
    ...(safari ? { browser_specific_settings: { safari: { strict_min_version: SAFARI_MIN_VERSION } } } : {}),
  };
}
