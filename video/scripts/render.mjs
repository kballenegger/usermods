#!/usr/bin/env node
// Runs `hyperframes render` (the pinned local CLI) with two local defaults:
//
//  - Telemetry off (HYPERFRAMES_NO_TELEMETRY=1) unless the caller set it.
//  - The headless Chrome it renders with. HyperFrames downloads chrome-headless-shell from Google's
//    CDN on first use; where that download is blocked or slow it hangs. The repo already has
//    Playwright's build of the same shell (installed for the screenshot harness), so when one is
//    in Playwright's cache it is used via PRODUCER_HEADLESS_SHELL_PATH. Set that variable yourself
//    to choose another, or unset the cache to let HyperFrames fetch its own.
//
//   node scripts/render.mjs [hyperframes render args...]

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
env.HYPERFRAMES_NO_TELEMETRY ??= '1';

function playwrightShell() {
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'),
    path.join(os.homedir(), '.cache', 'ms-playwright'),
  ].filter(Boolean);
  for (const dir of caches) {
    if (!fs.existsSync(dir)) continue;
    const builds = fs
      .readdirSync(dir)
      .filter((d) => d.startsWith('chromium_headless_shell-'))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const b of builds) {
      for (const sub of fs.readdirSync(path.join(dir, b))) {
        const bin = path.join(dir, b, sub, 'chrome-headless-shell');
        if (fs.existsSync(bin)) return bin;
      }
    }
  }
  return null;
}

if (!env.PRODUCER_HEADLESS_SHELL_PATH) {
  const bin = playwrightShell();
  if (bin) {
    env.PRODUCER_HEADLESS_SHELL_PATH = bin;
    console.log(`[render] using ${bin}`);
  }
}

const cli = path.join(VIDEO, 'node_modules', '.bin', 'hyperframes');
const r = spawnSync(cli, ['render', ...process.argv.slice(2)], { cwd: VIDEO, env, stdio: 'inherit' });
process.exit(r.status ?? 1);
