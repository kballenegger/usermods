// The single source of truth for which .output/ folder a script that launches a browser against
// the built extension should read from.
//
// usermods has three build outputs, kept apart so a verification run can never silently replace
// the extension the owner has loaded unpacked in his real browser:
//
//   .output/chrome-mv3        npm run build / npm run dev   — the one Chrome loads unpacked
//   .output/store-chrome-mv3  npm run build:store           — USERMODS_STORE=1, no subscription
//                                                              sign-in (see lib/buildflags.ts)
//   .output/test-chrome-mv3   npm run smoke, screenshots,      set by USERMODS_TEST_BUILD=1 in
//                              store-assets, styleguide, ...    package.json; never the folder
//                                                                Chrome is pointed at
//
// The three names are produced by wxt.config.ts's outDirTemplate, which branches on the same
// USERMODS_STORE / USERMODS_TEST_BUILD env vars this file reads. Keep the two in sync.
//
// Any script that opens the extension in a browser (Playwright, launchPersistentContext, etc.)
// should get its EXT_DIR from extDir() here rather than hardcoding a path, so there is exactly
// one place that encodes the rule.

import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolve the build folder a browser-launching script should load, and fail loudly if that build
 * has not actually been produced yet — better a clear error than silently loading a different,
 * stale folder (e.g. the real `chrome-mv3` build, which must never happen from a test script).
 *
 * @param {string} root - the project root (import.meta.url-derived, one level up from scripts/).
 * @param {{ requireTestBuild?: boolean }} [opts] - pass `requireTestBuild: true` from a script
 *   that must only ever run against the `USERMODS_TEST_BUILD=1` folder (this is every script that
 *   launches a browser today), so a run with the env var missing fails fast instead of quietly
 *   reading `.output/chrome-mv3` — the real, owner-loaded build.
 */
export function extDir(root, opts = {}) {
  const { requireTestBuild = false } = opts;
  const isTestBuild = process.env.USERMODS_TEST_BUILD === '1';
  const isStoreBuild = process.env.USERMODS_STORE === '1';

  if (requireTestBuild && !isTestBuild) {
    throw new Error(
      'USERMODS_TEST_BUILD=1 is not set. This script drives a browser against the built ' +
        'extension and must never load .output/chrome-mv3 (the folder the owner has loaded ' +
        "unpacked in his real browser) — it needs its own test build. Run this via its `npm run` " +
        'script, which sets the env var and runs `wxt build` first, e.g. `npm run smoke`.',
    );
  }

  const folder = isTestBuild
    ? 'test-chrome-mv3'
    : isStoreBuild
      ? 'store-chrome-mv3'
      : 'chrome-mv3';
  const dir = path.join(root, '.output', folder);

  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    throw new Error(
      `${dir} has no manifest.json — the build for this folder has not been run yet. ` +
        'Run it via its `npm run` script (each one runs `wxt build` first), not this script ' +
        'directly.',
    );
  }

  return dir;
}
