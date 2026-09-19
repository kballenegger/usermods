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
// AA is the HARD FLOOR and nothing in the palette is exempt from it. The design (option B, the
// muted banner palette) additionally targets 7:1 for long-form body copy, and the READING pairings
// below are asserted at that higher figure rather than at 4.5 — because the whole premise of this
// option is that a calmer palette should read BETTER than the bold one, not merely as well. If a
// muting decision ever costs body legibility, that is the thing this file is here to catch.
//
// Where a pairing could not be made to pass, the fix was to change the SURFACE or the tonal step —
// never to abandon the banner's hue, which is what carries the brand once the chroma is down. The
// reason is recorded at the pairing.
//
// It also holds the structural invariants that are easy to break by hand: the day theme must be
// glow-free, the two blocks day can be reached through must be identical, every colour token must
// be restated for day, the shadows must stay hard-edged, the display face must stay confined to
// the wordmark and the stat numbers, and — the one that is pure design, not arithmetic — the error
// role must stay distinguishable from the accent by something other than hue.

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
 * The reading surfaces. In night these are the navy panels laid on the deeper navy page; in day
 * they are the white cards. Long-form text lands on one of these three.
 */
const panels = (t: Record<string, string>) => [
  { label: 'surface-1', rgb: surface(t, '--surface-1') },
  { label: 'surface-2', rgb: surface(t, '--surface-2') },
  { label: 'surface-well', rgb: surface(t, '--surface-well') },
];

/**
 * The page itself: the shell, the gaps between panels, the area behind the cards.
 *
 * Unlike option A — where the page was the banner's electric blue and several foregrounds had to
 * be RESTRICTED off it — this option's page is the deepest step of the same navy ramp the panels
 * sit on. That makes it a legitimate surface for anything: every foreground below that is checked
 * on a panel is checked on the page too, and none of them needs an exemption. That is one of the
 * concrete things the muting bought, so it is asserted rather than described.
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
  // These three are the reading pairings, so they answer to the design's 7:1 target rather than to
  // AA's 4.5:1 — except the faintest step, which is metadata rather than prose and is held at AA.
  // A muted palette that made body copy harder to read than the bold one would have failed at its
  // only real job, and this is where that would show up.
  { what: 'text-1 (primary copy, assistant prose)', fg: '--text-1', on: everywhere, min: 7 },
  { what: 'text-2 (descriptions, help, notice bodies)', fg: '--text-2', on: everywhere, min: 7 },
  {
    // The faintest step: placeholders, list markers, meta. Never long-form prose, so AA is the
    // right bar for it. It is checked on the page as well as the panels, which option A could not
    // do: there it was 3.66:1 on the electric blue and had to be restricted off it by hand.
    what: 'text-3 (placeholders, markers, meta)',
    fg: '--text-3',
    on: everywhere,
    min: 4.5,
  },

  // --- Role text ----------------------------------------------------------
  { what: 'primary text (links, active marks)', fg: '--primary-text', on: panels, min: 4.5 },
  { what: 'live text (.ok, healthy states)', fg: '--live-text', on: panels, min: 4.5 },
  { what: 'accent text (element chips, hero emphasis)', fg: '--accent-text', on: panels, min: 4.5 },
  { what: 'info text', fg: '--info-text', on: panels, min: 4.5 },
  { what: 'warn text', fg: '--warn-text', on: panels, min: 4.5 },
  {
    // Checked on the page too, for the same reason as text-3 above.
    what: 'error text',
    fg: '--error-text',
    on: everywhere,
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
    // The active tab. In option A this was a solid LIME block with an ink label — the loudest
    // thing on the screen. Here lime is reserved for "alive", so the active tab is a primary-fill
    // block with a white label, which is the same 6.80:1 pair the primary button uses.
    what: 'active tab label on the primary fill',
    fg: '--primary-on-fill',
    on: fill('--primary-fill'),
    min: 4.5,
  },
  {
    // The enabled toggle and the running-turn rule are the two places a lime FILL survives, and
    // both carry an ink label or knob against it.
    what: 'label/knob on the live fill',
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
    // A panel's edge. It is no longer the ONLY thing separating a panel from the page — the
    // luminance step between --bg-app and --surface-1 does most of that work in this option, which
    // is why the border could drop from 2px bright to 1px quiet. It still has to be findable, so
    // it still answers to 3:1 against every surface it can be drawn over.
    what: 'panel border against the page and every panel it outlines',
    fg: '--border-strong',
    on: everywhere,
    min: 3,
  },
  {
    // The resting edge of a secondary button, an input, the toggle track and the top bar's icon
    // buttons. It is what says "this is a control", so it is a UI boundary and not decoration.
    what: 'control border (buttons, inputs, the toggle track, top-bar icon buttons)',
    fg: '--border-control',
    on: everywhere,
    min: 3,
  },
  { what: 'status dot: ok', fg: '--dot-ok', on: everywhere, min: 3 },
  { what: 'status dot: warn', fg: '--dot-warn', on: everywhere, min: 3 },
  { what: 'status dot: error', fg: '--dot-error', on: everywhere, min: 3 },
  {
    // The toggle's "on" state.
    //
    // It is NOT checked as "the lime fill against the surface": full lime on white is 1.23:1, and
    // no lime that reads as lime would clear 3:1 there. What carries the control's boundary is its
    // 1px border, which is what is checked here, and the knob's travel is a second signal that
    // does not depend on colour at all.
    what: 'enabled toggle: the border that carries its boundary',
    fg: '--border-control',
    on: everywhere,
    min: 3,
  },
  {
    // The hero card's signature edge. It is one of only two places pink appears in the whole
    // interface (the other is an element-reference chip), so it has to be unmistakable where it
    // does appear — hence a real 3:1 against both the card and the page behind it.
    what: 'hero card accent edge',
    fg: '--accent-edge',
    on: everywhere,
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

  // --- The model picker and provider cards (modelpicker.css, providers.css) ---
  //
  // The trigger sits on the composer's panel; the popover is --surface-2 with options that go to
  // the well when active and a footer on --surface-1, so every text role below is checked on all
  // three rather than on the one it happens to rest on today.
  { what: 'model picker: model ids and option text', fg: '--text-1', on: panels, min: 4.5 },
  { what: 'model picker: provider name, group labels, notes', fg: '--text-2', on: panels, min: 4.5 },
  { what: 'model picker: group status (built-in list, could not list) and the unset trigger', fg: '--warn-text', on: panels, min: 4.5 },
  { what: 'model picker: the "use what I typed" option and the footer links', fg: '--primary-text', on: panels, min: 4.5 },
  { what: 'model picker: the selected mark', fg: '--live-text', on: panels, min: 4.5 },
  { what: 'model picker: a problem sentence under the trigger', fg: '--error-text', on: panels, min: 4.5 },
  { what: 'transcript: the "switched to" model marker', fg: '--text-3', on: (t) => [{ label: 'surface-1', rgb: surface(t, '--surface-1') }], min: 4.5 },
  {
    // The active option's rail, the open trigger's ring and an open provider card's edge are each
    // the non-colour half of their state, so each answers to the 3:1 UI rule.
    what: 'model picker and provider cards: active rail, open ring, open card edge',
    fg: '--primary',
    on: panels,
    min: 3,
  },
  { what: 'model picker: the warn edge of an unset trigger', fg: '--warn', on: panels, min: 3 },
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

test('the offset shadows are hard-edged, and there are only two of them', () => {
  // What depth this option has is the banner's kind: a solid offset block, zero blur. A blur
  // radius here would be a different design system.
  //
  // The muting shows up as a COUNT, not just as a colour. --shadow-card is `none`, because in this
  // option an ordinary panel is separated from the page by a luminance step and a 1px line rather
  // than by a lift; only the primary button and the hero card are allowed an offset, and they take
  // --shadow-raise / --shadow-press. That is the structural difference from option A, where every
  // card carried a 4px ink block, so it is asserted rather than left to a comment.
  for (const [name, theme] of THEMES) {
    assert.equal(
      resolve(theme, '--shadow-card'),
      'none',
      `${name}: --shadow-card must be none — an ordinary panel in this option does not lift`,
    );
    for (const token of ['--shadow-raise', '--shadow-press']) {
      const v = resolve(theme, token);
      // "2px 2px 0 rgba(...)" — the blur is the third whitespace-separated part.
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

const SHEETS = [
  'entrypoints/sidepanel/styles.css',
  'entrypoints/sidepanel/activity.css',
  'entrypoints/sidepanel/modelpicker.css',
  'entrypoints/sidepanel/providers.css',
  'entrypoints/dashboard/dashboard.css',
  'entrypoints/styleguide/styleguide.css',
];
const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the pixel display face is confined to the wordmark and the stat numbers', () => {
  // This is the typographic decision that separates option B from option A, and it is the one that
  // would rot first, because reaching for --font-display is how you make a label look "branded".
  //
  // In option A the face set every tab, button, section label and heading. Here it sets the
  // `usermods` wordmark and the four large stat numbers on the dashboard, and nothing else —
  // everything that is read rather than recognised is the text face at --fw-label. So the rule is
  // asserted by COUNT: each stylesheet may declare the display face only on the selectors listed
  // here, and a new one has to be argued for by editing this list.
  const allowed: Record<string, string[]> = {
    // The wordmark in the side panel's top bar.
    'entrypoints/sidepanel/styles.css': ['.wordmark'],
    'entrypoints/sidepanel/activity.css': [],
    // The dashboard header's wordmark, and the stat tile numbers.
    'entrypoints/dashboard/dashboard.css': ['.dash-head h1', '.stat .n'],
    // The style guide's own page title, which is the wordmark by another name.
    'entrypoints/styleguide/styleguide.css': ['.sg-head h1'],
  };

  for (const rel of SHEETS) {
    const sheet = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    // Every rule block that declares the display face, with the selector text in front of it.
    const uses = [...sheet.matchAll(/([^{}]*)\{[^{}]*font-family:\s*var\(--font-display\)/g)].map(
      (m) => (m[1] ?? '').split(/\n\s*\n/).pop()?.replace(/\/\*[\s\S]*?\*\//g, '').trim() ?? '',
    );
    const expected = allowed[rel] ?? [];
    assert.equal(
      uses.length,
      expected.length,
      `${rel} declares the display face ${uses.length} time(s); this option allows ${expected.length} ` +
        `(${expected.join(', ') || 'none'}). Found: ${uses.join(' | ')}`,
    );
    for (const sel of expected) {
      assert.ok(
        uses.some((u) => u.includes(sel)),
        `${rel} should set the display face on ${sel}, but its display-face rules are: ${uses.join(' | ')}`,
      );
    }
  }
});

test('the display face is the bundled Jersey 10, and nothing asks it for a bold', () => {
  assert.match(
    dark['--font-display'] ?? '',
    /Jersey 10/,
    'the display face should be the bundled Jersey 10',
  );

  // Jersey 10 ships a single 400 weight. Asking for 700 makes the engine synthesise a bold by
  // smearing the outline, which thickens the strokes into the counters and closes the capital C —
  // the exact defect that got Pixelify Sans replaced. The face is heavy enough at 400.
  //
  // The check is scoped to the rules that actually use the face, because in THIS option the text
  // face legitimately does carry weight: --fw-label is 600, and that is what replaced the pixel
  // labels. A blanket "no font-weight: 700 anywhere" would have been the wrong rule here.
  for (const rel of SHEETS) {
    const sheet = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
    for (const m of sheet.matchAll(/\{([^{}]*font-family:\s*var\(--font-display\)[^{}]*)\}/g)) {
      assert.ok(
        !/font-weight:\s*(700|800|900|bold)\b/.test(m[1] ?? ''),
        `${rel} asks the display face for a bold weight, but it has only a 400 — the engine would ` +
          'synthesise it and close the C that this face was chosen for.',
      );
    }
  }
});

test('emphasis is carried by the text face at a real weight, not by the pixel face', () => {
  // The other half of the same decision. Option A got its boldness from pixel type; this option
  // gets it from the system stack at 600, so that weight is a token rather than a local choice —
  // it is the interface's entire boldness budget and it should be changed in one place.
  const w = dark['--fw-label'];
  assert.ok(w !== undefined, '--fw-label should be defined: it is what replaced the pixel labels');
  const n = parseInt(w, 10);
  assert.ok(
    n >= 600 && n <= 700,
    `--fw-label is ${w}; emphasis needs to be a real semibold (600-700) to replace pixel type`,
  );

  // Body copy and code have floors, and they are floors because a muted palette leans harder on
  // size and weight than a saturated one does.
  assert.ok(parseInt(dark['--fs-body'] ?? '0', 10) >= 13, 'body copy must stay at least 13px');
  assert.ok(parseInt(dark['--fs-meta'] ?? '0', 10) >= 12, 'code and metadata must stay at least 12px');
  assert.ok(parseInt(dark['--fs-micro'] ?? '0', 10) >= 12, 'the smallest label must stay at least 12px');
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
