#!/usr/bin/env node
// Writes one standalone HyperFrames composition per aspect ratio from the shared sources:
//
//   src/body.html   the scenes' markup, with {{placeholders}} for size and timing
//   src/launch.css  the styles, with per-layout sections keyed on #root[data-layout]
//   src/launch.js   the timeline, which reads window.LAYOUT
//
// Outputs: index.html (16:9, the master) at the project root, and variants/square.html (1:1),
// variants/vertical.html (9:16) and variants/x.html (the X post cut, 1:1 and shorter). HyperFrames
// wants exactly one root composition per project, so the others live one folder down; HyperFrames
// serves every composition with the project root as its base URL, so their asset paths are the
// same root-relative ones. Each is self-contained and renders with
// `hyperframes render --composition <file>`. Edit the sources, not the outputs.
//
// Also exported: VARIANTS, the list render-all.mjs and prepare.mjs work from.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MASTER_CUTS = { problem: 4.5, demo: 8, feat: 30, end: 51, total: 60 };

/** Problem lines: one line per sentence where it fits, shorter lines in the narrow shapes. */
const LINES_WIDE = [
  ['l-white', 'Every site is almost how you want it.'],
  ['l-cyan', "Say what's wrong."],
  ['l-white', '<span class="l-lime">usermods</span> writes the fix.', 'last'],
];
const LINES_NARROW = [
  ['l-white', 'Every site is almost'],
  ['l-white', 'how you want it.', 'cont'],
  ['l-cyan', "Say what's wrong."],
  ['l-white', '<span class="l-lime">usermods</span> writes the fix.', 'last'],
];

const SQUARE_CAM = {
  Z: 1.75,
  panelX: 270,
  band: [40, 880],
  wide: [0.58, 960, 522, 540, 462],
  site: [0.79, 740, 544, 540, 462],
  savePanel: true,
};

export const VARIANTS = [
  {
    file: 'index.html',
    out: 'usermods-launch-16x9.mp4',
    layout: 'wide',
    W: 1920,
    H: 1080,
    cuts: MASTER_CUTS,
    audio: 'assets/audio/chiptune.wav',
    lines: LINES_WIDE,
    config: {
      featDur: 4.2,
      problemCps: 46,
      shotW: 672,
      shotMaxH: 880,
      keepOut: { open: [[140, 150, 1780, 820]], end: [[140, 90, 1780, 820]] },
      cam: { Z: 1.75, panelX: 1110, band: [24, 1050], wide: [1, 0, 0, 0, 0], site: [1, 0, 0, 0, 0], savePanel: false },
    },
  },
  {
    file: 'variants/square.html',
    out: 'usermods-launch-1x1.mp4',
    layout: 'square',
    W: 1080,
    H: 1080,
    cuts: MASTER_CUTS,
    audio: 'assets/audio/chiptune.wav',
    lines: LINES_NARROW,
    config: {
      featDur: 4.2,
      problemCps: 46,
      shotW: 450,
      shotMaxH: 950,
      keepOut: { open: [[40, 210, 1040, 700]], end: [[40, 110, 1040, 800]] },
      cam: SQUARE_CAM,
    },
  },
  {
    file: 'variants/vertical.html',
    out: 'usermods-launch-9x16.mp4',
    layout: 'tall',
    W: 1080,
    H: 1920,
    cuts: MASTER_CUTS,
    audio: 'assets/audio/chiptune.wav',
    lines: LINES_NARROW,
    config: {
      featDur: 4.2,
      problemCps: 46,
      shotW: 560,
      shotMaxH: 730,
      keepOut: { open: [[40, 540, 1040, 1180]], end: [[40, 360, 1040, 1300]] },
      cam: { Z: 2.0, panelX: 100, band: [400, 1480], wide: [0.58, 960, 522, 540, 900], site: [1.0, 610, 544, 540, 940], savePanel: true },
    },
  },
  {
    // The X post: square (it takes the most timeline height of the shapes X plays inline without
    // cropping), under a minute, and legible from the first frame with the sound off.
    file: 'variants/x.html',
    out: 'usermods-launch-x.mp4',
    raw: 'usermods-launch-x-master.mp4',
    layout: 'square',
    W: 1080,
    H: 1080,
    cuts: { problem: 3, demo: 6, feat: 28, end: 45, total: 51 },
    audio: 'assets/audio/chiptune-x.wav',
    lines: LINES_NARROW,
    config: {
      hook: true,
      endFast: true,
      featDur: 3.4,
      problemCps: 60,
      shotW: 450,
      shotMaxH: 950,
      keepOut: { open: [[40, 210, 1040, 700]], end: [[40, 110, 1040, 800]] },
      cam: SQUARE_CAM,
    },
  },
];

function problemLines(lines) {
  return lines
    .map(([cls, html, flag], i) => {
      const cont = flag === 'cont' ? ' data-cont="1"' : '';
      const caret = flag === 'last' ? '<span class="caret l-lime" id="p-caret"></span>' : '';
      return `          <div class="line ${cls}"><span class="typed" id="p${i + 1}"${cont}>${html}</span>${caret}</div>`;
    })
    .join('\n');
}

function render(v) {
  const read = (f) => fs.readFileSync(path.join(VIDEO, 'src', f), 'utf8');
  const c = v.cuts;
  const vars = {
    LAYOUT: v.layout,
    W: v.W,
    H: v.H,
    TOTAL: c.total,
    D_OPEN: c.problem,
    T_PROBLEM: c.problem,
    D_PROBLEM: c.demo - c.problem,
    T_DEMO: c.demo,
    D_DEMO: c.feat - c.demo,
    T_FEAT: c.feat,
    D_FEAT: c.end - c.feat,
    T_END: c.end,
    D_END: c.total - c.end,
    AUDIO: v.audio,
    PROBLEM_LINES: problemLines(v.lines),
  };
  const body = read('body.html').replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`no value for {{${k}}}`);
    return String(vars[k]);
  });
  const layout = { W: v.W, H: v.H, cuts: c, ...v.config };
  return `<!doctype html>
<!-- GENERATED by scripts/variants.mjs from src/ — edit src/body.html, src/launch.css, src/launch.js. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${v.W}, height=${v.H}" />
    <title>usermods launch video (${v.layout}, ${v.W}x${v.H})</title>
    <!-- Everything is local: gsap and the fonts are staged by scripts/prepare.mjs, the capture
         manifest is written by capture/capture.mjs. Nothing is fetched at render time. -->
    <script src="assets/vendor/gsap.min.js"></script>
    <script src="assets/capture/capture.js"></script>
    <style>
${read('launch.css').replace(/html, body \{ width: 1920px; height: 1080px;/, `html, body { width: ${v.W}px; height: ${v.H}px;`)}
    </style>
  </head>
  <body>
${body}
    <script>
      window.LAYOUT = ${JSON.stringify(layout)};
    </script>
    <script>
${read('launch.js')}
    </script>
  </body>
</html>
`;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  for (const v of VARIANTS) {
    fs.mkdirSync(path.dirname(path.join(VIDEO, v.file)), { recursive: true });
    fs.writeFileSync(path.join(VIDEO, v.file), render(v));
    console.log(`[variants] ${v.file} (${v.layout} ${v.W}x${v.H}, ${v.cuts.total}s)`);
  }
}
