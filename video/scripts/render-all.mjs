#!/usr/bin/env node
// Renders every aspect-ratio variant into out/:
//
//   usermods-launch-16x9.mp4   1920x1080, the master (also copied to usermods-launch.mp4)
//   usermods-launch-1x1.mp4    1080x1080
//   usermods-launch-9x16.mp4   1080x1920
//   usermods-launch-x.mp4      1080x1080, the X post cut, re-encoded to X's recommended settings
//
// The X cut is rendered like the others, then re-encoded with ffmpeg: H.264 High, yuv420p,
// 30 fps constant, closed 2 s GOPs, 5 Mbps constant-rate video (the minimum bitrate X's media
// best-practices page recommends; X re-encodes on upload, so a thinner file only loses quality), AAC-LC 128 kbps stereo at 48 kHz, and +faststart so it starts playing before it has
// fully downloaded.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANTS } from './variants.mjs';

const VIDEO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const only = process.argv.slice(2);
const run = (cmd, args) => execFileSync(cmd, args, { cwd: VIDEO, stdio: 'inherit' });

run(process.execPath, ['scripts/prepare.mjs']);
fs.mkdirSync(path.join(VIDEO, 'out'), { recursive: true });

for (const v of VARIANTS) {
  if (only.length && !only.includes(v.layout) && !only.includes(v.file) && !only.includes(v.out)) continue;
  const target = path.join('out', v.raw ?? v.out);
  console.log(`\n[render-all] ${v.file} -> ${target}`);
  run(process.execPath, ['scripts/render.mjs', '--composition', v.file, '--quality', 'delivery', '--fps', '30', '--output', target]);
  if (v.raw) {
    run('ffmpeg', [
      '-v', 'error', '-y', '-i', target,
      '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-r', '30',
      '-b:v', '5M', '-minrate', '5M', '-maxrate', '5M', '-bufsize', '10M', '-x264-params', 'nal-hrd=cbr', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '128k', '-ar', '48000', '-ac', '2',
      '-movflags', '+faststart', path.join('out', v.out),
    ]);
    fs.rmSync(path.join(VIDEO, target));
  }
  if (v.file === 'index.html') fs.copyFileSync(path.join(VIDEO, 'out', v.out), path.join(VIDEO, 'out', 'usermods-launch.mp4'));
}
