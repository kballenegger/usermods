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
// Both platforms now want the same picture: a full-bleed square
// ---------------------------------------------------------------------------
//
// iOS has always supplied a FULL-BLEED SQUARE and let the system apply the superellipse mask.
// Handing it a pre-rounded icon would round it twice and leave pale corners inside the mask.
// That one 1024 image is all current Xcode needs — it derives the rest.
//
// macOS USED TO BE THE OPPOSITE, and this script used to encode that. Through macOS 15 the system
// masked nothing: the icon was drawn as supplied, and the convention was a rounded rectangle inset
// inside a transparent margin (Apple's grid is 824/1024, a ratio of 0.805) so icons of different
// shapes lined up optically in the Dock. macOS 26 (Tahoe) ENDED THAT. Under Liquid Glass the
// system draws every app icon in its own rounded-square container and clips the artwork to it, the
// way iOS always has — and artwork that still carries its own transparent margin is not recognised
// as already-shaped, it is simply centred inside the system container, which is why the owner saw
// the mark floating in a frame with the Dock's grey showing around it.
//
// Sources, since this reverses a decision that was carefully argued the other way:
//   - Apple HIG, "App icons" — macOS 26 icons are drawn in the system's rounded-rectangle shape;
//     supply a full-bleed 1024x1024 square and let the system mask it.
//     https://developer.apple.com/design/human-interface-guidelines/app-icons
//   - Xcode, "Configuring your app icon using an asset catalog".
//     https://developer.apple.com/documentation/xcode/configuring-your-app-icon
//   - The same fix, diagnosed in the wild: "macOS Tahoe wraps icons with transparent edges in a
//     grey squircle in the Dock, shrinking the artwork" — the remedy being to flatten the padding
//     to opaque full-bleed art "so Tahoe clips a clean squircle itself".
//     https://github.com/aladh/Spotty/pull/261
//
// ICON COMPOSER WAS CONSIDERED AND NOT USED. Xcode 27 ships Icon Composer and supports a `.icon`
// bundle in the asset catalog, and it is the right answer for artwork with real layers, because it
// gets the specular and shadow passes of Liquid Glass for free. It is the wrong answer here: a
// `.icon` is a layered-vector document whose whole value is that the system relights and reblurs
// those layers, and this mark is four flat pixel-art paths on a 16-unit grid whose entire point is
// that nothing resamples or shades it. Building one from our SVG would also mean either checking in
// a binary bundle no script can regenerate, or writing a `.icon` emitter for a format Apple has not
// documented as stable. Full-bleed PNGs through the appiconset get the same system squircle with
// none of that, so that is what ships.
//
// THE MAC RASTERS ARE THEREFORE FULL BLEED, exactly like iOS, with one change to the artwork: the
// BEVEL IS DROPPED. assets/icon.svg draws its tile as `M1 0h14v1h1v14...`, taking one grid block
// out of each corner — a pixel-art bevel, the BBS-era way of saying "rounded" at 16x16. Under a
// system mask that bevel is actively harmful: those corner blocks are transparent, so they punch
// four notches out of the navy right where the system's squircle needs opaque colour, and the Dock
// shows grey through them. macOS gets MAC_BG painted edge to edge underneath instead. The corner is
// the system's job now. iOS keeps the artwork as-is, because its corners land outside the
// superellipse and are never seen.
//
// THE BREATHING ROOM MOVED FROM THE TILE TO THE MARK, and that turns out to need no scaling at
// all. The old margin was around the whole tile, which is what read as "a small mark floating in a
// frame". What should be inset is the MARK, and the artwork already insets it: the u spans grid
// units 2..14 of 16, leaving two units of its own blue on each side. So the artwork is drawn at the
// FULL canvas size — the same picture iOS gets — and the mark lands at 12/16 = 75% of the width,
// which is the 70–80% a native macOS 26 icon occupies inside its squircle. The only thing added is
// MAC_BG underneath, to fill the four bevel corners.
//
// Scaling the artwork down would be worse twice over. It would shrink the mark below 75% (0.75 of
// the canvas puts the mark at 0.75 × 12/16 = 56%, which is the floating-mark look again, one layer
// in), and it would reintroduce the pixel-grid problem this script exists to catch: a canvas of N
// pixels at scale s draws each block at N·s/16, whole only for particular pairs, and Apple's old
// 0.805 on a 1024 grid invented ten colours per icon.
//
// Drawing at full size also means THERE IS NO LONGER A SMALL-SIZE EXCEPTION. Every macOS raster,
// 16 through 1024, is the same construction with whole blocks — at 16px each grid unit is exactly
// one pixel — so the no-new-colours check applies unweakened at every slot, with nothing documented
// away. The old INSET_FROM threshold is gone with the inset that needed it.
//
// NO CSS ROUNDING IS APPLIED, on either platform. On iOS and now on macOS the system does the
// rounding; laying a border-radius under it would antialias an arc that gets clipped away anyway,
// and would break the no-new-colours rule for nothing. Every raster here is made only of the
// colours in the source, and all of them are held to that same strict rule with no slack band and
// no exemption.

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
 * How much of the canvas the MARK occupies once the artwork is drawn at full size: the u spans grid
 * units 2..14 of 16, so it lands at 75% with two units of its own field on each side. Asserted
 * against the rendered pixels below rather than trusted, since it is a property of the SVG's path
 * data and would change silently if the artwork were redrawn. See the note at the top.
 */
const MARK_SPAN = 12 / 16;
/**
 * The tile colour from assets/icon.svg, painted edge to edge under the macOS mark so the system's
 * squircle has opaque artwork to clip. It is one of the source palette colours by construction, so
 * the no-new-colours check covers it like everything else.
 */
const MAC_BG = '#1008C8';

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
 * Lay the SVG out alone on a page at exactly `size`, and screenshot it.
 *
 * `platform` picks the treatment:
 *
 *   'ios' — the artwork alone, full bleed on a transparent page, exactly as it is drawn. Its bevel
 *           corners stay transparent because the superellipse mask cuts further in than they do.
 *
 *   'mac' — the same artwork at the same full size, over MAC_BG painted across the whole square.
 *           The background is what fills the bevel's four transparent corner blocks, so the
 *           system's rounded-square mask has opaque colour everywhere it clips. See the note at
 *           the top.
 */
async function render(browser, svg, size, file, { platform }) {
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  const mac = platform === 'mac';
  // No border-radius on either platform: the system does the rounding now. See the note at the top.
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;background:${mac ? MAC_BG : 'transparent'};width:${size}px;height:${size}px}
       /* crispEdges in the SVG keeps the blocks hard; this stops any browser-side smoothing of
          the element box on top of it. */
       svg{display:block;width:${size}px;height:${size}px;image-rendering:pixelated}
     </style></head><body>${svg}</body></html>`,
  );
  // omitBackground would punch the mac field back out to transparent, which is the exact thing
  // macOS 26 wraps in a grey frame — so it is only for iOS, whose bevel corners must stay clear.
  await page.screenshot({ path: file, omitBackground: !mac });
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
 * Check one rendered icon: exact size, not a single colour the artwork does not contain, and enough
 * opaque pixels that a blank render cannot pass.
 *
 * No exemptions and no slack band: nothing here is antialiased, because nothing here is rounded.
 *
 * `platform` sets the opacity floor. A macOS raster must now be COMPLETELY opaque — that is the
 * whole point of the change, since any transparent pixel is a hole the system's squircle shows the
 * Dock through — so its floor is 1. iOS keeps a floor just under 1 because its bevel legitimately
 * leaves four transparent corner blocks.
 */
function verify(file, size, palette, { platform = 'ios' } = {}) {
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
  // palette. Beyond that, a macOS raster with ANY transparent pixel is the bug this change fixes:
  // the system clips its squircle out of whatever is supplied, and a hole in the artwork is a hole
  // the Dock's grey shows through. So macOS demands 100% and says which pixel failed.
  const filled = 1 - transparent / (im.width * im.height);
  if (platform === 'mac' && transparent > 0) {
    throw new Error(
      `${rel} has ${transparent} transparent pixel(s); a macOS icon must be opaque edge to edge or ` +
        "macOS 26 shows its own grey frame through the gaps",
    );
  }
  if (filled < 0.95) {
    throw new Error(`${rel} is only ${(filled * 100).toFixed(1)}% opaque; the artwork did not render`);
  }

  // How wide the mark actually came out, as a fraction of the canvas: the leftmost and rightmost
  // pixel that is not the background field. This is the number the owner sees — "does it fill the
  // frame" — and it is a property of the SVG's path data, so it would drift silently if the artwork
  // were redrawn. The caller checks it against MARK_SPAN.
  let markLeft = im.width;
  let markRight = -1;
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const key = colourKey(im.px, (y * im.width + x) * 4);
      if (key === 'transparent' || pretty(key) === MAC_BG.toLowerCase()) continue;
      if (x < markLeft) markLeft = x;
      if (x > markRight) markRight = x;
    }
  }
  const markSpan = markRight < markLeft ? 0 : (markRight - markLeft + 1) / im.width;
  return { filled, markSpan };
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
  await render(browser, svg, IOS_SIZE, ios, { platform: 'ios' });
  verify(ios, IOS_SIZE, palette, { platform: 'ios' });
  console.log(`[appicon] ios-${IOS_SIZE}.png`.padEnd(28) + `${IOS_SIZE}x${IOS_SIZE}  full bleed, verified`);

  for (const size of MAC_SIZES) {
    const file = path.join(ICONSET, `mac-${size}.png`);
    await render(browser, svg, size, file, { platform: 'mac' });
    const { markSpan } = verify(file, size, palette, { platform: 'mac' });
    // The mark has to actually land where the artwork says it does. One block of tolerance, which
    // is all a 16px raster can express; anything further off means the SVG was redrawn and the
    // icon's proportions moved without anyone deciding to move them.
    if (Math.abs(markSpan - MARK_SPAN) > 1 / 16 + 1e-9) {
      throw new Error(
        `${path.relative(ROOT, file)}: the mark spans ${(markSpan * 100).toFixed(1)}% of the canvas, ` +
          `expected about ${(MARK_SPAN * 100).toFixed(0)}% — the artwork's own margins changed`,
      );
    }
    console.log(
      `[appicon] mac-${size}.png`.padEnd(28) +
        `${size}x${size}  full bleed, opaque, mark ${(markSpan * 100).toFixed(0)}% wide, verified`,
    );
  }

  fs.writeFileSync(path.join(ICONSET, 'Contents.json'), `${JSON.stringify(contents(), null, 2)}\n`);
  fs.writeFileSync(
    path.join(CATALOG, 'Contents.json'),
    `${JSON.stringify({ info: { author: 'usermods/scripts/render-app-icon.mjs', version: 1 } }, null, 2)}\n`,
  );

  if (preview) {
    // A look-at-it render at the size a person judges a Mac icon at, so the field and the mark's
    // inset can be reviewed rather than taken on trust. It is the raw square; the system's squircle
    // is applied on top of this at display time.
    const out = path.resolve(ROOT, preview);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await render(browser, svg, 256, out, { platform: 'mac' });
    console.log(`[appicon] preview -> ${path.relative(ROOT, out)}`);
  }
} finally {
  await browser.close();
}

console.log(
  `[appicon] ${1 + MAC_SIZES.length} rasters + Contents.json in ${path.relative(ROOT, ICONSET)}: ` +
    'exact sizes, no colours outside the source artwork.',
);
