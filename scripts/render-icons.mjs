#!/usr/bin/env node
// Renders assets/icon.svg to public/icon/{16,32,48,96,128}.png with Playwright.
//
//   node scripts/render-icons.mjs                 assets/icon.svg -> public/icon/
//   node scripts/render-icons.mjs <svg> <outdir>  any SVG, for comparing concepts
//
// The SVG is laid out alone on a transparent page at exactly the target size and screenshotted
// with omitBackground, so the PNG carries the alpha channel a toolbar icon needs. Rendering each
// size separately (rather than downscaling one big raster) lets the browser rasterize the vector
// at that size, which keeps the 16px edges crisp.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 96, 128];

const src = path.resolve(ROOT, process.argv[2] ?? 'assets/icon.svg');
const outDir = path.resolve(ROOT, process.argv[3] ?? 'public/icon');

export async function renderIcon(browser, svgPath, destDir, sizes = SIZES) {
  const svg = fs.readFileSync(svgPath, 'utf8');
  fs.mkdirSync(destDir, { recursive: true });
  const written = [];
  for (const size of sizes) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html><html><head><style>
         html,body{margin:0;padding:0;background:transparent}
         svg{display:block;width:${size}px;height:${size}px}
       </style></head><body>${svg}</body></html>`,
    );
    const file = path.join(destDir, `${size}.png`);
    await page.screenshot({ path: file, omitBackground: true });
    await page.close();
    written.push(file);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    for (const file of await renderIcon(browser, src, outDir)) {
      console.log(`[icons] ${path.relative(ROOT, file)}`);
    }
  } finally {
    await browser.close();
  }
}
