#!/usr/bin/env node
// Generates the native host app's icon set — safari/App/Assets.xcassets/AppIcon.appiconset —
// from the same vector the toolbar icons come from, and verifies its own output.
//
//   node scripts/render-app-icon.mjs              regenerate the catalog
//   node scripts/render-app-icon.mjs --preview out.png    also write a 256px look-at-it PNG
//
// ---------------------------------------------------------------------------
// Why the app had no icon, and why this is a script rather than exported art
// ---------------------------------------------------------------------------
//
// The Safari web extension ships inside a host app on both platforms, and that app was showing the
// system's blank placeholder in /Applications, the Dock, Safari's Extensions list and on the iOS
// home screen. Not because the artwork was missing — assets/icon.svg has always rendered at any
// size — but because a native app icon has to go through an asset catalog, and on the toolchain
// this branch was originally built with (Xcode 15.4 on macOS 26) actool could not spawn its
// AssetCatalogSimulatorAgent, so committing a catalog would have broken the build for the one
// person who could run it. On Xcode 27 actool compiles both platforms without complaint, so the
// catalog is back and this is what fills it.
//
// It is generated rather than hand-exported for the same reason scripts/render-icons.mjs is: the
// mark is PIXEL ART on a 16x16 grid, and its one invisible failure mode is interpolation. Anything
// that resamples with smoothing invents in-between colours along every edge and the mark goes from
// crisp to mushy with no error raised and no visible diff. Every size here is rendered from the
// vector by the browser at that size, with shape-rendering: crispEdges doing the work, rather than
// downscaled from one big raster.
//
// ---------------------------------------------------------------------------
// Two platforms want two different pictures
// ---------------------------------------------------------------------------
//
// iOS supplies a FULL-BLEED SQUARE and the system applies the superellipse mask itself. Handing it
// a pre-rounded icon would round it twice and leave pale corners inside the mask. assets/icon.svg
// already draws its own blue tile edge to edge, so iOS gets it exactly as it is, at 1024. That one
// image is all current Xcode needs — it derives the rest.
//
// macOS does NOT mask anything. The icon is drawn as-is at every size, and the platform convention
// is a rounded rectangle inset inside a transparent margin, so icons of different shapes line up
// optically in the Dock and the Finder. An icon that fills its square reads as bigger than
// everything beside it, which is the way a Mac icon looks wrong.
//
// Apple's grid for a "square" icon is 824/1024 wide — a ratio of 0.805. THIS ARTWORK CANNOT USE
// IT, and the reason is the pixel grid rather than taste. The mark is 16 blocks across, so a tile
// of N pixels draws each block at N/16, and the blocks stay whole only when N is a multiple of 16.
// 0.805 of 1024 is 824, which is not; the renders came out with ten invented colours per icon,
// exactly the mush this whole approach exists to prevent. MAC_TILE is therefore 12/16 = 0.75, the
// nearest ratio to Apple's that keeps every tile a whole multiple of the grid AND leaves a whole
// pixel of margin on each side. The margin is a little wider than the system's; a fraction of a
// pixel of extra air is a far cheaper price than a blurred mark.
//
// Below 64px even 0.75 has no whole blocks to give — a 16px icon inset to 12px would ask for 16
// blocks in 12 pixels — so THE TWO SMALLEST RASTERS ARE FULL BLEED. At 16 and 32 points the icon
// is a Finder list row or a Dock badge, the margin is a pixel or two and invisible, and a crisp
// mark matters more than a shape nobody can resolve. INSET_FROM records that threshold.
//
// NO CSS ROUNDING IS APPLIED, on either platform, and that is a decision rather than an omission.
// The artwork already has a corner: assets/icon.svg draws its tile as `M1 0h14v1h1v14...`, which
// takes one grid block out of each corner — a pixel-art bevel, the BBS-era way of saying "rounded"
// on a 16x16 grid. Laying a CSS border-radius over it rounds a shape that is already cut, and the
// result is a visible double step at every corner: the bevel, then the arc, with a notch between
// them. It was rendered and looked at before this was written down.
//
// So macOS gets the margin and the artwork's own bevel, and nothing else. Every raster here is
// therefore made only of the five colours in the source, with no antialiased arc anywhere, and all
// of them — iOS and macOS, inset and full bleed — are held to the same strict no-new-colours rule
// the toolbar icons are. There is no slack band and nothing is exempt.

import { chromium } from 'playwright';
import { colourKey, decodePNG, pretty } from './lib/png.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SVG = path.join(ROOT, 'assets', 'icon.svg');
const CATALOG = path.join(ROOT, 'safari', 'App', 'Assets.xcassets');
const ICONSET = path.join(CATALOG, 'AppIcon.appiconset');

/**
 * The macOS tile, as a fraction of the canvas. 12/16, not Apple's 824/1024, so that every tile is a
 * whole multiple of the artwork's 16-unit grid and no block is ever split across a pixel boundary.
 * See the note at the top.
 */
const MAC_TILE = 12 / 16;
/** Below this many pixels there is no room to inset without splitting blocks, so the tile fills. */
const INSET_FROM = 64;

/**
 * The macOS sizes, as (points, scale) pairs. macOS asks for both scales of every size from 16 to
 * 512, which is ten slots drawn from seven distinct pixel sizes — 32, 256 and 512 each serve as
 * both the 2x of one point size and the 1x of the next.
 */
const MAC_SLOTS = [
  [16, 1], [16, 2], [32, 1], [32, 2], [128, 1], [128, 2], [256, 1], [256, 2], [512, 1], [512, 2],
];
const macPixels = (pt, scale) => pt * scale;
/** Every distinct macOS raster, smallest first. */
const MAC_SIZES = [...new Set(MAC_SLOTS.map(([pt, s]) => macPixels(pt, s)))].sort((a, b) => a - b);

/** iOS takes one full-bleed universal image and derives everything from it. */
const IOS_SIZE = 1024;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Lay the SVG out alone on a transparent page at exactly `size`, and screenshot it.
 *
 * `inset` is the macOS treatment: the tile is scaled to MAC_TILE of the canvas, centred, and
 * clipped to a rounded rectangle. On iOS it is false and the artwork fills the square.
 */
async function render(browser, svg, size, file, { inset }) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const tile = inset ? size * MAC_TILE : size;
  const offset = inset ? (size - tile) / 2 : 0;
  // No border-radius: the artwork carries its own corner bevel. See the note at the top.
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px}
       .tile{position:absolute;left:${offset}px;top:${offset}px;width:${tile}px;height:${tile}px}
       /* crispEdges in the SVG keeps the blocks hard; this stops any browser-side smoothing of
          the element box on top of it. */
       svg{display:block;width:${tile}px;height:${tile}px;image-rendering:pixelated}
     </style></head><body><div class="tile">${svg}</div></body></html>`,
  );
  await page.screenshot({ path: file, omitBackground: true });
  await page.close();
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** The colours the owner's original artwork actually contains. */
function sourcePalette() {
  const im = decodePNG(path.join(ROOT, 'assets', 'icon-source.png'));
  const set = new Set();
  for (let i = 0; i < im.width * im.height; i++) set.add(colourKey(im.px, i * 4));
  return set;
}

/**
 * Check one rendered icon: exact size, and not a single colour the artwork does not contain.
 *
 * No exemptions and no slack band: nothing here is antialiased, because nothing here is rounded.
 * `inset` only tells the opacity floor below how much of the canvas the tile was supposed to
 * cover, since an inset icon is legitimately transparent around its margin.
 */
function verify(file, size, palette, { inset = false } = {}) {
  const im = decodePNG(file);
  const rel = path.relative(ROOT, file);
  if (im.width !== size || im.height !== size) {
    throw new Error(`${rel} is ${im.width}x${im.height}, expected exactly ${size}x${size}`);
  }

  const bad = new Map();
  let transparent = 0;
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const key = colourKey(im.px, (y * im.width + x) * 4);
      if (key === 'transparent') transparent++;
      if (palette.has(key)) continue;
      if (!bad.has(key)) bad.set(key, { x, y, n: 0 });
      bad.get(key).n++;
    }
  }
  if (bad.size) {
    const detail = [...bad.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 10)
      .map(([key, v]) => `      ${pretty(key)}  ${v.n}px, first at (${v.x},${v.y})`)
      .join('\n');
    throw new Error(
      `${rel} contains ${bad.size} colour(s) outside the source artwork — the render was ` +
        `interpolated rather than kept blocky:\n${detail}`,
    );
  }

  // A blank or near-blank icon would pass every colour check above, since transparent is in the
  // palette. The mark covers the whole tile, so anything mostly transparent is a failed render.
  const filled = 1 - transparent / (im.width * im.height);
  const floor = inset ? MAC_TILE * MAC_TILE * 0.9 : 0.95;
  if (filled < floor) {
    throw new Error(`${rel} is only ${(filled * 100).toFixed(1)}% opaque; the artwork did not render`);
  }
  return { filled };
}

// ---------------------------------------------------------------------------
// The catalog
// ---------------------------------------------------------------------------

/**
 * Contents.json for the icon set.
 *
 * One universal iOS entry, which is all current Xcode wants — it derives every home screen,
 * Spotlight and Settings size from the 1024. Then the ten macOS slots, several of which name the
 * same file at two different (size, scale) pairs, which is how a catalog says "this raster serves
 * both 32pt@1x and 16pt@2x".
 */
function contents() {
  const images = [
    { filename: `ios-${IOS_SIZE}.png`, idiom: 'universal', platform: 'ios', size: `${IOS_SIZE}x${IOS_SIZE}` },
  ];
  for (const [pt, scale] of MAC_SLOTS) {
    images.push({
      filename: `mac-${macPixels(pt, scale)}.png`,
      idiom: 'mac',
      scale: `${scale}x`,
      size: `${pt}x${pt}`,
    });
  }
  return { images, info: { author: 'usermods/scripts/render-app-icon.mjs', version: 1 } };
}

// ---------------------------------------------------------------------------

const preview = (() => {
  const i = process.argv.indexOf('--preview');
  return i === -1 ? null : process.argv[i + 1];
})();

const palette = sourcePalette();
console.log(`[appicon] source palette (${palette.size}): ${[...palette].map(pretty).join('  ')}`);

const svg = fs.readFileSync(SVG, 'utf8');
fs.mkdirSync(ICONSET, { recursive: true });

// The catalog is regenerated whole rather than patched, so a size removed from the lists above
// does not linger on disk and end up in the compiled Assets.car.
for (const f of fs.readdirSync(ICONSET)) {
  if (f.endsWith('.png') || f === 'Contents.json') fs.rmSync(path.join(ICONSET, f));
}

const browser = await chromium.launch({ channel: 'chromium' });
try {
  const ios = path.join(ICONSET, `ios-${IOS_SIZE}.png`);
  await render(browser, svg, IOS_SIZE, ios, { inset: false });
  verify(ios, IOS_SIZE, palette);
  console.log(`[appicon] ios-${IOS_SIZE}.png`.padEnd(28) + `${IOS_SIZE}x${IOS_SIZE}  full bleed, verified`);

  for (const size of MAC_SIZES) {
    const file = path.join(ICONSET, `mac-${size}.png`);
    // Too small to inset without splitting blocks: fill, and be crisp instead of shaped.
    const inset = size >= INSET_FROM;
    await render(browser, svg, size, file, { inset });
    const { filled } = verify(file, size, palette, { inset });
    const shape = inset ? 'inset tile' : 'full bleed (too small to inset)';
    console.log(`[appicon] mac-${size}.png`.padEnd(28) + `${size}x${size}  ${shape}, ${(filled * 100).toFixed(0)}% opaque, verified`);
  }

  fs.writeFileSync(path.join(ICONSET, 'Contents.json'), `${JSON.stringify(contents(), null, 2)}\n`);
  fs.writeFileSync(
    path.join(CATALOG, 'Contents.json'),
    `${JSON.stringify({ info: { author: 'usermods/scripts/render-app-icon.mjs', version: 1 } }, null, 2)}\n`,
  );

  if (preview) {
    // A look-at-it render at the size a person judges a Mac icon at, so the shape and the margin
    // can be reviewed rather than taken on trust.
    const out = path.resolve(ROOT, preview);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await render(browser, svg, 256, out, { inset: true });
    console.log(`[appicon] preview -> ${path.relative(ROOT, out)}`);
  }
} finally {
  await browser.close();
}

console.log(
  `[appicon] ${1 + MAC_SIZES.length} rasters + Contents.json in ${path.relative(ROOT, ICONSET)}: ` +
    'exact sizes, no colours outside the source artwork.',
);
