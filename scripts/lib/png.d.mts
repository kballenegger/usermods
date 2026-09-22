// Types for scripts/lib/png.mjs, which is plain JS because the icon generators run as scripts
// rather than through the TypeScript build. The test suite reads the generated icons back through
// the same decoder the generator verifies with — one decoder, not two that could disagree — and
// this is what lets a typechecked test import it.

/** Decode an 8-bit non-interlaced PNG to flat RGBA. Throws on anything else. */
export function decodePNG(file: string): { width: number; height: number; px: Buffer };

/** A pixel's identity for comparison; fully transparent pixels collapse to `'transparent'`. */
export function colourKey(px: Buffer, i: number): string;

/** A colour key rendered for humans, as `#rrggbb` (with ` a=NN` when not fully opaque). */
export function pretty(key: string): string;
