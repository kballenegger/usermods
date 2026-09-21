import { defineConfig } from 'wxt';
import { buildManifest, isSafariOnlyIcon } from './lib/manifest';

/**
 * A storefront build drops subscription sign-in; see lib/buildflags.ts. Set by
 * `npm run build:store` / `npm run zip:store` (Chrome Web Store) and `npm run build:safari:store`
 * (an App Store submission). A literal define, so the bundler folds the flag and tree-shakes
 * lib/oauth out of the store build entirely.
 *
 * It is independent of the target: `USERMODS_STORE=1 wxt build -b safari` is a Safari build for a
 * storefront, and a plain `wxt build -b safari` — the one the owner installs on his own devices —
 * has subscription sign-in exactly like the plain Chrome build.
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
//
// `{{browser}}` is what keeps the two Safari builds apart without a fourth branch: a plain
// `wxt build -b safari` writes `.output/safari-mv3`, and `USERMODS_STORE=1 wxt build -b safari`
// writes `.output/store-safari-mv3`. That matters more here than it does for Chrome, because
// scripts/safari-xcode.mjs stages one of those folders into the .appex — staging the wrong one
// would produce an app that builds, installs and is simply missing the sign-in, with nothing in
// any log to say which build it came from. See its --store flag.
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
  hooks: {
    /**
     * Keep the two large icon renders out of every package but Safari's.
     *
     * WXT builds the top-level `icons` map by discovering `public/icon/*.png`, so a file dropped in
     * that directory is listed for every target whether the target has a use for it or not. 256 and
     * 512 exist for Safari's Extensions list, which draws the mark large enough that upscaling the
     * 128 would show; Chrome never picks either. Filtering here rather than overriding `icons`
     * means the Chrome build's manifest.json AND its zip are byte-for-byte what they were, instead
     * of only the manifest being patched while two unused PNGs ship inside the package.
     *
     * See SAFARI_ONLY_ICON_SIZES in lib/manifest.ts.
     */
    'build:publicAssets': (wxt, files) => {
      if (wxt.config.browser === 'safari') return;
      // Backwards, so a splice does not shift the indices still to be visited.
      for (let i = files.length - 1; i >= 0; i--) {
        const dest = files[i]?.relativeDest;
        if (dest && isSafariOnlyIcon(dest)) files.splice(i, 1);
      }
    },
  },
});
