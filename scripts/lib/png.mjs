// PNG decoding and colour comparison, shared by the icon generators.
//
// Extracted from scripts/render-icons.mjs when scripts/render-app-icon.mjs needed the same three
// functions: the toolbar icons and the native app icon come off the same vector and are held to
// the same no-interpolation rule, and two copies of a PNG decoder would be two things to keep in
// step. Nothing here is general-purpose — it covers exactly what these scripts and Chromium write,
// and throws on anything else rather than silently misreading it. No dependency, deliberately:
// verification that needs a library is verification someone will skip.

import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Decode an 8-bit non-interlaced PNG to flat RGBA. This covers exactly what this script and
 * Chromium write; anything else throws rather than being silently misread.
 */
export function decodePNG(file) {
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
export function colourKey(px, i) {
  return px[i + 3] === 0 ? 'transparent' : `${px[i]},${px[i + 1]},${px[i + 2]},${px[i + 3]}`;
}

export const pretty = (key) =>
  key === 'transparent'
    ? 'transparent'
    : (() => {
        const [r, g, b, a] = key.split(',').map(Number);
        return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}${a === 255 ? '' : ` a=${a}`}`;
      })();
