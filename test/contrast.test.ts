// Contrast is a gate, not a vibe.
//
// This reads the real token file — entrypoints/sidepanel/tokens.css, the same one the extension
// ships — resolves both themes, and asserts WCAG AA for every foreground/background pairing the UI
// actually puts on screen. The pairings are listed explicitly below rather than derived, because
// the thing worth checking is what the components really do: `.tabs button.active` really does put
// --accent-text on --volt-a12, and that is the pair that has to pass.
//
// The thresholds are WCAG 2.1:
//   4.5:1  normal body text
//   3.0:1  large text (>=18.66px bold or >=24px), and non-text UI components and their boundaries
//
// It also holds two structural invariants that are easy to break by hand: the light theme must be
// glow-free, and the two blocks that light can be reached through (an explicit data-theme, and the
// OS preference) must declare identical values.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TOKENS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'entrypoints',
  'sidepanel',
  'tokens.css',
);

const css = fs.readFileSync(TOKENS, 'utf8');

// ---------------------------------------------------------------------------
// Parsing the token file
// ---------------------------------------------------------------------------

/** Strip comments so a hex inside prose (there are several) is never read as a value. */
function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The declarations of one top-level block, by selector text. */
function block(selector: string): Record<string, string> {
  const i = css.indexOf(selector + ' {');
  assert.notEqual(i, -1, `tokens.css no longer contains a block for ${selector}`);
  const start = css.indexOf('{', i);
  // Walk to the matching brace so a nested block cannot end the scan early.
  let depth = 0;
  let end = start;
  for (let j = start; j < css.length; j++) {
    if (css[j] === '{') depth++;
    else if (css[j] === '}' && --depth === 0) {
      end = j;
      break;
    }
  }
  const out: Record<string, string> = {};
  for (const line of stripComments(css.slice(start + 1, end)).split('\n')) {
    const m = /^\s*(--[a-z0-9-]+)\s*:\s*(.+?);\s*$/.exec(line);
    if (m?.[1] && m[2]) out[m[1]] = m[2].trim();
  }
  return out;
}

const dark = block(':root');
const light = block(":root[data-theme='light']");

/** Resolve `var(--x)` chains within a theme, falling back to the dark base the way CSS does. */
function resolve(theme: Record<string, string>, name: string, seen = new Set<string>()): string {
  assert.ok(!seen.has(name), `circular var reference at ${name}`);
  seen.add(name);
  const raw = theme[name] ?? dark[name];
  assert.ok(raw !== undefined, `token ${name} is not defined in tokens.css`);
  const m = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  return m?.[1] ? resolve(theme, m[1], seen) : raw;
}

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

type Rgb = [number, number, number];

/** The numbers inside an rgb()/rgba(), or null if this is not one. */
function rgbaParts(v: string): number[] | null {
  const m = /^rgba?\(([^)]+)\)$/i.exec(v.trim());
  if (!m?.[1]) return null;
  return m[1].split(',').map((x) => parseFloat(x));
}

function parseColor(v: string): Rgb {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v.trim());
  if (hex?.[1]) {
    const g = hex[1];
    const h = g.length === 3 ? g.split('').map((c) => c + c).join('') : g;
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  }
  const p = rgbaParts(v);
  if (p && p.length >= 3) return [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0];
  throw new Error(`not a flat colour: ${v}`);
}

/** An rgba() over an opaque backdrop, which is how the alpha tints actually render. */
function flatten(v: string, over: Rgb): Rgb {
  const p = rgbaParts(v);
  if (!p || p.length < 4) return parseColor(v);
  const a = p[3] ?? 1;
  const mix = (i: 0 | 1 | 2) => (p[i] ?? 0) * a + over[i] * (1 - a);
  return [mix(0), mix(1), mix(2)];
}

function luminance([r, g, b]: Rgb): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(fg: Rgb, bg: Rgb): number {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a >= b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

// ---------------------------------------------------------------------------
// The surfaces a foreground can land on
// ---------------------------------------------------------------------------

/**
 * The card surface is a gradient. Both of its stops are checked wherever a card is the backdrop,
 * so a value that only passes against the lighter end of the dark gradient cannot slip through.
 */
function cardStops(theme: Record<string, string>): [Rgb, Rgb] {
  return [parseColor(resolve(theme, '--surface-hi')), parseColor(resolve(theme, '--surface-lo'))];
}

function appBg(theme: Record<string, string>): Rgb {
  return parseColor(resolve(theme, '--bg-app'));
}

/** Pairings the UI really renders. Each is checked in both themes. */
type Pair = {
  what: string;
  fg: string;
  /** Backdrops this foreground sits on, resolved per theme. */
  on: (t: Record<string, string>) => Array<{ label: string; rgb: Rgb }>;
  min: number;
};

const card = (t: Record<string, string>) =>
  cardStops(t).map((rgb, i) => ({ label: i === 0 ? 'card (top)' : 'card (bottom)', rgb }));
const app = (t: Record<string, string>) => [{ label: 'app bg', rgb: appBg(t) }];
const both = (t: Record<string, string>) => [...app(t), ...card(t)];

/** A tint token over the surface it is drawn on, flattened if it carries alpha. */
const tintOver =
  (token: string, base: 'card' | 'app') =>
  (t: Record<string, string>) => {
    const backdrop = base === 'app' ? appBg(t) : cardStops(t)[0];
    return [{ label: `${token} on ${base}`, rgb: flatten(resolve(t, token), backdrop) }];
  };

const PAIRS: Pair[] = [
  // --- Body text -----------------------------------------------------------
  { what: 'text-1 (primary copy)', fg: '--text-1', on: both, min: 4.5 },
  { what: 'text-2 (descriptions, help, notice bodies)', fg: '--text-2', on: both, min: 4.5 },
  {
    // The faintest step. It carries placeholder text and list markers, which are content.
    what: 'text-3 (placeholders, markers, meta)',
    fg: '--text-3',
    on: both,
    min: 4.5,
  },

  // --- Accent text ---------------------------------------------------------
  { what: 'accent text (links, .ok, wordmark)', fg: '--accent-text', on: both, min: 4.5 },
  {
    // The active tab label, and the .chip.ref an element reference wears.
    what: 'accent text on the volt tint (active tab, element chip)',
    fg: '--accent-text',
    on: (t) => [...tintOver('--volt-a12', 'app')(t), ...tintOver('--volt-a10', 'card')(t)],
    min: 4.5,
  },

  // --- Buttons -------------------------------------------------------------
  {
    what: 'primary button label on its fill',
    fg: '--btn-primary-fg',
    on: (t) => [{ label: 'btn-primary-bg', rgb: parseColor(resolve(t, '--btn-primary-bg')) }],
    min: 4.5,
  },
  {
    // The disabled primary keeps the accent, on the volt-a25 tint rather than the full fill.
    what: 'disabled primary label on its muted fill',
    fg: '--btn-disabled-fg',
    on: (t) => [{ label: 'volt-a25', rgb: flatten(resolve(t, '--volt-a25'), cardStops(t)[0]) }],
    min: 4.5,
  },

  // --- Chips ---------------------------------------------------------------
  {
    what: 'chip text on the well it sits on',
    fg: '--text-1',
    on: (t) => [{ label: 'surface-well', rgb: parseColor(resolve(t, '--surface-well')) }],
    min: 4.5,
  },
  {
    what: 'warn chip text on its background',
    fg: '--warn-text',
    on: (t) => [{ label: 'warn-bg', rgb: flatten(resolve(t, '--warn-bg'), cardStops(t)[0]) }],
    min: 4.5,
  },

  // --- Semantic text -------------------------------------------------------
  { what: 'error text', fg: '--error-text', on: both, min: 4.5 },
  {
    what: 'error text on its background',
    fg: '--error-text',
    on: (t) => [{ label: 'error-bg', rgb: flatten(resolve(t, '--error-bg'), cardStops(t)[0]) }],
    min: 4.5,
  },
  { what: 'warn text', fg: '--warn-text', on: both, min: 4.5 },

  // --- Non-text UI: 3:1 ----------------------------------------------------
  {
    what: 'focus ring against both surfaces',
    fg: '--focus-ring',
    on: both,
    min: 3,
  },
  { what: 'status dot: ok', fg: '--dot-ok', on: both, min: 3 },
  { what: 'status dot: warn', fg: '--dot-warn', on: both, min: 3 },
  { what: 'status dot: error', fg: '--dot-error', on: both, min: 3 },
  {
    // The toggle's "on" track is the one control whose state is carried by colour alone.
    what: 'enabled toggle track',
    fg: '--volt',
    on: card,
    min: 3,
  },

  // --- The dashboard (entrypoints/dashboard/dashboard.css) -----------------
  //
  // The full-tab page reuses the panel's tokens but puts several of them in places the panel does
  // not, so these are the pairings that page specifically has to clear.
  {
    // .rowcard sits on the app background rather than inside a card, and :hover/.selected raise its
    // edge to the accent — which is then the sole marker of which row is chosen. (The RESTING edge
    // is deliberately not listed: --border-card is 1.10:1 on the light page, which is why the row,
    // the stat and the bulk bar all take --shadow-raise. The shadow test below is what holds that.)
    what: 'dashboard: selected/hovered row edge and the active section rule',
    fg: '--accent-text',
    on: both,
    min: 3,
  },
  {
    // The transcript preview insets a bubble and the source editor inside a white card. Both are
    // --surface-well there, and both carry real prose.
    what: 'dashboard: preview bubble and editor text on the well',
    fg: '--text-1',
    on: (t) => [{ label: 'surface-well', rgb: parseColor(resolve(t, '--surface-well')) }],
    min: 4.5,
  },
  {
    // .preview .prev-tool is --text-3 on the well, and it is the tool trace someone reads.
    what: 'dashboard: tool trace on the well',
    fg: '--text-3',
    on: (t) => [{ label: 'surface-well', rgb: parseColor(resolve(t, '--surface-well')) }],
    min: 4.5,
  },
  {
    // A disabled pill and a dimmed row both recede to the well in light rather than fading, so the
    // label they keep still has to be readable — that is the whole point of not using opacity.
    what: 'dashboard: disabled pill label on the well it recedes to',
    fg: '--text-3',
    on: (t) => [{ label: 'surface-well', rgb: parseColor(resolve(t, '--surface-well')) }],
    min: 4.5,
  },
  {
    // .preview .prev-tool.is-error and .error's border are the only markers those two carry.
    what: 'dashboard: error rail and error notice edge',
    fg: '--error-text',
    on: (t) => [...both(t), { label: 'surface-well', rgb: parseColor(resolve(t, '--surface-well')) }],
    min: 3,
  },
  {
    // The .badge.warn outline doubles as its only fill-free marker.
    what: 'dashboard: warn badge outline',
    fg: '--warn-text',
    on: both,
    min: 3,
  },
];

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

const THEMES: Array<[string, Record<string, string>]> = [
  ['dark', dark],
  ['light', light],
];

for (const [themeName, theme] of THEMES) {
  test(`${themeName}: every rendered text and UI pairing meets WCAG AA`, () => {
    const failures: string[] = [];
    for (const pair of PAIRS) {
      const fg = parseColor(resolve(theme, pair.fg));
      for (const bg of pair.on(theme)) {
        const r = contrast(fg, bg.rgb);
        if (r < pair.min) {
          failures.push(
            `${pair.what}: ${pair.fg} on ${bg.label} is ${r.toFixed(2)}:1, needs ${pair.min}:1`,
          );
        }
      }
    }
    assert.deepEqual(failures, [], `\n  ${failures.join('\n  ')}\n`);
  });
}

test('light has no glows: the neon is the dark theme’s signature alone', () => {
  // The hero card is the one exception the design system grants light: a faint volt-tinted lift,
  // which is a shadow rather than a glow. Everything else must be flat.
  for (const token of ['--glow-dot', '--glow-fill', '--glow-text', '--glow-tab']) {
    assert.equal(light[token], 'none', `${token} must be none in the light theme`);
  }
  const hero = light['--glow-hero'];
  assert.ok(hero !== undefined, '--glow-hero should be restated for light');
  assert.ok(
    !/rgba\(200,\s*255,\s*46/.test(hero),
    'the light hero lift must not use the dark theme’s neon volt',
  );
});

test('light gives cards the lift that replaces the border it cannot rely on', () => {
  assert.equal(dark['--shadow-card'], 'none', 'dark cards take no drop shadow');
  assert.notEqual(light['--shadow-card'], 'none', 'light cards need a faint shadow');
});

test('both routes into the light theme declare identical values', () => {
  // CSS cannot share a declaration block between a plain selector and a media query, so the light
  // values are written twice: once for an explicit data-theme="light", once under
  // prefers-color-scheme for Theme: System. A change made to one and not the other would give a
  // user a different palette depending on how they arrived at light, which is exactly the kind of
  // drift nobody notices by eye.
  const mq = css.indexOf('@media (prefers-color-scheme: light)');
  assert.notEqual(mq, -1, 'the prefers-color-scheme block is missing');
  const system = block(':root:not([data-theme])');
  assert.deepEqual(
    system,
    light,
    'the System (prefers-color-scheme) light block has drifted from the explicit light block',
  );
});

test('the light theme restates every token the dark theme would otherwise leak', () => {
  // A token left out of the light block inherits the dark value. That is correct for the
  // structural ones (type, radii, spacing) and a bug for anything that carries colour.
  const COLOUR = /^--(bg|surface|border|text|volt|accent|btn|focus|warn|error|dot|fill|track|selection|shadow|glow)/;
  const missing = Object.keys(dark).filter((k) => COLOUR.test(k) && !(k in light));
  assert.deepEqual(missing, [], `these colour tokens are not restated for light: ${missing.join(', ')}`);
});
