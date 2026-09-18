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
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'userScripts', 'declarativeNetRequest'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open usermods' },
    minimum_chrome_version: '135',
    // The .user.js redirect rule sends navigations to this page, so it must be web accessible.
    web_accessible_resources: [{ resources: ['install.html'], matches: ['<all_urls>'] }],
  },
});
