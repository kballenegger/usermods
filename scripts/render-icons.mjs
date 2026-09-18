#!/usr/bin/env node
// Renders assets/icon.svg to public/icon/{16,32,48,96,128}.png (plus docs/branding/icon-1024.png)
// with Playwright, and verifies its own output.
//
//   node scripts/render-icons.mjs                 assets/icon.svg -> public/icon/
//   node scripts/render-icons.mjs <svg> <outdir>  any SVG, for comparing concepts
//
// ---------------------------------------------------------------------------
// Why this script checks itself
// ---------------------------------------------------------------------------
//
// The icon is PIXEL ART on a 16x16 grid (assets/icon-source.png is the owner's original, 256x256,
// 16px per block). Pixel art has exactly one failure mode that matters and it is invisible in a
// diff: interpolation. Anything that resamples with smoothing — `sips`, a default canvas
// drawImage, an <img> scaled by CSS without image-rendering — invents in-between colours along
// every edge, and the mark goes from crisp to mushy without any error being raised.
//
// So rather than trusting the renderer, every output is decoded back off disk and checked:
//
//   1. EXACT DIMENSIONS. The PNG's IHDR must be the size asked for, to the pixel.
//   2. NO INVENTED COLOURS. Every pixel's RGBA must be one of the five in the source artwork
//      (blue, lime, cyan, ink, transparent). One blurred edge introduces hundreds of blends and
//      this fails loudly, naming the offending colours and where they are.
//
// Check 2 is the real gate. The five target sizes are all integer multiples of the 16-unit grid
// (1x, 2x, 3x, 6x, 8x; 1024 is 64x), so a correct render has no partial blocks anywhere and every
// output pixel lands squarely inside one source block. A non-multiple size would be a design
// decision, not a rounding detail, so it is rejected rather than quietly fudged.
//
// The SVG is laid out alone on a transparent page at exactly the target size and screenshotted
// with omitBackground, so the PNG carries the alpha channel a toolbar icon needs. Rendering each
// size separately (rather than downscaling one big raster) lets the browser rasterize the vector
// at that size, which is what keeps the 16px edges hard.

import { chromium } from 'playwright';
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIZES = [16, 32, 48, 96, 128];
const GRID = 16;
const SOURCE_PNG = path.join(ROOT, 'assets', 'icon-source.png');

const src = path.resolve(ROOT, process.argv[2] ?? 'assets/icon.svg');
const outDir = path.resolve(ROOT, process.argv[3] ?? 'public/icon');

// ---------------------------------------------------------------------------
// A small PNG reader, so verification needs no new dependency
// ---------------------------------------------------------------------------

/**
 * Decode an 8-bit non-interlaced PNG to flat RGBA. This covers exactly what this script and
 * Chromium write; anything else throws rather than being silently misread.
 */
function decodePNG(file) {
  const b = fs.readFileSync(file);
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!b.subarray(0, 8).equals(sig)) throw new Error(`${file} is not a PNG`);

  let o = 8;
  let w, h, depth, colorType, interlace;
  const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') {
      w = b.readUInt32BE(o + 8);
      h = b.readUInt32BE(o + 12);
      depth = b[o + 16];
      colorType = b[o + 17];
      interlace = b[o + 20];
    } else if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    else if (type === 'IEND') break;
    o += len + 12;
  }
  if (depth !== 8) throw new Error(`${file}: bit depth ${depth} unsupported`);
  if (interlace) throw new Error(`${file}: interlaced PNGs unsupported`);
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`${file}: colour type ${colorType} unsupported`);

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const lines = Buffer.alloc(h * stride);
  // Undo the per-scanline filters (PNG spec 9.2). Each byte refers back `channels` bytes and up
  // one row, so this has to run in order.
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? lines[y * stride + x - channels] : 0;
      const up = y > 0 ? lines[(y - 1) * stride + x] : 0;
      const ul = x >= channels && y > 0 ? lines[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += up;
      else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) {
        const p = a + up - ul;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : ul;
      } else if (ft !== 0) throw new Error(`${file}: bad filter type ${ft} on row ${y}`);
      lines[y * stride + x] = v & 0xff;
    }
  }

  const px = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const s = i * channels;
    if (channels === 4) {
      px[i * 4] = lines[s]; px[i * 4 + 1] = lines[s + 1];
      px[i * 4 + 2] = lines[s + 2]; px[i * 4 + 3] = lines[s + 3];
    } else if (channels === 3) {
      px[i * 4] = lines[s]; px[i * 4 + 1] = lines[s + 1];
      px[i * 4 + 2] = lines[s + 2]; px[i * 4 + 3] = 255;
    } else if (channels === 2) {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = lines[s];
      px[i * 4 + 3] = lines[s + 1];
    } else {
      px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = lines[s];
      px[i * 4 + 3] = 255;
    }
  }
  return { width: w, height: h, px };
}

/**
 * A pixel's identity for comparison. Fully transparent pixels collapse to one key: with alpha 0
 * the RGB channels are invisible and encoders disagree about what to leave in them, so comparing
 * them would fail on a difference nobody can see.
 */
function colourKey(px, i) {
  return px[i + 3] === 0 ? 'transparent' : `${px[i]},${px[i + 1]},${px[i + 2]},${px[i + 3]}`;
}

const pretty = (key) =>
  key === 'transparent'
    ? 'transparent'
    : (() => {
        const [r, g, b, a] = key.split(',').map(Number);
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}${a === 255 ? '' : ` a=${a}`}`;
      })();

/** The set of colours the owner's artwork actually contains. */
function sourcePalette() {
  const im = decodePNG(SOURCE_PNG);
  const set = new Set();
  for (let i = 0; i < im.width * im.height; i++) set.add(colourKey(im.px, i * 4));
  return set;
}

/**
 * Assert one rendered icon: exact size, and not a single colour outside the source palette.
 * Throws with enough detail to see what went wrong rather than just that it did.
 */
function verify(file, size, palette) {
  const im = decodePNG(file);
  const rel = path.relative(ROOT, file);
  if (im.width !== size || im.height !== size) {
    throw new Error(`${rel} is ${im.width}x${im.height}, expected exactly ${size}x${size}`);
  }
  if (size % GRID !== 0) {
    throw new Error(`${rel}: ${size}px is not a whole multiple of the ${GRID}-unit grid`);
  }

  const bad = new Map();
  for (let y = 0; y < im.height; y++) {
    for (let x = 0; x < im.width; x++) {
      const key = colourKey(im.px, (y * im.width + x) * 4);
      if (!palette.has(key) && !bad.has(key)) bad.set(key, { x, y, n: 0 });
      if (!palette.has(key)) bad.get(key).n++;
    }
  }
  if (bad.size) {
    const detail = [...bad.entries()]
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 12)
      .map(([key, v]) => `      ${pretty(key)}  ${v.n}px, first at (${v.x},${v.y})`)
      .join('\n');
    throw new Error(
      `${rel} contains ${bad.size} colour(s) that are not in the source artwork — the render was ` +
        `interpolated rather than kept blocky:\n${detail}`,
    );
  }
  return im;
}

// ---------------------------------------------------------------------------

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
    written.push({ file, size });
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const palette = sourcePalette();
  console.log(
    `[icons] source palette (${palette.size}): ${[...palette].map(pretty).join('  ')}`,
  );

  const browser = await chromium.launch({ channel: 'chromium' });
  try {
    const targets = [...(await renderIcon(browser, src, outDir))];

    // The large avatar/branding PNG comes off the same vector through the same checks, so it can
    // never drift from the toolbar icons.
    if (path.resolve(src) === path.join(ROOT, 'assets', 'icon.svg')) {
      const bigDir = path.join(ROOT, 'docs', 'branding');
      const [big] = await renderIcon(browser, src, bigDir, [1024]);
      fs.renameSync(big.file, path.join(bigDir, 'icon-1024.png'));
      targets.push({ file: path.join(bigDir, 'icon-1024.png'), size: 1024 });
    }

    for (const { file, size } of targets) {
      verify(file, size, palette);
      console.log(`[icons] ${path.relative(ROOT, file).padEnd(30)} ${size}x${size}  verified`);
    }
    console.log(`[icons] ${targets.length} files: exact sizes, no colours outside the source artwork`);
  } finally {
    await browser.close();
  }
}
