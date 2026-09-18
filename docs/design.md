# The usermods design system

This is the reference you design from. It describes what the interface is made of, why each piece is
the way it is, and the rules that decide the cases it does not cover.

The identity — the banner, the icon, the palette, the voice — lives in [branding.md](branding.md).
This document is how that identity becomes an interface.

The system has no separate name. It used to be called "Volt OS"; it is now simply the usermods
design system.

---

## 1. First principle: be bold, and be legible

> Be bold, and be legible.

These are not in tension, and the whole system depends on understanding why.

**Legibility comes from contrast, type size, spacing and solid surfaces — not from desaturation.**
White on the banner's electric blue is 11.1:1. Ink on lime is 16.1:1. Both are more readable than
most grey-on-grey interfaces, and neither is remotely subtle. A saturated palette is not the enemy
of reading; a *low-contrast* palette is, and so is small type, and so is a pattern behind a
paragraph.

So when a choice comes up, the rule is:

> Choose the bolder option, then **make** it legible — raise the contrast, enlarge the type, thicken
> the stroke, put the text on a solid panel. Do not tone the colour down.

The only thing that is never traded away is reading. Concretely, and non-negotiably:

- **Long-form reading surfaces** — assistant prose in the transcript, code blocks, the mod source
  editor, settings help text, the consent notice, the install preview's source — are set in a
  proportional or mono **text** face, never the pixel display face, at **body ≥ 13px / code ≥ 12px**,
  on a **solid, untextured panel**, with body contrast ≥ 7:1.
- **Nothing is ever drawn behind text.** No dithering, no gradients, no patterns. Decoration lives in
  headers, empty states and margins.
- **Pixel display type is for short labels**, at sizes where it is crisp and instant to read. It is
  not for sentences.
- **Interactive controls have unambiguous affordances and states**, and focus is always obvious.
- **Roles never collide** — primary vs info, accent vs error, live vs warn — at a glance or under the
  common colour-vision deficiencies.
- **Dense lists stay scannable.**

The test suite holds the half of this that a machine can check
([`test/contrast.test.ts`](../test/contrast.test.ts)). The other half is checked by reading a long
transcript, a code block and the settings form in each theme and asking whether it tires the eyes.
If it does, fix the **structure** — panel, spacing, size — not the brand.

## 2. The other two principles

**Structure from the old system.** The information architecture and component anatomy were already
right and did not change: what is on each screen, the layout, the flows, the terse operational
voice. This was a re-skin, not a redesign. Behaviour is not the visual language's to change.

**Only alive things glow or pulse.** A glow means "this is happening right now", it is always lime,
and nothing else in the system is allowed to use one. The running turn, the enabled toggle, the
healthy status dot, the activity line's pulse. Warnings do not glow. Errors do not glow. The brand
does not glow. Everything else gets its weight from colour blocks, ink outlines and hard offset
shadows — never from blur.

---

## 3. The palette

### 3.1 Identity — the banner's own colours

These six are the brand, taken from `docs/banner.png` unaltered. They are the same in both themes.
**They must never be edited to fix a contrast problem** — fix it with a tonal step, or by changing
the surface the colour sits on.

| Role | Token | Hex | OKLCH | Used for |
| --- | --- | --- | --- | --- |
| Electric blue | `--brand-blue` | `#1008C8` | `oklch(38.3% 0.256 266)` | the page; the primary fill |
| Lime | `--brand-lime` | `#AEFF24` | `oklch(91.3% 0.237 130)` | live / ok — the only colour allowed to glow |
| Cyan | `--brand-cyan` | `#00E5F2` | `oklch(83.9% 0.143 202)` | info; the focus ring |
| Ink | `--brand-ink` | `#030B16` | `oklch(14.7% 0.029 251)` | outlines, hard offset shadows, labels on bright fills |
| Magenta | `--brand-pink` | `#F343D3` | `oklch(68.6% 0.254 336)` | accent: hero edge, element chips, the wordmark's shadow |
| Yellow | `--brand-yellow` | `#FFF345` | `oklch(94.5% 0.182 105)` | warning |

The banner's blue field samples as `#0010C9`; `#1008C8` is the working value recorded in
`branding.md` and the two are indistinguishable. The identity value is what ships.

### 3.2 Tonal scales

Derived in OKLCH holding each identity hue steady. `300` is the bright tint that carries text on
dark surfaces, `500` is the identity colour, `700`/`800` are the deep tones that carry text on white.
Only the steps the UI actually uses exist.

| Scale | 300 | 500 | 700 / 800 |
| --- | --- | --- | --- |
| Blue (h 266) | `#A7C2FE` text/border on dark | `#1008C8` the fill | `#060077` pressed fill |
| Lime (h 130) | `#C0FF73` hover | `#AEFF24` fill, dark text | `#4A7104` text on white |
| Pink (h 336) | `#FFB6EC` text on dark | `#F343D3` fill, edges | `#C4139F` text on white |
| Cyan (h 202) | — | `#00E5F2` fill, dark text | `#02777F` text on white |
| Yellow (h 105) | — | `#FFF345` fill, dark text | `#6C6601` text on white |
| Red (h 27) | — | `#F35F55` error on dark | `#7D030E` error on white |

Two of these are worth explaining, because they look arbitrary and are not:

- **`--pink-300` is `#FFB6EC`, a pale pink rather than the mid tint** you would reach for first. At
  `oklch(80%)` the accent and the error role sat only 1.59:1 apart in luminance, and luminance is the
  only channel that survives a colour-vision simulation of that pair. Lifting it to 86% opens the gap
  to 2.00:1 without touching either hue.
- **Red is not a banner colour.** The banner has none. Error needs a hue that cannot be confused with
  the pink accent, so one was added; see [§3.5](#35-error-vs-accent-the-hard-case).

### 3.3 Night (the default, and the hero look)

The banner's electric blue **is the page**. Reading panels are blue-cast ink laid on top of it,
bordered bright and shadowed hard.

| Role | Token | Hex | OKLCH | For | Never |
| --- | --- | --- | --- | --- | --- |
| Page | `--bg-app` | `#1008C8` | `38.3% 0.256 266` | the page, gaps between panels | behind long-form text |
| Panel | `--surface-1` | `#041325` | `18.4% 0.043 253` | every reading surface | — |
| Raised | `--surface-2` | `#0B1F34` | `23.5% 0.048 252` | hovered rows, your own messages | — |
| Well | `--surface-well` | `#000613` | `12.1% 0.036 252` | code, editor, tool output | — |
| Body | `--text-1` | `#F2F6FF` | `97.3% 0.013 267` | prose, titles | — |
| Secondary | `--text-2` | `#AEBED1` | `79.5% 0.032 253` | descriptions, help, notices | — |
| Faint | `--text-3` | `#8D9FB2` | `69.5% 0.035 250` | placeholders, markers, meta | **on the blue page** (3.66:1) |
| Primary | `--primary` | `#A7C2FE` | `81.6% 0.090 266` | links, borders, active marks | as a fill |
| Primary fill | `--primary-fill` | `#1008C8` | `38.3% 0.256 266` | primary buttons, header blocks | as text on a panel |
| Live | `--live` | `#AEFF24` | `91.3% 0.237 130` | running, enabled, ok; the only glow | for anything not alive |
| Accent | `--accent` | `#FFB6EC` | `86.0% 0.120 336` | hero edge, chips, selection | for errors |
| Info | `--info` | `#00E5F2` | `83.9% 0.143 202` | info, **and the focus ring** | for a state |
| Warn | `--warn` | `#FFF345` | `94.5% 0.182 105` | attention, not failure | with a glow |
| Error | `--error` | `#F35F55` | `67.5% 0.184 27` | failure | **on the blue page** (3.48:1) |
| Outline | `--border-strong` | `#A7C2FE` | `81.6% 0.090 266` | every panel edge | as a hairline divider |
| Control edge | `--border-control` | `#55749C` | `52.0% 0.062 260` | buttons, inputs, the toggle track | as a panel's edge |
| Divider | `--border-hair` | `#1C3350` | — | lines *inside* a panel | as a panel's or a control's edge |

**Why the panel edge is bright.** The blue page and the ink panel are only **1.68:1** apart in
luminance. A dark hairline would be invisible and a luminance step cannot carry the edge, so every
panel takes a **2px bright border** (`--primary` is 6.24:1 on the page) plus a **hard ink offset
shadow**. This is exactly how the banner is constructed — the constraint and the aesthetic give the
same answer, which is the happiest kind of design decision.

### 3.4 Day

Not "a white app with blue links". A pale cool page, white panels **outlined in ink** with the same
hard offset shadow, blue header blocks carrying white or lime, and lime/pink/yellow used as real
fills with ink labels. Day is the banner seen in daylight — the same construction, inverted.

| Role | Token | Hex | OKLCH | Note |
| --- | --- | --- | --- | --- |
| Page | `--bg-app` | `#EAF0FE` | `95.5% 0.020 267` | cool, not white |
| Panel | `--surface-1` | `#FFFFFF` | `100%` | — |
| Well | `--surface-well` | `#F3F7FF` | `97.5% 0.011 265` | — |
| Body | `--text-1` | `#081A2D` | `21.4% 0.045 252` | blue-cast ink, not black |
| Secondary | `--text-2` | `#44596F` | `45.6% 0.044 250` | — |
| Faint | `--text-3` | `#5A6C81` | `52.4% 0.040 253` | — |
| Primary | `--primary` | `#1008C8` | `38.3% 0.256 266` | **the banner blue itself**, 11.11:1 on white |
| Live | `--live` | `#4A7104` | `50.0% 0.132 130` | lime is 1.4:1 on white; fills stay full lime |
| Accent | `--accent` | `#C4139F` | `55.8% 0.219 336` | — |
| Info | `--info` | `#02777F` | `51.9% 0.088 203` | — |
| Warn | `--warn` | `#6C6601` | `50.0% 0.106 106` | — |
| Error | `--error` | `#7D030E` | `38.9% 0.161 27` | deliberately very dark; see below |
| Outline | `--border-strong` | `#071B31` | `21.9% 0.051 253` | **ink**, 17.35:1 on white |
| Control edge | `--border-control` | `#7089AC` | `59.0% 0.049 257` | 3.58:1 on white — a control's edge is a UI boundary |

Day is where `#1008C8` gets to be the text colour it is best at. Every identity colour that must
carry *text* drops to its deep step, while every *fill* keeps the full identity colour with an ink
label — so the page stays as saturated as night, with the saturation in the blocks rather than the
background.

### 3.5 Error vs accent: the hard case

Pink and red are adjacent enough that a colour-vision deficiency collapses them. Simulating
protanopia, deuteranopia and tritanopia (Brettel LMS) drives `#F343D3` and any red toward the same
olive — at best 2.4:1 apart, and under tritanopia **1.01:1**, which is to say identical.

Hue cannot solve this. The system separates the two roles **three ways at once**, and colour is the
weakest of the three:

1. **Lightness.** The two roles are held **≥ 1.8:1 apart in relative luminance in both themes** —
   night pairs a pale accent with a mid red (2.00:1), day pairs a mid accent with a very dark red
   (2.08:1). Luminance is the one channel a simulation cannot collapse. This is asserted by the test.
2. **Form.** An error is the only thing that takes a filled left rail or a solid outlined block. The
   accent is the only thing that takes the hero card's doubled edge. Shape is what a component is
   recognised by.
3. **Words.** Every error state carries a word — "failed", "error", "could not" — never colour alone.

The same reasoning applies to **live vs warn**: lime and yellow are within 1.03–1.18:1 of each other
under simulation, so the activity line gives warn and error each a **coloured left rail** as well as
a colour, and the tool row does the same.

> If the CVD test ever fails, **do not re-hue** the accent or the error. Change their lightness
> steps. The test's own message says so.

### 3.6 Contrast table

Generated from the shipped tokens. AA is 4.5:1 for text, 3:1 for large text and UI boundaries.

| Pairing | Tokens | Night | Day | Needs | Level |
| --- | --- | --- | --- | --- | --- |
| Body copy, assistant prose | `--text-1` on `--surface-1` | 17.25:1 | 17.56:1 | 4.5:1 | AAA / AAA |
| Body copy on the page | `--text-1` on `--bg-app` | 10.26:1 | 15.38:1 | 4.5:1 | AAA / AAA |
| Descriptions, field help, notice bodies | `--text-2` on `--surface-1` | 9.85:1 | 7.23:1 | 4.5:1 | AAA / AAA |
| Placeholders, list markers, meta | `--text-3` on `--surface-1` | 6.88:1 | 5.39:1 | 4.5:1 | AA / AA |
| Code and editor text on the well | `--text-1` on `--surface-well` | 18.74:1 | 16.35:1 | 4.5:1 | AAA / AAA |
| Tool trace on the well | `--text-3` on `--surface-well` | 7.47:1 | 5.02:1 | 4.5:1 | AAA / AA |
| Primary text (links, active marks) | `--primary-text` on `--surface-1` | 10.48:1 | 11.11:1 | 4.5:1 | AAA / AAA |
| Live text (.ok, healthy) | `--live-text` on `--surface-1` | 15.23:1 | 5.75:1 | 4.5:1 | AAA / AA |
| Accent text (element chips) | `--accent-text` on `--surface-1` | 11.69:1 | 5.33:1 | 4.5:1 | AAA / AA |
| Info text | `--info-text` on `--surface-1` | 11.99:1 | 5.32:1 | 4.5:1 | AAA / AA |
| Warn text | `--warn-text` on `--surface-1` | 16.14:1 | 5.93:1 | 4.5:1 | AAA / AA |
| Error text | `--error-text` on `--surface-1` | 5.85:1 | 11.10:1 | 4.5:1 | AA / AAA |
| Primary button label on its fill | `--btn-primary-fg` on `--btn-primary-bg` | 11.11:1 | 11.11:1 | 4.5:1 | AAA / AAA |
| Primary button label, hover fill | `--primary-on-fill` on `--primary-fill-hover` | 5.23:1 | 16.48:1 | 4.5:1 | AA / AAA |
| Primary button label, pressed fill | `--primary-on-fill` on `--primary-fill-press` | 16.48:1 | 16.48:1 | 4.5:1 | AAA / AAA |
| Disabled button label on the well | `--btn-disabled-fg` on `--surface-well` | 7.47:1 | 5.02:1 | 4.5:1 | AAA / AA |
| Active tab label on the lime block | `--live-on-fill` on `--live-fill` | 16.11:1 | 14.32:1 | 4.5:1 | AAA / AAA |
| Label on the accent fill | `--accent-on-fill` on `--accent-fill` | 6.16:1 | 5.48:1 | 4.5:1 | AA / AA |
| Label on the info fill | `--info-on-fill` on `--info-fill` | 12.69:1 | 11.28:1 | 4.5:1 | AAA / AAA |
| Label on the warn fill | `--warn-on-fill` on `--warn-fill` | 17.08:1 | 15.18:1 | 4.5:1 | AAA / AAA |
| Label on the error fill | `--error-on-fill` on `--error-fill` | 6.19:1 | 11.10:1 | 4.5:1 | AA / AAA |
| Warn text on its tint | `--warn-text` on `--warn-bg` | 11.48:1 | 5.64:1 | 4.5:1 | AAA / AA |
| Error text on its tint | `--error-text` on `--error-bg` | 4.93:1 | 9.24:1 | 4.5:1 | AA / AAA |
| Accent text on the accent tint | `--accent-text` on `--accent-tint` | 9.90:1 | 4.61:1 | 4.5:1 | AAA / AA |
| Live text on the live tint | `--live-text` on `--live-tint` | 10.93:1 | 5.32:1 | 4.5:1 | AAA / AA |
| Info text on the info tint | `--info-text` on `--info-tint` | 8.92:1 | 4.87:1 | 4.5:1 | AAA / AA |
| Focus ring vs the page | `--focus-ring` on `--bg-app` | 7.13:1 | 9.73:1 | 3:1 | AA (UI) / AA (UI) |
| Focus ring vs a panel | `--focus-ring` on `--surface-1` | 11.99:1 | 11.11:1 | 3:1 | AA (UI) / AA (UI) |
| Panel border vs the page | `--border-strong` on `--bg-app` | 6.24:1 | 15.20:1 | 3:1 | AA (UI) / AA (UI) |
| Panel border vs the panel | `--border-strong` on `--surface-1` | 10.48:1 | 17.35:1 | 3:1 | AA (UI) / AA (UI) |
| Control border (buttons, inputs, toggle) | `--border-control` on `--surface-1` | 3.88:1 | 3.58:1 | 3:1 | AA (UI) / AA (UI) |
| Status dot: ok | `--dot-ok` on `--surface-1` | 15.23:1 | 5.75:1 | 3:1 | AA (UI) / AA (UI) |
| Status dot: warn | `--dot-warn` on `--surface-1` | 16.14:1 | 5.93:1 | 3:1 | AA (UI) / AA (UI) |
| Status dot: error | `--dot-error` on `--surface-1` | 5.85:1 | 11.10:1 | 3:1 | AA (UI) / AA (UI) |
| Hero card accent edge vs the page | `--accent-edge` on `--bg-app` | 3.47:1 | 4.67:1 | 3:1 | AA (UI) / AA (UI) |
| Dashboard selected row edge | `--primary` on `--surface-1` | 10.48:1 | 11.11:1 | 3:1 | AA (UI) / AA (UI) |

There are **no exceptions**. Two tokens are restricted rather than exempted — `--text-3` and
`--error-text` are not used on the blue page, where they would fail — and that restriction is stated
in `tokens.css` and enforced by which surfaces the test checks them against.

---

## 4. Typography

Three families, and which one is used is a **rule**, not a preference.

| Family | Token | For | Never |
| --- | --- | --- | --- |
| Jersey 10 | `--font-display` | the wordmark, tab labels, section labels, button labels, headings, stat numbers | a sentence; below 12px; at any weight but 400 |
| System UI | `--font-ui` | **all prose**, every long-form reading surface, field help | identifiers |
| IBM Plex Mono | `--font-mono` | identifiers, code, match patterns, model ids, anything copyable | prose |

Both non-system faces are **bundled locally** (`@fontsource/*`). An extension must never fetch a font
from a remote origin.

**Why Jersey 10, and why the display face changed.** The system first shipped on Pixelify Sans, and
it had to be replaced, because Pixelify's capital `C` carries an aperture **one pixel-unit tall on a
seven-unit glyph** — it is a closed O with a nick in it. At label sizes the nick vanishes into the
stroke, so the product's most-clicked controls read as `OHAT`, `AROHIVE`, `SELEOT ALL`, `RUN ONOE`
and `OHATGPT SUBSORIPTION`. Its `G`, its unslashed `0` and its `8` collapse against `C`, `O` and `B`
for the same reason.

**This was the face's drawing, not a rendering artefact, and that is the point.** The earlier trial
had recorded the collision as a *size* problem and set an 11px floor against it. It is not a size
problem: the pair was re-rendered from 8px to 96px, at all four weights, across a tracking sweep,
and under every `-webkit-font-smoothing` setting including `none`. The `C` is still a closed `O` at
96px. A counter the outline does not have cannot be opened by a size, a weight, a tracking value or
an antialiasing mode — so the floor bought nothing and the face had to change.

Jersey 10 is OFL, on `@fontsource`, and its `C` is open across about a third of the glyph's height,
so the pair is separated by structure rather than by one pixel. It keeps true lowercase (the brand's
own `usermods` needs it), it is heavy enough at its single 400 weight to hold the banner's boldness,
and it is narrower than Pixelify at the same size. VT323, Silkscreen and DotGothic16 were evaluated
beside it and lost — the specimen and the full reasoning are in
[`design/explorations/`](design/explorations/) (`glyph-pairs.png`).

**Never ask the display face for a bold.** Jersey 10 ships one 400 weight. `font-weight: 700` makes
the engine synthesise a bold by smearing the outline, which thickens the strokes back into the
counters and undoes the exact property the face was chosen for. The test fails the build if any
stylesheet does it.

**The 12px floor.** Jersey sets a smaller cap-height per em than Pixelify, so 12px of Jersey is the
optical size 11px of Pixelify was. `--fs-micro` is therefore 12px, and the test asserts it. It is a
floor for legibility at small sizes, which is an ordinary reason — unlike the old floor, which was
an attempt to outrun a defect no floor could reach.

### Scale

| Token | Size | Used for |
| --- | --- | --- |
| `--fs-micro` / `--fs-label` | 12px | section labels, tab labels, badges — the display face's floor |
| `--fs-meta` | 12px | metadata, help text, code |
| `--fs-btn` | 13px | **button labels** — the display face's own step |
| `--fs-body` | 13px | **body copy** — the transcript, notices, prose |
| `--fs-ui` | 14px | card titles |
| `--fs-stat` | 22px | stat numbers |
| `--fs-title` | 28px | page titles, the wordmark at page scale |

`--fs-btn` exists because button labels are display type and field help is prose, and they used to
share `--fs-meta`. The two faces render at different optical sizes for the same nominal one, so they
have to be sizeable apart.

Body line-height is **1.6** in the transcript and 1.5–1.55 elsewhere. Display type is tracked out by
`--lbl-tracking` (0.08em) — pixel glyphs need more air between them than a sans does.

---

## 5. Shape, depth and motion

| Token | Value | Note |
| --- | --- | --- |
| `--r-card` | `0px` | cards and panels are **square**. The banner is built from squares. |
| `--r-field` | `2px` | one small step for the things you touch |
| `--r-pill` | `2px` | there are no pills any more |
| `--border-width` | `2px` | chunky, like the banner's outlines |
| `--shadow-card` | `4px 4px 0` ink | **hard offset, zero blur** |
| `--shadow-raise` | `3px 3px 0` ink | — |
| `--shadow-press` | `1px 1px 0` ink | what a pressed block sits on |

The only round thing left in the system is a 7px status dot.

**Depth is never a blur.** The test asserts that every shadow token has a zero blur radius. A soft
drop shadow is a different design system.

**Motion.** Only alive things move. The activity line's lime dot pulses (1s, opacity 1 → 0.35); a
pressed button travels onto its own shadow (80ms); colour transitions are 120ms. Everything is
disabled under `prefers-reduced-motion: reduce`.

**Glow.** Lime only, night only, and only on things that are alive. The test asserts both halves:
day declares every glow as `none`, and every glow night does declare is the lime rgba.

---

## 6. Iconography

- 16px pixel grid, drawn at whole multiples of 16 CSS px (16, 32) so block boundaries land on device
  pixels.
- `image-rendering: pixelated` on any raster mark, or the hard edges turn to fringe on a HiDPI
  screen.
- Inline SVG uses `shape-rendering: crispEdges` and `currentColor`, so an icon takes the colour of
  the role it sits in.
- To draw a new one: lay it out on a 16×16 grid, use whole units only, no curves, no anti-aliasing,
  no gradients. If it needs a diagonal, step it.

---

## 7. Components

Each entry is anatomy, states, and the one mistake worth naming.

### Tabs (side panel and dashboard)
Left: the sections. Right: hostname, then icon actions.
The **active tab is a solid lime block with an ink label** (16.11:1) — the loudest thing in the bar,
because "which screen am I on" is the bar's only real question. Inactive tabs are `--text-2`, rising
to `--text-1` on hover. The bar itself is a solid panel with a lime rule under it.
*Don't* give the active tab a glow. It is already the brightest block on screen; a halo just blurs
its edge.

### Buttons
**Boldness is a hierarchy, not a volume setting.** One primary per screen carries the fill, the
bright outline and the hard offset shadow. Everything beside it is a quiet outlined block on
`--border-hair` with no shadow.
States: rest, hover (surface shifts, border comes up to `--primary`), active (travels 1–2px onto its
shadow), disabled (flattens to the well, label steps back — **never a fade**).
*Don't* fill every button. The first pass of this design gave nine provider presets the full
treatment and Settings became a wall of identical shouting blocks with no way to find the action that
mattered. That mistake is preserved as a "don't" in the style guide.

### Chips
Mono, 12px, squared, on the well. `.ref` — an element the user pointed at — takes the accent, which
is the accent's job: a thing the user reached out and touched. `.warn` takes the warn tone and tint.

### Status dots
7px circles. Lime (glowing) = ok, yellow = running/stalled, red = error, `--text-3` = off. A dot is a
UI component, so it answers to 3:1, not 4.5:1. A dot is **never the only signal** — it always sits
beside a word.

### Cards
Solid surface, 2px outline, hard offset shadow, square corners.
`.hero` — one per screen, the proposal card in Chat — takes the **accent edge and an accent-coloured
shadow**. That doubled pink edge is the hero's signature and nothing else may use it.
`.disabled` recedes by **surface and edge**, never by opacity.

### List rows (dashboard)
Selected and hovered rows take a `--primary` edge, which is the sole marker of selection, so it
clears 3:1. An archived row recedes to the well with a quiet edge and a stepped-back title.
*Don't* use opacity for "inactive" anywhere on this palette — a 0.62 row over a saturated page reads
as broken rather than as put away. This applies in **both** themes; it was originally a light-only
rule and the blue page made it universal.

### Forms and toggles
Field labels are pixel type, uppercase, tracked. **The help text under them is prose**, so it is the
UI face at 12px, sentence case, 1.5 line-height.
The toggle is a squared track with a squared knob; on is a solid lime fill with an ink knob, plus the
glow in night. Its **2px border carries its boundary** — full lime on white is 1.23:1, so the fill
alone could not show where the control is, and the knob's travel is a second signal that does not
depend on colour at all.

### Notices
Prose on a panel: UI face, 12px, 1.55. Three tones, each of which also carries a word. A notice
inside a card drops to the well with a hairline and no second shadow.
*Don't* write a bare `.error` selector. The dashboard had one, and it matched the 7px `.dot.error`
and the `.tool.error` rail as well as its intended banner — inflating the status dot into a 28×24
red block on top of the text beside it. Scope banner rules to a direct child of a page container.

### The activity line
Four states: running (lime dot, pulsing), waiting (same, with a ticking timer), warn (yellow, **plus a
3px inset left rail**), error (red, plus a rail). Warn and error never pulse and never glow — a line
that has stopped moving must not pretend it is still going. The inline action is a text button, not a
third block competing with the composer.

### Transcript rows
The longest-form reading surface in the product, and the place where legibility outranks everything.
Assistant prose is plain `--text-1` on the flat panel at 13px/1.6 with no colour, border or
decoration — the transcript earns its boldness from the frame around it, not from the paragraphs. A
user message is an outlined block pushed right; a queued one is the same block as a dashed outline
with no fill. Tool rows are a 2px rail, a dot and a mono name.

### Dashboard list / detail / editor
Header block with the wordmark, stat tiles whose numbers are big pixel type in lime, section tabs
matching the panel's, then a two-pane list/detail. The source editor is mono 12px on the well — a
reading surface, so it follows every rule in §1.

---

## 8. Voice and copy

Terse and operational. Lowercase brand, sentence case everywhere else except display labels.

- Say what happened: "connection lost — the request failed", not "Oops! Something went wrong."
- Name the thing: "not tested on this page · the tab was closed".
- Errors carry a word, never colour alone.
- No exclamation marks, no emoji, no apologising.
- Tagline: **Your web. Your rules.** Supporting: **Vibe-code userscripts in place.**

---

## 9. Theming

Three choices — **system**, **dark** (night), **light** (day) — resolved by
[`lib/theme.ts`](../lib/theme.ts) and applied before first paint by `public/theme-boot.js`, so there
is no flash.

Day is reached two ways: an explicit `data-theme="light"`, or no explicit choice while the OS asks
for light. CSS cannot share a declaration block between a plain selector and a media query, so the
day values are **written twice** — and the test asserts the two blocks are identical, so a change
made to one and not the other fails rather than shipping a palette that depends on how you got there.

**To add a token:** declare it in `:root`, then in **both** day blocks, then add its real pairing to
`test/contrast.test.ts`. A colour token that is not restated for day inherits night's value, which the
test also catches.

### The deprecated alias block

The old Volt names (`--volt`, `--volt-bright`, `--volt-deep`, `--volt-a10/12/25/28`) are kept at the
end of `tokens.css`, pointing at the roles that replaced them, because branches in flight still use
them.

The mapping is **by meaning, not hue**. "volt" meant two different things and they have separated:
where it meant "this is alive" it is now `--live`; where it meant "the brand / the main interactive
colour" it is now `--primary`. The aliases resolve to `--live`, because that was volt's dominant
sense. **A rule that used `--volt` for brand emphasis will come out lime rather than blue** and should
be moved to `--primary` by hand.

**Removal plan:** delete the block once nothing outside it mentions the names. Nothing in this
repository does — a test asserts it — so the block exists purely for in-flight work and can go as
soon as those branches land.

---

## 10. Accessibility commitments

- WCAG AA for every pairing the UI renders, in both themes, enforced by test.
- Focus is always visible: a 2px cyan ring (`--focus-ring`), offset 2px, never removed. Cyan is
  reserved for focus and info so a focused control can never be mistaken for a state.
- No state is carried by colour alone. Every semantic state has a word, a shape or a rail as well.
- Roles that converge under colour-vision deficiency are separated by lightness and form (§3.5).
- `prefers-reduced-motion: reduce` disables every transition and animation.
- Disabled controls stay readable — they recede by surface, never by opacity.
- `color-scheme` is declared so native controls and scrollbars match the theme from the first paint.

---

## 11. Checklist for a new surface

1. Does every piece of long-form text sit on a **solid panel**, in a **text face**, at ≥13px?
2. Is anything drawn **behind** text? Remove it.
3. Does the pixel face appear anywhere below 12px, on a sentence, or at a weight other than 400?
   Fix it.
   And before you reach for a size: set every label you are adding in the face and read the `C`s. A
   display face that cannot hold `CHAT` apart from `OHAT` is the wrong face, not the wrong size.
4. Does each panel have a **2px border and a hard offset shadow**, and is the border bright in night
   and ink in day?
5. Is there exactly **one primary action**, with everything else outlined?
6. Does every state have a **non-colour signal** — a word, a rail, a shape?
7. Is focus visible on every interactive element, on every surface it can appear over?
8. Are new colours **role tokens**, not hexes? (No hex belongs outside `tokens.css`, except the
   picker overlay, which cannot see CSS variables.)
9. Have you added the real pairings to `test/contrast.test.ts`, for **both** themes?
10. Does it still look like `docs/banner.png` at a glance?
11. Have you read a long paragraph on it in **both** themes without your eyes tiring?

---

## 12. The living style guide

The specimen at [`entrypoints/styleguide/`](../entrypoints/styleguide/) renders every component and
state **using the real stylesheets**, so it cannot drift from the product. It is linked from the
dashboard footer in dev builds, or behind `?styleguide=1`.

Regenerate the captures below with:

```sh
npm run styleguide
```

### Night

![The usermods style guide in the night theme](design/styleguide-night.png)

### Day

![The usermods style guide in the day theme](design/styleguide-day.png)

Explorations that were tried and rejected are kept in
[`design/explorations/`](design/explorations/) with a note on why they lost.

---

## 13. Relationship to branding.md

[`branding.md`](branding.md) is the **identity**: the banner, the icon, the palette, the name, the
tagline, the assets and how to regenerate them. It is the source.

This document is the **interface**: how that identity becomes surfaces, components, states and rules,
and what had to be added (a red, tonal scales, neutral families) or constrained (which colours may
carry text on which surface) to make it work as a product people read.

When the two disagree about a colour, `branding.md` wins on identity and this document wins on
application.
