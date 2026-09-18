// How a Tampermonkey import is reported back to the user. Pure, so it is testable under node.

/** The marker importBackup puts on entries it updated in place rather than skipped. */
export const UPDATED_MARK = 'updated values';

/**
 * What an import did, in one line. A script already installed is now updated in place — its stored
 * values merged, its registration kept — so it is reported as updated, not silently skipped
 * alongside the entries that genuinely could not be read.
 */
export function summarizeImport(r: { imported: number; skipped: string[] }): string {
  const updated = r.skipped.filter((s) => s.includes(UPDATED_MARK));
  const failed = r.skipped.filter((s) => !s.includes(UPDATED_MARK));
  const parts = [`Imported ${r.imported} script${r.imported === 1 ? '' : 's'}.`];
  if (updated.length) parts.push(`Updated ${updated.length} already installed.`);
  if (failed.length) parts.push(`Skipped: ${failed.join('; ')}`);
  return parts.join(' ');
}
