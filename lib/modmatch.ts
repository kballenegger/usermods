// Finding an already-saved mod that a new proposal revises. Pure, so it is testable under node.
import type { Mod } from './types';

/** Names compare loosely: trimmed and case-insensitive, since the model retypes the name each turn. */
export function sameModName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== '';
}

/**
 * The mod a proposal named `name` should overwrite, if any. When several share a name the most
 * recently updated one wins, so repeated saves keep landing on the same mod.
 */
export function findByName(mods: Mod[], name: string): Mod | undefined {
  const hits = mods.filter((m) => sameModName(m.name, name));
  if (!hits.length) return undefined;
  return hits.reduce((best, m) => (m.updatedAt > best.updatedAt ? m : best));
}
