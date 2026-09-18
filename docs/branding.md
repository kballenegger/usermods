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
- `assets/icon.svg` — editable canonical icon on a 16-unit grid, no fonts or filters.
- `public/icon/{16,32,48,96,128}.png` — extension icons, rendered independently at each size.
- `docs/branding/icon-1024.png` — large PNG for avatars and external branding.

Regenerate the extension PNGs after changing the SVG:

```sh
node scripts/render-icons.mjs
```

Preserve the square pixel grid and hard edges. Prefer the SVG or an exact-size PNG rather than a softened rescale. Leave space around the mark; avoid adding the full wordmark, mascot, or tiny details inside toolbar icons.

## Handoff for the local worker

The canonical banner, primary icon, extension PNGs and README header are installed. The broader interface still uses the previous design and needs a coordinated follow-up:

1. Apply this BBS direction to the side panel, dashboard, install flow and shared branding surfaces. Start with `entrypoints/sidepanel/tokens.css`, then the corresponding styles and brand marks.
2. Preserve usable light/dark themes and current functionality. Validate contrast and focus states as tokens change; keep dense content readable.
3. Refresh screenshots and store artwork after the UI is updated, including `docs/screenshots/` and `docs/store/assets/`. Update README descriptions of the old Volt design to match the implemented result.
4. Reuse the canonical icon and banner instead of selecting a new exploration. Match their visual language when new assets are needed.

This document and the root `AGENTS.md` are the project-local memory of the decision.
