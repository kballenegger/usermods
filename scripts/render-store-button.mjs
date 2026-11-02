#!/usr/bin/env node
// Writes docs/store-button.svg, the "Add to Chrome" button at the top of the README, from
// assets/icon.svg and a small bitmap font. GitHub strips CSS from a README and an <img> cannot load
// a web font, so the button is an image and its lettering is drawn as pixels, like the banner's.
//
//   node scripts/render-store-button.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'store-button.svg');

// The working palette in docs/branding.md.
const BLUE = '#1008C8';
const LIME = '#AEFF24';
const CYAN = '#00E5F2';
const INK = '#030B16';

/** Five columns by seven rows, only the letters the button uses. */
const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  ' ': ['000', '000', '000', '000', '000', '000', '000'],
};

/** One path for a line of text, each lit font pixel a square of `size`. */
function lettering(text, x, y, size) {
  let d = '';
  let left = x;
  for (const ch of text) {
    const rows = FONT[ch];
    if (!rows) throw new Error(`No glyph for ${JSON.stringify(ch)}`);
    rows.forEach((row, r) => {
      [...row].forEach((bit, c) => {
        if (bit === '1') d += `M${left + c * size} ${y + r * size}h${size}v${size}h-${size}z`;
      });
    });
    left += (rows[0].length + 1) * size;
  }
  return d;
}

function textWidth(text, size) {
  return ([...text].reduce((sum, ch) => sum + FONT[ch][0].length + 1, 0) - 1) * size;
}

const HEADLINE = 'ADD TO CHROME';
const CAPTION = 'FREE ON THE CHROME WEB STORE';
const HEADLINE_SIZE = 6;
const CAPTION_SIZE = 2;

const SHADOW = 8; // The hard offset shadow, on the 2px grid the frame is drawn on.
const FRAME = 4;
const ICON_SCALE = 4; // A whole multiple of the icon's 16-unit grid, so it stays crisp.
const ICON = 16 * ICON_SCALE;
const PAD = 24;
const GAP = 24;

const textLeft = FRAME + PAD + ICON + GAP;
const textRight = textLeft + Math.max(textWidth(HEADLINE, HEADLINE_SIZE), textWidth(CAPTION, CAPTION_SIZE));
const faceW = textRight + PAD + FRAME;
const faceH = FRAME * 2 + PAD * 2 + ICON;
const width = faceW + SHADOW;
const height = faceH + SHADOW;

const headlineH = 7 * HEADLINE_SIZE;
const captionH = 7 * CAPTION_SIZE;
const lineGap = 8;
const headlineY = (faceH - headlineH - lineGap - captionH) / 2;
const captionY = headlineY + headlineH + lineGap;

// The icon's paths, kept as the canonical file has them.
const iconPaths = fs
  .readFileSync(path.join(ROOT, 'assets', 'icon.svg'), 'utf8')
  .match(/<path [^>]+\/>/g)
  .join('');

// The tile is blue on a blue button, so an ink box behind it keeps the mark's edge visible.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges" role="img" aria-labelledby="title">
  <title id="title">Add to Chrome: free on the Chrome Web Store</title>
  <rect x="${SHADOW}" y="${SHADOW}" width="${faceW}" height="${faceH}" fill="${INK}"/>
  <rect width="${faceW}" height="${faceH}" fill="${LIME}"/>
  <rect x="${FRAME}" y="${FRAME}" width="${faceW - FRAME * 2}" height="${faceH - FRAME * 2}" fill="${BLUE}"/>
  <rect x="${FRAME + PAD - 2}" y="${FRAME + PAD - 2}" width="${ICON + 4}" height="${ICON + 4}" fill="${INK}"/>
  <g transform="translate(${FRAME + PAD} ${FRAME + PAD}) scale(${ICON_SCALE})">${iconPaths}</g>
  <path fill="${INK}" d="${lettering(HEADLINE, textLeft + 3, headlineY + 3, HEADLINE_SIZE)}"/>
  <path fill="${CYAN}" d="${lettering(HEADLINE, textLeft, headlineY + 2, HEADLINE_SIZE)}"/>
  <path fill="${LIME}" d="${lettering(HEADLINE, textLeft, headlineY, HEADLINE_SIZE)}"/>
  <path fill="#FFFFFF" d="${lettering(CAPTION, textLeft, captionY, CAPTION_SIZE)}"/>
</svg>
`;

fs.writeFileSync(OUT, svg);
console.log(`${path.relative(ROOT, OUT)}: ${width} x ${height}`);
