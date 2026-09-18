// Contrast is a gate, not a vibe.
//
// This reads the real token file — entrypoints/sidepanel/tokens.css, the same one the extension
// ships — resolves both themes, and asserts WCAG AA for every foreground/background pairing the UI
// actually puts on screen. The pairings are listed explicitly below rather than derived, because
// the thing worth checking is what the components really do: `.tabs button.active` really does put
// --live-on-fill on --live-fill, and that is the pair that has to pass.
//
// The thresholds are WCAG 2.1:
//   4.5:1  normal body text
//   3.0:1  large text (>=18.66px bold or >=24px), and non-text UI components and their boundaries
//
// The design's first principle is "be bold, and be legible". This file is the half of that promise
// which can be checked by a machine: it is what stops the palette getting louder at the cost of
// being readable. Where a bold value could not be made to pass, the fix was to change the SURFACE
// or the tonal step — never to desaturate the brand — and the reason is recorded at the pairing.
//
// It also holds the structural invariants that are easy to break by hand: the day theme must be
// glow-free, the two blocks day can be reached through must be identical, every colour token must
// be restated for day, and — the one that is pure design, not arithmetic — the error role must stay
// distinguishable from the accent by something other than hue.

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

/** Strip comments so a hex inside prose (there are many) is never read as a value. */
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

/** Resolve `var(--x)` chains within a theme, falling back to the night base the way CSS does. */
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

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
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

const surface = (theme: Record<string, string>, token: string): Rgb =>
  parseColor(resolve(theme, token));

const appBg = (t: Record<string, string>) => surface(t, '--bg-app');

/** Pairings the UI really renders. Each is checked in both themes. */
type Pair = {
  what: string;
  fg: string;
  /** Backdrops this foreground sits on, resolved per theme. */
  on: (t: Record<string, string>) => Array<{ label: string; rgb: Rgb }>;
  min: number;
};

/**
 * The reading surfaces. In night these are the ink panels laid on the blue page; in day they are
 * the white cards. Long-form text only ever lands on one of these three, which is why the blue
 * page is NOT in this list — see `page` below.
 */
const panels = (t: Record<string, string>) => [
  { label: 'surface-1', rgb: surface(t, '--surface-1') },
  { label: 'surface-2', rgb: surface(t, '--surface-2') },
  { label: 'surface-well', rgb: surface(t, '--surface-well') },
];

/**
 * The page itself. In night this is the banner's electric blue, which is a CHROME colour: the
 * shell, the gaps between panels, the area behind the cards. Only a small, deliberate set of
 * foregrounds is ever drawn directly on it.
 */
const page = (t: Record<string, string>) => [{ label: 'bg-app', rgb: appBg(t) }];

const everywhere = (t: Record<string, string>) => [...page(t), ...panels(t)];

/** A tint token over the surface it is drawn on, flattened if it carries alpha. */
const tintOver =
  (token: string, base: 'panel' | 'page') =>
  (t: Record<string, string>) => {
    const backdrop = base === 'page' ? appBg(t) : surface(t, '--surface-1');
    return [{ label: `${token} on ${base}`, rgb: flatten(resolve(t, token), backdrop) }];
  };

/** A fill token, as the backdrop for the label token the system pairs with it. */
const fill =
  (token: string) =>
  (t: Record<string, string>) => [{ label: token, rgb: parseColor(resolve(t, token)) }];

const PAIRS: Pair[] = [
  // --- Body text ----------------------------------------------------------
  //
  // text-1 and text-2 are checked on the blue page too, because the shell does put them there:
  // the top bar's host label, the page-head title on the install page.
  { what: 'text-1 (primary copy, assistant prose)', fg: '--text-1', on: everywhere, min: 4.5 },
  { what: 'text-2 (descriptions, help, notice bodies)', fg: '--text-2', on: everywhere, min: 4.5 },
  {
    // The faintest step: placeholders, list markers, meta. Panels only — it is 3.66:1 on the blue
    // page, and tokens.css says in as many words that it must not be used there. Nothing does.
    what: 'text-3 (placeholders, markers, meta) — panels only, never the blue page',
    fg: '--text-3',
    on: panels,
    min: 4.5,
  },

  // --- Role text ----------------------------------------------------------
  { what: 'primary text (links, active marks)', fg: '--primary-text', on: panels, min: 4.5 },
  { what: 'live text (.ok, healthy states)', fg: '--live-text', on: panels, min: 4.5 },
  { what: 'accent text (element chips, hero emphasis)', fg: '--accent-text', on: panels, min: 4.5 },
  { what: 'info text', fg: '--info-text', on: panels, min: 4.5 },
  { what: 'warn text', fg: '--warn-text', on: panels, min: 4.5 },
  {
    // Panels only, for the same reason as text-3: error on the blue page is 3.48:1. Every error in
    // the product is rendered inside a panel, a notice or a card.
    what: 'error text — panels only, never the blue page',
    fg: '--error-text',
    on: panels,
    min: 4.5,
  },

  // --- Text on tinted backgrounds -----------------------------------------
  {
    what: 'warn text on its tinted background',
    fg: '--warn-text',
    on: tintOver('--warn-bg', 'panel'),
    min: 4.5,
  },
  {
    what: 'error text on its tinted background',
    fg: '--error-text',
    on: tintOver('--error-bg', 'panel'),
    min: 4.5,
  },
  {
    what: 'accent text on the accent tint (element chip)',
    fg: '--accent-text',
    on: tintOver('--accent-tint', 'panel'),
    min: 4.5,
  },
  {
    what: 'live text on the live tint',
    fg: '--live-text',
    on: tintOver('--live-tint', 'panel'),
    min: 4.5,
  },
  {
    what: 'info text on the info tint',
    fg: '--info-text',
    on: tintOver('--info-tint', 'panel'),
    min: 4.5,
  },

  // --- Labels on fills ----------------------------------------------------
  //
  // Every fill in the system declares the label colour that goes on it. This is where the palette
  // is at its boldest, so it is where the checking matters most.
  {
    what: 'primary button label on its fill (rest)',
    fg: '--btn-primary-fg',
    on: fill('--btn-primary-bg'),
    min: 4.5,
  },
  {
    what: 'primary button label on its hover fill',
    fg: '--primary-on-fill',
    on: fill('--primary-fill-hover'),
    min: 4.5,
  },
  {
    what: 'primary button label on its pressed fill',
    fg: '--primary-on-fill',
    on: fill('--primary-fill-press'),
    min: 4.5,
  },
  {
    // The disabled button flattens to the well rather than fading, so its label must still read.
    what: 'disabled button label on the well it flattens to',
    fg: '--btn-disabled-fg',
    on: (t) => [{ label: 'surface-well', rgb: surface(t, '--surface-well') }],
    min: 4.5,
  },
  {
    // The active tab: a solid lime block with an ink label. The loudest pair in the panel.
    what: 'active tab label on the live fill',
    fg: '--live-on-fill',
    on: fill('--live-fill'),
    min: 4.5,
  },
  { what: 'label on the accent fill', fg: '--accent-on-fill', on: fill('--accent-fill'), min: 4.5 },
  { what: 'label on the info fill', fg: '--info-on-fill', on: fill('--info-fill'), min: 4.5 },
  { what: 'label on the warn fill', fg: '--warn-on-fill', on: fill('--warn-fill'), min: 4.5 },
  {
    // Ink in night (6.19:1), white in day. NOT white in night, where it is only 3.99:1.
    what: 'label on the error fill',
    fg: '--error-on-fill',
    on: fill('--error-fill'),
    min: 4.5,
  },

  // --- Non-text UI: 3:1 ---------------------------------------------------
  {
    // The focus ring has to be findable on every surface in the product, including the blue page.
    what: 'focus ring against every surface',
    fg: '--focus-ring',
    on: everywhere,
    min: 3,
  },
  {
    // A panel's edge is the ONLY thing separating it from the page: in night the ink panel and the
    // blue page are just 1.68:1 apart, so this border is load-bearing, not decoration.
    what: 'panel border against the page and the panel it outlines',
    fg: '--border-strong',
    on: (t) => [...page(t), { label: 'surface-1', rgb: surface(t, '--surface-1') }],
    min: 3,
  },
  { what: 'status dot: ok', fg: '--dot-ok', on: everywhere, min: 3 },
  { what: 'status dot: warn', fg: '--dot-warn', on: everywhere, min: 3 },
  { what: 'status dot: error', fg: '--dot-error', on: panels, min: 3 },
  {
    // The toggle's "on" state.
    //
    // It is NOT checked as "the lime fill against the surface": full lime on white is 1.23:1, and
    // no lime that reads as lime would clear 3:1 there. The control is legible in day because it
    // is drawn the way every block in this system is drawn — a solid fill inside a 2px ink border —
    // so the thing that carries the boundary is that border, which is what is checked here. In
    // night the same border is the bright one. Either way the edge, not the fill, is load-bearing,
    // and the knob inside it moves as a second, non-colour signal of state.
    what: 'enabled toggle: the border that carries its boundary',
    fg: '--border-strong',
    on: panels,
    min: 3,
  },
  {
    // The hero card's signature edge, which is what marks it out as the hero.
    what: 'hero card accent edge',
    fg: '--accent-edge',
    on: (t) => [...page(t), { label: 'surface-1', rgb: surface(t, '--surface-1') }],
    min: 3,
  },

  // --- The activity line, in all its states -------------------------------
  //
  // It sits on the panel surface, and each state colours both the text and a 3px inset rail.
  { what: 'activity line: running', fg: '--text-2', on: panels, min: 4.5 },
  { what: 'activity line: warn', fg: '--warn-text', on: panels, min: 4.5 },
  { what: 'activity line: error', fg: '--error-text', on: panels, min: 4.5 },
  { what: 'activity line: inline action', fg: '--primary-text', on: panels, min: 4.5 },

  // --- The dashboard (entrypoints/dashboard/dashboard.css) ----------------
  {
    // .rowcard's selected/hovered edge, and the active section rule under a dash tab. Both are the
    // sole marker of their state, so both answer to the 3:1 UI rule.
    what: 'dashboard: selected/hovered row edge and the active section rule',
    fg: '--primary',
    on: everywhere,
    min: 3,
  },
  {
    // The transcript preview insets a bubble and the source editor inside a card. Both are the
    // well, and both carry real prose the user reads at length.
    what: 'dashboard: preview bubble and editor text on the well',
    fg: '--text-1',
    on: (t) => [{ label: 'surface-well', rgb: surface(t, '--surface-well') }],
    min: 4.5,
  },
  {
    // .preview .prev-tool is --text-3 on the well, and it is the tool trace someone reads.
    what: 'dashboard: tool trace on the well',
    fg: '--text-3',
    on: (t) => [{ label: 'surface-well', rgb: surface(t, '--surface-well') }],
    min: 4.5,
  },
  {
    // .preview .prev-tool.is-error and .error's border are the only markers those two carry.
    what: 'dashboard: error rail and error notice edge',
    fg: '--error',
    on: (t) => [...panels(t)],
    min: 3,
  },
  {
    // The .badge.warn outline doubles as its only fill-free marker.
    what: 'dashboard: warn badge outline',
    fg: '--warn',
    on: panels,
    min: 3,
  },
];

// ---------------------------------------------------------------------------
// The assertions
// ---------------------------------------------------------------------------

const THEMES: Array<[string, Record<string, string>]> = [
  ['night', dark],
  ['day', light],
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

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

test('only alive things glow: the day theme has no neon at all', () => {
  for (const token of ['--glow-dot', '--glow-fill', '--glow-text', '--glow-tab', '--glow-hero']) {
    assert.equal(light[token], 'none', `${token} must be none in the day theme`);
  }
});

test('every glow the night theme does have is lime, because only alive things glow', () => {
  // A glow in any other hue would mean something that is not alive is pretending to be.
  for (const token of ['--glow-dot', '--glow-fill', '--glow-text']) {
    const v = dark[token];
    assert.ok(v !== undefined, `${token} should be defined for night`);
    if (v === 'none') continue;
    assert.match(
      v,
      /rgba\(174,\s*255,\s*36/,
      `${token} must be the lime glow (rgba(174,255,36,...)), got ${v}`,
    );
  }
});

test('both themes give panels a hard offset shadow rather than a blur', () => {
  // The banner's depth is a solid offset block, not a soft drop shadow. A blur radius here would be
  // a different design system.
  for (const [name, theme] of THEMES) {
    for (const token of ['--shadow-card', '--shadow-raise', '--shadow-press']) {
      const v = resolve(theme, token);
      const parts = v.split(/\s+/);
      assert.ok(parts.length >= 4, `${name} ${token} should be "x y 0 <colour>", got ${v}`);
      assert.equal(parts[2], '0', `${name} ${token} must have a zero blur radius, got ${v}`);
    }
  }
});

test('the error role stays distinct from the accent under colour-vision deficiency', () => {
  // Hue cannot carry this on its own. Simulating protanopia, deuteranopia and tritanopia collapses
  // the pink accent and any red toward the same olive, and under tritanopia they are within 1.1:1
  // of each other. The system therefore separates them three ways — lightness, form and words —
  // and this test holds the one of those three that is a number: the two roles must differ in
  // relative luminance by enough that they are never confusable as a pair of flat blocks.
  //
  // If this fails, do NOT re-hue the accent or the error. Change their LIGHTNESS steps.
  for (const [name, theme] of THEMES) {
    const accent = parseColor(resolve(theme, '--accent'));
    const error = parseColor(resolve(theme, '--error'));
    const ratio = contrast(accent, error);
    assert.ok(
      ratio >= 1.8,
      `${name}: --accent and --error are only ${ratio.toFixed(2)}:1 apart in luminance. ` +
        'They must differ by at least 1.8:1 so that the pair survives colour-vision deficiency, ' +
        'where their hues converge.',
    );
  }
});

test('the pixel display face is only ever declared for short labels', () => {
  // The display face is the brand's voice, and it is also the fastest way to make the product
  // unreadable. The floor exists because Pixelify's C and O are near-identical below 11px.
  const micro = dark['--fs-micro'];
  assert.ok(micro !== undefined, '--fs-micro should be defined');
  assert.ok(
    parseInt(micro, 10) >= 11,
    `the display face's smallest size must be at least 11px, got ${micro}`,
  );
  assert.match(
    dark['--font-display'] ?? '',
    /Pixelify Sans/,
    'the display face should be the bundled Pixelify Sans',
  );
});

test('the brand identity colours are the banner’s own, unaltered', () => {
  // These six are the identity. A contrast problem is fixed with a tonal step or a different
  // surface, never by editing one of these.
  const identity: Record<string, string> = {
    '--brand-blue': '#1008c8',
    '--brand-lime': '#aeff24',
    '--brand-cyan': '#00e5f2',
    '--brand-ink': '#030b16',
    '--brand-pink': '#f343d3',
    '--brand-yellow': '#fff345',
  };
  for (const [token, hex] of Object.entries(identity)) {
    assert.equal(
      dark[token]?.toLowerCase(),
      hex,
      `${token} must stay the banner's own value ${hex}`,
    );
  }
});

test('both routes into the day theme declare identical values', () => {
  // CSS cannot share a declaration block between a plain selector and a media query, so the day
  // values are written twice: once for an explicit data-theme="light", once under
  // prefers-color-scheme for Theme: System. A change made to one and not the other would give a
  // user a different palette depending on how they arrived at day, which is exactly the kind of
  // drift nobody notices by eye.
  const mq = css.indexOf('@media (prefers-color-scheme: light)');
  assert.notEqual(mq, -1, 'the prefers-color-scheme block is missing');
  const system = block(':root:not([data-theme])');
  assert.deepEqual(
    system,
    light,
    'the System (prefers-color-scheme) day block has drifted from the explicit day block',
  );
});

test('the day theme restates every token the night theme would otherwise leak', () => {
  // A token left out of the day block inherits the night value. That is correct for the structural
  // ones (type, radii, spacing) and a bug for anything that carries colour.
  const COLOUR =
    /^--(bg|surface|border-card|border-strong|border-hair|text|primary|live|accent|info|warn|error|dot|btn|focus|fill|track|selection|shadow|glow)/;
  const missing = Object.keys(dark).filter((k) => COLOUR.test(k) && !(k in light));
  assert.deepEqual(missing, [], `these colour tokens are not restated for day: ${missing.join(', ')}`);
});

test('the deprecated Volt aliases resolve, and nothing in the repo still uses them', () => {
  // They are kept so that branches in flight do not render unstyled on merge. They are not used by
  // this repository's own CSS any more, and this test is what stops one creeping back in.
  const aliases = ['--volt', '--volt-bright', '--volt-deep', '--volt-a10', '--volt-a12', '--volt-a25', '--volt-a28'];
  const block = css.slice(css.indexOf('DEPRECATED ALIASES'));
  for (const a of aliases) {
    assert.ok(block.includes(`${a}:`), `${a} should still be declared in the alias block`);
  }

  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.output' || e.name === '.wxt') continue;
        walk(p);
      } else if (/\.(css|tsx?|mjs)$/.test(e.name) && p !== TOKENS) {
        const text = fs.readFileSync(p, 'utf8');
        if (/var\(--volt/.test(text)) offenders.push(path.relative(root, p));
      }
    }
  };
  walk(path.join(root, 'entrypoints'));
  walk(path.join(root, 'lib'));
  assert.deepEqual(
    offenders,
    [],
    `these files still use a deprecated --volt alias and should move to the role tokens: ${offenders.join(', ')}`,
  );
});
