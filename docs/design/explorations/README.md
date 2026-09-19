# Explorations that lost

Kept so that a future pass does not spend its budget rediscovering the same dead ends. Each entry
says what was tried and why it was not chosen.

## The three interface options — two still open

The identity ([`branding.md`](../../branding.md) — the palette, the icon, the banner) has been
settled since 2026-09-19.
How much of the screen it should cover has been answered three different ways, and **two of those
are open for comparison right now**; neither is merged.

**Volt OS — superseded.** The original system: a charcoal page with a single neon yellow-green
accent, and no relationship to the banner at all beyond the accent's hue. It was replaced when the
BBS banner became canonical, because a brand whose whole character is a saturated electric blue
cannot be represented by one accent colour on grey. Its token names survive as a deprecated alias
block at the end of `tokens.css` so that branches in flight do not render unstyled on merge.

**Option A — the bold application** (`design/volt-bold`; this is the state of `main`). The banner
taken literally. The electric blue `#1008C8` *is* the page; reading panels are ink laid on top of it,
each with a 2px bright border and a 4px hard ink offset; every label, tab and button is pixel type;
the active tab is a solid lime block. Its first principle is "be bold, and be legible", and it holds
both — every pairing clears AA and the type is large — but the boldness is continuous rather than
reserved: the saturation is on screen the entire time you are reading.

**Option B — the muted application** (`design/muted-banner`). The same six identity hexes and the
same hues, with the **chroma pulled down for anything larger than a dot or a border**. A deep navy
page on the banner blue's own hue (266) with slightly lighter navy panels on it, 1px edges, 4–6px
radii, and exactly two offset shadows in the whole product. Lime is reserved for "alive"; pink for
the hero card's edge and element chips. Labels are the system face at 600, and the pixel face is kept
for the wordmark and the dashboard's stat numbers.

The structural difference, which is what everything else follows from: **option A's panel is *darker*
than its page and only 1.68:1 from it**, so a bright border is the only thing that can carry the
edge. **Option B's panel is *lighter* than its page**, so a luminance step carries the edge and the
border only confirms it. That inversion is what pays for the quieter borders, the absent shadows and
the smaller radii — they are consequences of one decision, not four separate ones.

Two measurable consequences worth recording either way:

- Option A has to **restrict two tokens off its own page** — `--text-3` is 3.66:1 and `--error-text`
  3.48:1 on the electric blue — and enforces that by which surfaces the test checks them against.
  Option B's page is part of the same ramp as its panels, so every foreground is checked on it and
  every one passes.
- Option B holds long-form reading pairings to **7:1** rather than AA's 4.5:1, which option A's
  palette could not do on the blue page.

The comparison is the owner's to make; both branches carry full capture sets for it.

## `glyph-pairs.png` — why the display face changed, and to what

Regenerate with `node scripts/glyph-specimen.mjs`. The specimen reads the shipped `tokens.css`, so
the sizes it shows are the sizes that ship.

**The defect.** Pixelify Sans, chosen in the earlier trial below, sets a capital `C` whose aperture
is **one pixel-unit tall on a seven-unit glyph** — a closed O with a nick taken out of its right
side. At label sizes that nick disappears into the stroke and the letter simply becomes an O, so
the product's most-clicked controls read as `OHAT`, `AROHIVE`, `SELEOT ALL`, `RUN ONOE`,
`OHATGPT SUBSORIPTION`. `G` (a one-unit spur), `0` against `O` (no slash, no difference in width)
and `8` against `B` fail the same way for the same reason.

**It is the face's drawing, not the rendering.** This was the thing worth establishing, because the
earlier trial had recorded it as a size problem and set an 11px floor against it. It is not a size
problem. The pair was rendered at 8, 10, 11, 12, 13, 14, 16, 20, 24, 32, 40, 64 and 96px, at
weights 400/500/600/700, at tracking from 0 to 3px, and under all four of Chrome's
`-webkit-font-smoothing` settings including `none`, which turns antialiasing off entirely. **The C
is still a closed O at 96px.** No size, weight, tracking or smoothing setting can open a counter
the outline does not have, so raising the floor was never going to work and the face had to change.

**The replacement: Jersey 10.** OFL, on `@fontsource`, bundled locally like every other face here.

- Its `C` is open across roughly a third of the glyph's height — the pair is separated by
  *structure*, not by a single pixel that antialiasing can swallow. Every pair in the specimen
  (`C/O`, `G/C`, `0/O`, `8/B`, `1/I/l`, `5/S`, `E/F`, `U/V`, and the lowercase `a/o/e` that set the
  wordmark) survives at 12px.
- It has **true lowercase**, so it can still set the brand's own lowercase `usermods`.
- It is **heavy at its single 400 weight**, so the banner's boldness survives without a bold axis —
  which matters, because synthesising a bold from a 400 is exactly what would smear the strokes
  back into the counters. `test/contrast.test.ts` now fails the build if any stylesheet asks the
  display face for 700.
- It is **narrower than Pixelify at the same size**, which is what gave the chat switcher its width
  back.

The other three evaluated, all OFL and all in the specimen:

- **VT323 — rejected.** Its `C` is properly open, but the face is a thin terminal font: at 12px on
  the ink panel it is too light to hold a tab label. (That test was option A's, where the face had to
  carry every label; under option B it would only ever have set the wordmark, but the face was chosen
  before the two options split.)
- **Silkscreen — rejected again**, for the reason it was rejected the first time: uppercase only,
  so it cannot set `usermods`. Its tracking is also still very wide — see it wrapping in the
  specimen at 13px, the button size.
- **DotGothic16 — rejected.** Legible and open, but light-stroked and wide, so it reads as a
  document face rather than a display face and pushes labels toward wrapping.

The size scale moved with the face, in option A: `--fs-micro` / `--fs-label` went to **12px**
(Jersey sets a smaller cap-height per em, so 12px of Jersey is the optical size 11px of Pixelify
was), stat and title rose to 22/28px, and button labels got their own `--fs-btn` at 13px so the
display face and the prose face could be sized independently.

**Option B keeps the face and almost none of that scale**, because it sets only the wordmark and the
stat numbers in it — everything that was pixel type there is the system face at 600. The 12px floor
still applies to the labels, but for the ordinary reason that 12px is small, not to outrun a defect
in a glyph.

## `typeface-trial.png` — the pixel display face (superseded)

Kept for the record. Its conclusion — that Pixelify Sans was the right display face and that its
`C`/`O` collision was a size problem solvable with an 11px floor — **was wrong on the second half,
and the first half followed from it.** See `glyph-pairs.png` above for the measurement that
replaced it. The trial's findings on Silkscreen and Press Start 2P still stand and were confirmed.


Three open-licence candidates set at the sizes the UI really uses (10–26px), on the real surfaces,
including the tab bar at its actual 11px and the wordmark at 22–26px.

- **Pixelify Sans — chosen at the time, since replaced.** True lowercase, so it can set the
  lowercase `usermods` the brand requires. Compact enough that `SETTINGS` and `INSTALL MOD` fit on
  one line in a 420px side panel. "Crisp and quick to read from 11px" is the part that did not
  survive contact with the shipped captures.
- **Silkscreen — rejected.** Two disqualifying problems, both visible in the capture: it is
  **uppercase-only**, so the wordmark comes out as `USERMODS` and the brand's own lowercase rule
  cannot be honoured; and its default tracking is so wide that `SETTINGS` and `INSTALL MOD` wrap to
  two lines at 12–13px, which is unusable in the panel.
- **Press Start 2P — rejected without a capture.** Wider than Silkscreen and only comfortable above
  roughly 20px. It would have been usable for the wordmark alone, which is not worth a second
  bundled font.

The one caveat carried forward from this trial was that Pixelify's `C` and `O` are nearly identical
*below 11px*, so `CHAT` starts to read as `OHAT`, and that an 11px floor therefore fixed it. **The
"below 11px" was the error.** The collision is at every size, because it is in the outline; the
floor bought nothing and the shipped captures showed `OHAT` at 11px and above. See
`glyph-pairs.png`.

## Directions considered for the two themes — and reconsidered

Recorded in words rather than as captures, because both were rejected at the token stage, **during
option A's pass**, before a full UI was built on either. Option B reopened both of them deliberately,
so the original reasoning and what changed are kept side by side.

**Night, alternative: ink page with blue accents.** A near-black page with the electric blue used
only for buttons and active marks — essentially the old charcoal layout re-hued.

*Rejected for option A* because it is not the banner: the banner's most striking quality is that the
blue is the *field*, not an accent on it, and an ink page throws that away. It also makes the blue
almost unusable, since `#1008C8` is too dark to read against near-black.

*Reopened for option B*, and the second objection is the one that had to be answered rather than
waved off. Option B's page is **not** near-black and its primary is **not** `#1008C8`: the page is
`#0C1220`, a deep navy on the banner blue's own hue 266, and the primary is a lighter tint of that
same hue (`#98B6FB` as text, `#3053BC` as a fill) which is perfectly readable on it. So the
"unusable blue" problem was really a problem with using the identity hex *unmodified* on a dark
surface, and a tonal scale solves it — which option A had already discovered for its own panels.

The first objection stands as stated and is simply the trade being offered: the blue is no longer the
field. What option B argues is that the *hue* being everywhere — in every surface, every neutral and
every border — is a different and more durable way of being the banner than the *saturation* being
everywhere, and that it is the one that survives a long reading session. That is a judgement about
which the owner is the authority, which is why both branches exist.

**Day, alternative: white page, blue links.** The conventional light theme.

*Rejected for option A* for the reason the owner gave directly — "we don't need to be subtle with the
colours" — and because it would have made the two themes siblings in name only. Option A's day theme
keeps the banner's construction (ink outlines, hard offset shadows, saturated fills with ink labels)
and only inverts the surfaces.

*Option B's day theme is not this alternative either*, though it is closer to it than option A's. The
page is a cool white tinted on hue 266 rather than plain white, the primary is a deep blue on the
banner's hue rather than a generic link blue, and lime, cyan, yellow and pink all still appear as
real fills with ink labels. What it drops is the ink outline and the hard offset on every card.

Each option's chosen pair is documented, with hexes and ratios, in the `design.md` on its own branch;
this branch's is [`../../design.md`](../../design.md).
