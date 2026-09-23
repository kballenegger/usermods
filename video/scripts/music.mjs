#!/usr/bin/env node
// Synthesises the launch video's chiptune bed from nothing: pulse-wave bass and arpeggio, a
// triangle lead, and noise/pitch-swept drums, written sample by sample into a 16-bit WAV.
//
// No samples, loops or third-party audio of any kind. The output is fully deterministic (the noise
// comes from a seeded PRNG), so re-running it produces a byte-identical file.
//
//   node scripts/music.mjs [out.wav] [seconds] [cuts JSON]

import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] ?? 'assets/audio/chiptune.wav';
const SECONDS = Number(process.argv[3] ?? 60.5);
const RATE = 44100;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5 s
const STEP = BEAT / 4; // sixteenth notes
const N = Math.round(SECONDS * RATE);

// A minor, the classic four-chord loop: Am – F – C – G, one bar each.
const CHORDS = [
  [57, 60, 64], // A C E
  [53, 57, 60], // F A C
  [48, 52, 55], // C E G
  [55, 59, 62], // G B D
];
const hz = (m) => 440 * 2 ** ((m - 69) / 12);

// Lead melody over the four bars, in sixteenths: [step, midi, lengthInSteps].
const LEAD = [
  [0, 76, 3], [4, 74, 2], [6, 72, 2], [8, 69, 4], [12, 72, 4],
  [16, 72, 3], [20, 69, 2], [22, 72, 2], [24, 77, 6], [30, 76, 2],
  [32, 76, 3], [36, 79, 2], [38, 76, 2], [40, 72, 4], [44, 76, 4],
  [48, 74, 3], [52, 71, 2], [54, 74, 2], [56, 79, 6], [62, 74, 2],
];

let seed = 0x5eed1234;
const rand = () => {
  seed ^= seed << 13; seed >>>= 0;
  seed ^= seed >>> 17;
  seed ^= seed << 5; seed >>>= 0;
  return seed / 0x100000000;
};

const pulse = (phase, duty) => ((phase % 1) < duty ? 1 : -1);
const tri = (phase) => 1 - 4 * Math.abs((phase % 1) - 0.5);

// Arrangement by bar (2 s per bar at 120 BPM), driven by the video's scene cuts, which all sit on
// the 0.5 s beat grid: arp + bass throughout; drums from the bar holding the first cut; the lead
// from the bar line of the demo cut; a two-bar breakdown across the move into the feature beats;
// the lead leaves at the end card and the drums two bars later.
//   node scripts/music.mjs out.wav 60.5 '{"problem":4.5,"demo":8,"feat":30.5,"end":51.5}'
const CUTS = JSON.parse(process.argv[4] ?? '{"problem":4.5,"demo":8,"feat":30.5,"end":51.5}');
const BAR = BEAT * 4;
const barOf = (t) => Math.floor(t / BAR);
function layers(bar) {
  const breakdown = bar >= barOf(CUTS.feat) && bar < barOf(CUTS.feat) + 2;
  return {
    arp: 1,
    bass: 1,
    drums: bar >= barOf(CUTS.problem) && !breakdown && bar < barOf(CUTS.end) + 2 ? 1 : 0,
    lead: bar >= barOf(CUTS.demo) && !breakdown && bar * BAR < CUTS.end - BAR ? 1 : 0,
  };
}

const buf = new Float32Array(N);
const env = (t, a, d) => (t < a ? t / a : Math.exp(-(t - a) / d));

// Render note by note rather than sample by sample, so each voice keeps its own phase.
function addTone(start, dur, f, amp, shape, decay = 0.25) {
  const s0 = Math.round(start * RATE);
  const len = Math.round(dur * RATE);
  let ph = 0;
  for (let i = 0; i < len && s0 + i < N; i++) {
    const t = i / RATE;
    const release = Math.min(1, (len - i) / (0.01 * RATE));
    buf[s0 + i] += shape(ph) * amp * env(t, 0.004, decay) * release;
    ph += f / RATE;
  }
}

function kick(start) {
  const s0 = Math.round(start * RATE);
  let ph = 0;
  for (let i = 0; i < 0.18 * RATE && s0 + i < N; i++) {
    const t = i / RATE;
    const f = 150 * Math.exp(-t * 28) + 45;
    buf[s0 + i] += tri(ph) * 0.55 * Math.exp(-t * 18);
    ph += f / RATE;
  }
}

function noise(start, dur, amp) {
  const s0 = Math.round(start * RATE);
  let held = 0;
  for (let i = 0; i < dur * RATE && s0 + i < N; i++) {
    if (i % 3 === 0) held = rand() * 2 - 1; // sample-and-hold: the NES noise channel's grit
    buf[s0 + i] += held * amp * Math.exp(-(i / RATE) * 40);
  }
}

const bars = Math.ceil(SECONDS / (BEAT * 4));
for (let bar = 0; bar < bars; bar++) {
  const L = layers(bar);
  const chord = CHORDS[bar % 4];
  const t0 = bar * BEAT * 4;
  for (let s = 0; s < 16; s++) {
    const t = t0 + s * STEP;
    if (t >= SECONDS - 0.05) break;
    if (L.arp) {
      const note = chord[s % 3] + 12 + (s % 6 >= 3 ? 12 : 0);
      addTone(t, STEP * 0.9, hz(note), 0.07, (p) => pulse(p, 0.125), 0.09);
    }
    if (L.bass && s % 2 === 0) {
      const root = chord[0] - 24 + (s % 8 === 6 ? 12 : 0);
      addTone(t, STEP * 1.6, hz(root), 0.11, (p) => pulse(p, 0.25), 0.2);
    }
    if (L.drums) {
      if (s % 8 === 0) kick(t);
      if (s % 8 === 4) noise(t, 0.12, 0.22);
      if (s % 2 === 1) noise(t, 0.03, 0.06);
    }
  }
  if (L.lead) {
    const phrase = bar % 4;
    for (const [st, m, len] of LEAD) {
      if (Math.floor(st / 16) !== phrase) continue;
      addTone(t0 + (st % 16) * STEP, len * STEP * 0.95, hz(m), 0.12, tri, 0.5);
    }
  }
}

// Ending: one held A minor chord on the final downbeat.
const endAt = (bars - 2) * BEAT * 4;
if (endAt < SECONDS) for (const m of CHORDS[0]) addTone(endAt, Math.min(3, SECONDS - endAt), hz(m + 12), 0.06, (p) => pulse(p, 0.25), 1.2);

// Master: fade in/out, soft clip, 16-bit PCM.
const pcm = Buffer.alloc(N * 2);
for (let i = 0; i < N; i++) {
  const t = i / RATE;
  const fade = Math.min(1, t / 0.4, (SECONDS - t) / 2.0);
  const v = Math.tanh(buf[i] * 1.2) * 0.8 * Math.max(0, fade);
  pcm.writeInt16LE(Math.round(v * 32767), i * 2);
}
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, Buffer.concat([header, pcm]));
console.log(`[music] ${OUT} (${SECONDS}s, ${(pcm.length / 1e6).toFixed(1)} MB)`);
