# Explorations that lost

Kept so that a future pass does not spend its budget rediscovering the same dead ends. Each entry
says what was tried and why it was not chosen.

## `typeface-trial.png` — the pixel display face

Three open-licence candidates set at the sizes the UI really uses (10–26px), on the real surfaces,
including the tab bar at its actual 11px and the wordmark at 22–26px.

- **Pixelify Sans — chosen.** True lowercase, so it can set the lowercase `usermods` the brand
  requires. Crisp and quick to read from 11px. Compact enough that `SETTINGS` and `INSTALL MOD` fit
  on one line in a 420px side panel.
- **Silkscreen — rejected.** Two disqualifying problems, both visible in the capture: it is
  **uppercase-only**, so the wordmark comes out as `USERMODS` and the brand's own lowercase rule
  cannot be honoured; and its default tracking is so wide that `SETTINGS` and `INSTALL MOD` wrap to
  two lines at 12–13px, which is unusable in the panel.
- **Press Start 2P — rejected without a capture.** Wider than Silkscreen and only comfortable above
  roughly 20px. It would have been usable for the wordmark alone, which is not worth a second
  bundled font.

The one caveat carried forward from this trial: Pixelify's `C` and `O` are nearly identical below
11px, so `CHAT` starts to read as `OHAT`. That is why `--fs-micro` is 11px rather than 10px, and why
`test/contrast.test.ts` asserts the floor.

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
