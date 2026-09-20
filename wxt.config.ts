import { defineConfig } from 'wxt';
import { buildManifest } from './lib/manifest';

/**
 * The Chrome Web Store build drops subscription sign-in; see lib/buildflags.ts. Set by
 * `npm run build:store` / `npm run zip:store`. A literal define, so the bundler folds the flag
 * and tree-shakes lib/oauth out of the store build entirely.
 */
const storeBuild = process.env.USERMODS_STORE === '1';

/**
 * Test builds (smoke, screenshots, store-assets, styleguide, settings-capture — anything that
 * launches a browser against the built extension) get their own output folder too, set by
 * `USERMODS_TEST_BUILD=1` in the relevant package.json scripts. See scripts/build-dir.mjs, which
 * scripts that load the extension read this same folder name from.
 *
 * Without this, every one of those commands ran a plain `wxt build` into `.output/chrome-mv3` —
 * the SAME folder Chrome has the real unpacked extension loaded from — so a verification run could
 * silently overwrite the live extension mid-session. Three separate outDirTemplate values keep
 * `.output/chrome-mv3` written only by a deliberate `npm run build` or `npm run dev`.
 */
const testBuild = process.env.USERMODS_TEST_BUILD === '1';

// Order matters: a store build launched for testing (there isn't one today, but if that ever
// happens) should land in the test folder, not the store folder, since the test folder is the one
// nothing but test scripts ever read from.
const outDirTemplate = testBuild
  ? 'test-{{browser}}-mv{{manifestVersion}}{{modeSuffix}}'
  : storeBuild
    ? 'store-{{browser}}-mv{{manifestVersion}}{{modeSuffix}}'
    : '{{browser}}-mv{{manifestVersion}}{{modeSuffix}}'; // WXT's own default template

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDirTemplate,
  vite: (env) => ({
    define: {
      __STORE_BUILD__: JSON.stringify(storeBuild),
      // Safari ships API-key providers only for now; see lib/buildflags.ts for why. A literal
      // define, so the bundler folds the flag and drops lib/oauth from that build too.
      __SAFARI_BUILD__: JSON.stringify(env.browser === 'safari'),
    },
  }),
  // Safari's own default in WXT is MV2. usermods is an MV3 extension throughout, with a service-worker
  // background, `action` and `host_permissions`, and Safari has supported MV3 since 16.4, which is the
  // floor lib/manifest.ts sets for that target anyway.
  manifestVersion: 3,
  // The manifest differs by target; lib/manifest.ts holds the differences and test/manifest.test.ts
  // pins them.
  manifest: ({ browser }) => buildManifest(browser),
});
