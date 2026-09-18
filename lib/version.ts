// Userscript @version comparison, Tampermonkey style: dotted numeric parts, with an optional
// alphanumeric pre-release suffix on a part ("1.2.3-beta.1", "1.0rc2"). Pure: no chrome APIs.

/** One part of a version: its numeric value, then any suffix text that followed the digits. */
interface Part {
  num: number;
  suffix: string;
}

function parseParts(v: string): Part[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split(/[.\-+_]/)
    .filter((s) => s.length > 0)
    .map((s) => {
      const m = s.match(/^(\d*)(.*)$/) as [string, string, string];
      return { num: m[1] ? Number(m[1]) : NaN, suffix: m[2].toLowerCase() };
    });
}

function cmpPart(a: Part | undefined, b: Part | undefined): number {
  // A missing part is 0 with no suffix, so 1.2 === 1.2.0, but 1.2 > 1.2-beta.
  const x = a ?? { num: 0, suffix: '' };
  const y = b ?? { num: 0, suffix: '' };
  const xn = Number.isNaN(x.num) ? 0 : x.num;
  const yn = Number.isNaN(y.num) ? 0 : y.num;
  if (xn !== yn) return xn < yn ? -1 : 1;
  if (x.suffix === y.suffix) return 0;
  // No suffix outranks any suffix: 1.0 > 1.0-beta, matching Tampermonkey and semver.
  if (!x.suffix) return 1;
  if (!y.suffix) return -1;
  return x.suffix < y.suffix ? -1 : 1;
}

/** -1, 0 or 1 comparing two @version strings ordinally. Unparsable input compares as equal-ish. */
export function compareVersions(a: string, b: string): number {
  const pa = parseParts(a ?? '');
  const pb = parseParts(b ?? '');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const c = cmpPart(pa[i], pb[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/**
 * Should an update replace the installed script? Newer @version wins. When either side has no
 * usable @version, fall back to "the source text differs", since there is nothing to order by.
 */
export function shouldUpdate(
  current: { version: string; source: string },
  next: { version: string; source: string },
): boolean {
  const hasBoth = !!current.version.trim() && !!next.version.trim();
  if (hasBoth) return compareVersions(next.version, current.version) > 0;
  return next.source.trim() !== current.source.trim();
}
