import { defineConfig } from 'wxt';

/**
 * The Chrome Web Store build drops subscription sign-in; see lib/buildflags.ts. Set by
 * `npm run build:store` / `npm run zip:store`. A literal define, so the bundler folds the flag
 * and tree-shakes lib/oauth out of the store build entirely.
 */
const storeBuild = process.env.USERMODS_STORE === '1';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    define: { __STORE_BUILD__: JSON.stringify(storeBuild) },
  }),
  manifest: {
    name: 'usermods',
    description:
      'Vibe-code userscripts in place. Customize any website by chatting with any LLM.',
    // No activeTab: host_permissions <all_urls> already covers everything it would grant
    // (captureVisibleTab, content-script injection), and nothing in the code depends on it.
    permissions: ['sidePanel', 'storage', 'scripting', 'tabs', 'userScripts', 'declarativeNetRequest'],
    host_permissions: ['<all_urls>'],
    // default_icon is spelled out rather than left to the top-level `icons` fallback: Chrome does
    // fall back, but the toolbar is where the mark is seen most, and naming the sizes here keeps
    // the 16/32 pixel-art renders (not a downscale of 128) the ones it picks at 1x and 2x.
    action: {
      default_title: 'Open usermods',
      default_icon: {
        16: 'icon/16.png',
        32: 'icon/32.png',
        48: 'icon/48.png',
        128: 'icon/128.png',
      },
    },
    // The dashboard doubles as the options page, which is what puts it behind "Extension options"
    // in chrome://extensions and in the toolbar icon's context menu. open_in_tab because it is a
    // full page — every chat and every mod — not a popup-sized settings dialog.
    options_ui: { page: 'dashboard.html', open_in_tab: true },
    minimum_chrome_version: '135',
    // The .user.js redirect rule sends navigations to this page, so it must be web accessible.
    web_accessible_resources: [{ resources: ['install.html'], matches: ['<all_urls>'] }],
  },
});
