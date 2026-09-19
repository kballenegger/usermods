# usermods branding — BBS Underground

## Canonical decision

On 2026-09-19, Kenneth selected **03 · BBS Underground** from the banner explorations as the canonical usermods style and asked that it be used everywhere for branding. This supersedes the previous Volt OS / charcoal-and-volt brand direction. This decision is project-local; do not save it as a global or cross-project preference.

The visual source of truth is `docs/banner.png`: the selected BBS banner, copied without alteration. The primary icon is `assets/icon.svg`, a lime pixel **u** with a cyan lower edge and black shadow on an electric-blue tile. It derives from the banner's wordmark. The browser and playful goblin in the banner are supporting illustration, not the primary app icon.

## Style

- Early BBS / ANSI and pixel-art energy: playful, handmade, hacker-friendly, confident.
- Saturated electric blue, acid lime lettering, cyan edges, black shadows; magenta and yellow as supporting accents.
- Square pixels, stepped silhouettes, hard edges, offset shadows, bitmap-style display typography, browser-window motifs and restrained dithering.
- Keep the brand name lowercase: **usermods**.
- Tagline: **Your web. Your rules.** Supporting line: **Vibe-code userscripts in place.**
- Use expressive pixel lettering for brand display; keep functional UI copy readable. Apply the style while retaining focus visibility, contrast, keyboard use and existing behavior.

Standardized working palette for code and new artwork:

| Role | Color |
| --- | --- |
| Electric blue | `#1008C8` |
| Lime | `#AEFF24` |
| Cyan | `#00E5F2` |
| Ink / shadow | `#030B16` |
| Magenta accent | `#F343D3` |
| Yellow accent | `#FFF345` |

The generated banner has texture and color variation; these are consistent implementation colors, not a claim that every banner pixel uses this exact palette.

## Assets installed

- `docs/banner.png` — canonical full-width README banner, 2171 × 724.
- `assets/icon-source.png` — the owner's original artwork, 256 × 256, kept byte for byte. A true
  16 × 16 grid at 16px per block, RGBA, with genuinely transparent corners and exactly five
  colours: the blue, lime, cyan and ink above, plus transparent.
- `assets/icon.svg` — editable canonical icon on a 16-unit grid, no fonts or filters. Verified to
  render pixel-for-pixel identical to `icon-source.png` at 256 × 256 (0 differing pixels of 65,536).
- `public/icon/{16,32,48,96,128}.png` — extension icons, rendered independently at each size.
- `docs/branding/icon-1024.png` — large PNG for avatars and external branding.
- `assets/icon-alternates/` — superseded explorations, including
  `h-volt-window-brace-shipped.svg`, the window-and-brace mark this replaced.

Regenerate the extension PNGs (and `icon-1024.png`) after changing the SVG:

```sh
node scripts/render-icons.mjs
```

Preserve the square pixel grid and hard edges. Prefer the SVG or an exact-size PNG rather than a softened rescale. Leave space around the mark; avoid adding the full wordmark, mascot, or tiny details inside toolbar icons.

The script enforces that rather than trusting it: it re-reads everything it wrote and fails if a
file is off by a pixel, or if any output pixel is a colour that is **not** in `icon-source.png`.
Interpolated rescaling is the one failure mode that never shows up in a diff — a `sips`-scaled
48px icon trips this check with 138 invented colours. Draw the mark only at whole multiples of 16,
and use `image-rendering: pixelated` wherever CSS scales it, or HiDPI will smooth the edges back off.

## Brand marks in the product — done

The mark now appears on every surface that had one or should have had one:

- **Toolbar and manifest.** All five sizes in `icons`, and an explicit `action.default_icon`, so
  Chrome picks the real 16/32 pixel renders instead of downscaling the 128.
- **Favicons** on all three extension pages — side panel, dashboard, install.
- **Dashboard and install headers.** Both showed the wordmark in plain type because there was no
  logo; both now carry the mark beside it, at 32px and 16px respectively, with
  `image-rendering: pixelated`. Checked in light and dark; the mark brings its own blue tile, so
  it needs no per-theme variant.
- **Store promo tile and marquee** (`scripts/store-assets.mjs`), rebuilt in this brand rather than
  the in-product charcoal, since they sit beside the banner in the listing.
- **`docs/store/listing.md`** describes the mark and the no-interpolation rule.

The five store screenshots keep the neutral window frame and charcoal caption bar: the pixels
inside the frame are real product output, and the frame is deliberately quiet so it does not
compete with them.

## Remaining follow-up — the app UI itself

**Pending owner confirmation.** Restyling the interface would replace the current Volt OS look and
the light mode added the day before this decision, so it is deliberately *not* part of the icon
work and is being confirmed with Kenneth separately before anyone starts:

1. Apply this BBS direction to the side panel, dashboard, install flow and shared branding surfaces. Start with `entrypoints/sidepanel/tokens.css`, then the corresponding styles and brand marks.
2. Preserve usable light/dark themes and current functionality. Validate contrast and focus states as tokens change; keep dense content readable.
3. Refresh screenshots and store artwork after the UI is updated, including `docs/screenshots/` and `docs/store/assets/`. Update README descriptions of the old Volt design to match the implemented result.
4. Reuse the canonical icon and banner instead of selecting a new exploration. Match their visual language when new assets are needed.

This document and the root `AGENTS.md` are the project-local memory of the decision.
