#!/usr/bin/env node
// The README's video block, made from the rendered 16:9 master (out/usermods-launch-16x9.mp4):
//
//   docs/video-poster.{png,jpg}     1280x720 still: the demo mid-transformation (the page turning
//                                   dark under "Run once. The page changes."), with a pixel play
//                                   badge and the runtime in a corner chip
//   out/usermods-launch-readme.mp4  the master re-encoded to fit GitHub's 10 MB video attachment
//                                   cap: 1920x1080, H.264 High, yuv420p, two-pass, AAC 96k,
//                                   +faststart
//
//   node scripts/readme-assets.mjs [poster-time-seconds]
//
// The poster overlay is drawn in HTML (the brand's fonts, colours and pixel art) by the repo's own
// Playwright, then saved as PNG, or as JPEG when that is much smaller.

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(VIDEO, '..');
const MASTER = path.join(VIDEO, 'out', 'usermods-launch-16x9.mp4');
const README_MP4 = path.join(VIDEO, 'out', 'usermods-launch-readme.mp4');
const POSTER_T = Number(process.argv[2] ?? 21.6);
const CAP_BYTES = 10 * 1000 * 1000;

if (!fs.existsSync(MASTER)) throw new Error('render the master first: npm run render:all (or npm run render)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usermods-readme-'));
const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { cwd: VIDEO, stdio: 'inherit' });
const probe = (f, entries) =>
  execFileSync('ffprobe', ['-v', 'error', '-show_entries', entries, '-of', 'csv=p=0', f]).toString().trim();

// ---- poster -------------------------------------------------------------------------------
const frame = path.join(tmp, 'frame.png');
ff(['-ss', String(POSTER_T), '-i', MASTER, '-frames:v', '1', frame]);
const secs = Math.round(Number(probe(MASTER, 'format=duration')));
const runtime = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
const font = (f) => `url('file://${path.join(ROOT, 'node_modules/@fontsource', f)}')`;

// The play badge: a stepped pixel triangle, lime with a cyan lower edge, on an ink tile with a
// hard pink shadow, in the style of the icon and the banner. 12 x 12 grid.
const TRI = [
  'XX..........',
  'XXXX........',
  'XXXXXX......',
  'XXXXXXXX....',
  'XXXXXXXXXX..',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
  'XXXXXXXXXX..',
  'XXXXXXXX....',
  'XXXXXX......',
  'CCCC........',
  'CC..........',
];
const rects = TRI.flatMap((row, y) =>
  [...row].map((c, x) => (c === '.' ? '' : `<rect x="${x}" y="${y}" width="1" height="1" fill="${c === 'X' ? '#aeff24' : '#00e5f2'}"/>`)),
).join('');

const html = `<!doctype html><html><head><style>
  @font-face { font-family: 'Jersey 10'; src: ${font('jersey-10/files/jersey-10-latin-400-normal.woff2')}; }
  html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #030b16; }
  .bg { position: absolute; inset: 0; width: 1280px; height: 720px; }
  .shade { position: absolute; inset: 0; background: rgba(3, 11, 22, 0.28); }
  .badge { position: absolute; left: 50%; top: 50%; width: 168px; height: 168px; margin: -84px 0 0 -84px;
           background: #030b16; border: 6px solid #00e5f2; box-shadow: 12px 12px 0 #f343d3; box-sizing: border-box;
           display: flex; align-items: center; justify-content: center; }
  .badge svg { width: 84px; height: 84px; margin-left: 12px; image-rendering: pixelated; }
  .chip { position: absolute; right: 26px; top: 24px; padding: 4px 16px 6px; background: #030b16;
          border: 3px solid #aeff24; box-shadow: 6px 6px 0 #1008c8; color: #aeff24;
          font-family: 'Jersey 10'; font-size: 44px; line-height: 1; }
</style></head><body>
  <img class="bg" src="file://${frame}">
  <div class="shade"></div>
  <div class="chip">${runtime}</div>
  <div class="badge"><svg viewBox="0 0 12 12" shape-rendering="crispEdges">${rects}</svg></div>
</body></html>`;
const page = path.join(tmp, 'poster.html');
fs.writeFileSync(page, html);

const browser = await chromium.launch({ channel: 'chromium', headless: true });
const tab = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await tab.goto(`file://${page}`);
await tab.evaluate(() => document.fonts.ready);
const png = path.join(tmp, 'poster.png');
await tab.screenshot({ path: png });
await browser.close();

const jpg = path.join(tmp, 'poster.jpg');
ff(['-i', png, '-q:v', '3', jpg]);
const pngSize = fs.statSync(png).size;
const jpgSize = fs.statSync(jpg).size;
// PNG keeps the pixel art and the UI text exact; take JPEG only if the PNG is over budget.
const useJpg = pngSize > 400 * 1024 && jpgSize < pngSize / 2;
const posterOut = path.join(ROOT, 'docs', useJpg ? 'video-poster.jpg' : 'video-poster.png');
for (const ext of ['png', 'jpg']) fs.rmSync(path.join(ROOT, 'docs', `video-poster.${ext}`), { force: true });
fs.copyFileSync(useJpg ? jpg : png, posterOut);
console.log(`[readme] ${path.relative(ROOT, posterOut)} (${Math.round(fs.statSync(posterOut).size / 1024)} KB; png ${Math.round(pngSize / 1024)} KB, jpg ${Math.round(jpgSize / 1024)} KB)`);

// ---- README encode ------------------------------------------------------------------------
// Two-pass to a total that lands under the cap with ~10% headroom for the container.
const audioK = 96;
const videoK = Math.floor(((CAP_BYTES * 0.9 * 8) / secs) / 1000 - audioK);
const passlog = path.join(tmp, 'x264');
const common = ['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-r', '30', '-b:v', `${videoK}k`, '-preset', 'slow', '-passlogfile', passlog];
ff(['-i', MASTER, ...common, '-pass', '1', '-an', '-f', 'mp4', '/dev/null']);
ff(['-i', MASTER, ...common, '-pass', '2', '-c:a', 'aac', '-b:a', `${audioK}k`, '-ac', '2', '-movflags', '+faststart', README_MP4]);
const size = fs.statSync(README_MP4).size;
console.log(`[readme] ${path.relative(ROOT, README_MP4)} (${(size / 1e6).toFixed(2)} MB, video ${videoK} kbps + AAC ${audioK} kbps)`);
if (size >= CAP_BYTES) console.warn('[readme] WARNING: over the 10 MB cap');
fs.rmSync(tmp, { recursive: true, force: true });
