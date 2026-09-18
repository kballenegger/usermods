# Explorations that lost

Kept so that a future pass does not spend its budget rediscovering the same dead ends. Each entry
says what was tried and why it was not chosen.

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
  the ink panel it is too light to hold a tab label, and "be bold" is the first half of the rule.
- **Silkscreen — rejected again**, for the reason it was rejected the first time: uppercase only,
  so it cannot set `usermods`. Its tracking is also still very wide — see it wrapping in the
  specimen at 13px, the button size.
- **DotGothic16 — rejected.** Legible and open, but light-stroked and wide, so it reads as a
  document face rather than a display face and pushes labels toward wrapping.

The size scale moved with the face: `--fs-micro` / `--fs-label` are **12px** (Jersey sets a smaller
cap-height per em, so 12px of Jersey is the optical size 11px of Pixelify was), stat and title rose
to 22/28px, and button labels got their own `--fs-btn` at 13px so the display face and the prose
face can be sized independently.

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

## Directions considered for the two themes

Recorded here in words rather than as captures, because both were rejected at the token stage before
a full UI was built on them.

**Night, alternative: ink page with blue accents.** A near-black page with the electric blue used
only for buttons and active marks — essentially the old charcoal layout re-hued. Rejected because it
is not the banner: the banner's most striking quality is that the blue is the *field*, not an accent
on it, and an ink page throws that away. It also makes the blue almost unusable, since `#1008C8` is
too dark to read against near-black.

**Day, alternative: white page, blue links.** The conventional light theme. Rejected for the reason
the owner gave directly — "we don't need to be subtle with the colours" — and because it would have
made the two themes siblings in name only. The chosen day theme keeps the banner's *construction*
(ink outlines, hard offset shadows, saturated fills with ink labels) and only inverts the surfaces.

The chosen pair is documented, with hexes and ratios, in [`../../design.md`](../../design.md).
