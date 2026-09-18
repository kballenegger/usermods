import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'usermods',
    description:
      'Vibe-code userscripts in place. Customize any website by chatting with any LLM.',
    permissions: ['sidePanel', 'storage', 'scripting', 'activeTab', 'tabs', 'userScripts'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open usermods' },
    minimum_chrome_version: '135',
  },
});
