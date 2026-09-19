// Matching a draft against the mods that already exist: which one a proposal revises, which ones
// run on the page the user is looking at, and whether a save is about to mint a twin of something
// already installed. Pure, so it is all testable under node.
import { modMatchesUrl } from './mods.ts';
import type { Mod } from './types';

/** Names compare loosely: trimmed and case-insensitive, since the model retypes the name each turn. */
export function sameModName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase() && a.trim() !== '';
}

/**
 * The mod a proposal named `name` should overwrite, if any. When several share a name the most
 * recently updated one wins, so repeated saves keep landing on the same mod.
 *
 * This is NOT how a save picks its mod any more — that is the artifact's linkedModId, and an id
 * cannot drift the way a name can. It survives as the duplicate guard's first filter: a save from
 * an UNLINKED chat has no id to go on, and a mod with the same name and the same reach is the one
 * the user probably meant to update rather than copy. See `duplicateOf`.
 */
export function findByName(mods: Mod[], name: string): Mod | undefined {
  const hits = mods.filter((m) => sameModName(m.name, name));
  if (!hits.length) return undefined;
  return hits.reduce((best, m) => (m.updatedAt > best.updatedAt ? m : best));
}

/** Two match-pattern lists are the same reach when they hold the same patterns, order aside. */
export function sameMatches(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].map((s) => s.trim()).sort();
  const right = [...b].map((s) => s.trim()).sort();
  return left.every((x, i) => x === right[i]);
}

/**
 * The installed mod a brand-new save would duplicate: same name, same reach.
 *
 * Both halves are required. A name alone is too loose — "Dark mode" on two different sites is two
 * mods and always was — and the patterns alone are far too loose, since every mod for a site shares
 * them. Together they describe a mod that does the same job in the same places, which is the one
 * case where "you already have this" is worth saying rather than guessing.
 *
 * `excludeSelf` is the mod this chat is already linked to, if any: a linked save updates in place
 * and is never a duplicate of anything, so the caller normally does not ask at all.
 */
export function duplicateOf(mods: Mod[], proposal: { name: string; matches: string[] }, excludeId?: string): Mod | undefined {
  const hits = mods.filter((m) => m.id !== excludeId && sameModName(m.name, proposal.name) && sameMatches(m.matches, proposal.matches));
  if (!hits.length) return undefined;
  return hits.reduce((best, m) => (m.updatedAt > best.updatedAt ? m : best));
}

// ---------------------------------------------------------------------------
// The mods on this page, for the model
// ---------------------------------------------------------------------------

/** One mod as the prompt block names it. */
export interface ModOnPage {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  matches: string[];
  /** True when THIS chat's draft is the one linked to this mod. */
  linked: boolean;
}

/**
 * The mods whose patterns cover `url`, enabled or not, in a stable order: the one this chat is
 * already editing first, then enabled before disabled, then by name.
 *
 * Disabled mods are included deliberately. "Also hide the sidebar" belongs with the mod that hides
 * the banner whether or not that mod is switched on right now, and a model that cannot see a
 * disabled mod writes a second one that fights it the moment the user switches the first back on.
 *
 * An empty `url` (a chrome:// page, a panel that has not found its tab yet) lists nothing, which is
 * honest: nothing is known to run there.
 */
export function modsForUrl(mods: Mod[], url: string, linkedModId?: string): ModOnPage[] {
  if (!url) return [];
  return mods
    .filter((m) => modMatchesUrl(m, url))
    .map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      enabled: m.enabled,
      matches: [...m.matches, ...m.includeGlobs],
      linked: !!linkedModId && m.id === linkedModId,
    }))
    .sort((a, b) => Number(b.linked) - Number(a.linked) || Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name));
}

/**
 * The block the model is shown each turn, listing the mods that already run on this page.
 *
 * It rides on the USER turn beside the draft block (lib/artifact.ts draftBlock), not in the system
 * prompt: the system prompt is one cached block (see the Anthropic adapter's cache_control), and a
 * list that changes with every navigation would bust that cache on every turn for every provider
 * that caches. Per-turn context is also simply where this belongs — it is a fact about the page in
 * front of the user, exactly like `[Current page: …]`.
 *
 * Returns '' when nothing runs here, so the turn carries no empty heading.
 */
export function modsBlock(mods: ModOnPage[]): string {
  if (!mods.length) return '';
  const lines = mods.map((m) => {
    const bits = [`- ${m.id} · ${JSON.stringify(m.name)}`];
    if (m.description) bits.push(`— ${m.description}`);
    bits.push(m.enabled ? '· enabled' : '· disabled');
    if (m.linked) bits.push('· THIS CHAT IS EDITING THIS ONE');
    return bits.join(' ');
  });
  return [
    `[Mods already installed on this page: ${mods.length}]`,
    ...lines,
    'Use open_mod with one of these ids to keep building on it instead of writing a second mod that does the same job.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// open_mod over a draft that is already there
// ---------------------------------------------------------------------------

/**
 * What the chat's draft is, as far as open_mod is concerned.
 *
 *  - 'none'    no artifact at all: opening a mod is free.
 *  - 'saved'   every version is in a mod already (linked, and the current version is the saved one),
 *              so nothing would be lost.
 *  - 'unsaved' there is work here that is not in any mod — either no link at all, or a link whose
 *              mod holds an older version than the draft is at.
 */
export type DraftStanding = 'none' | 'saved' | 'unsaved';

export function draftStanding(a: { current: number; linkedModId?: string; savedVersion?: number } | null | undefined): DraftStanding {
  if (!a) return 'none';
  if (a.linkedModId && a.savedVersion === a.current) return 'saved';
  return 'unsaved';
}

// ---------------------------------------------------------------------------
// "Edit this mod in a chat": which chat
// ---------------------------------------------------------------------------

/** The least a chat has to say about itself for editModPlan to choose between chats. */
export interface EditCandidate {
  id: string;
  host: string;
  archived: boolean;
  updatedAt: number;
  /** The mod this chat's draft is linked to, from the index mirror. */
  editingModId?: string;
  /** Whether this chat has a draft of its own that is not in any mod. */
  unsaved?: boolean;
  /** Whether this chat has nothing in it yet — no transcript, no draft. */
  empty?: boolean;
}

/**
 * What "Edit in chat" should do for a mod, given every chat that exists and the chat (if any) that
 * is on screen right now.
 *
 * ONE rule, in one place, because five surfaces ask it: the Mods tab's row, the dashboard's row,
 * a new chat's empty state, the composer's picker, and the open_mod tool. Five copies of "reuse the
 * chat if there is one" is five chances for them to disagree about what counts as one.
 *
 * In order:
 *
 *  1. A chat is already editing this mod → reuse it, whatever host it is on and whether or not it
 *     is archived (the caller unarchives). The conversation that built this mod is the best place
 *     to keep building it, and that is the whole point of the feature.
 *  2. The chat on screen is empty → seed it. Opening a second empty chat beside an empty one is
 *     litter, and the user is plainly not in the middle of anything.
 *  3. Otherwise → a new chat. In particular when the current chat has an UNSAVED draft of its own:
 *     that draft exists nowhere else, so it is never the thing that gives way. This is the rule the
 *     addendum asks for, and it is why `unsaved` is asked about the current chat at all.
 */
export function editModPlan(
  modId: string,
  chats: EditCandidate[],
  current: EditCandidate | null,
): { action: 'reuse'; chatId: string; unarchive: boolean } | { action: 'seed'; chatId: string } | { action: 'create'; because: 'busy' | 'none' } {
  const owners = chats.filter((c) => c.editingModId === modId);
  if (owners.length) {
    // Several chats can point at one mod (save a draft in one, then save over it from another).
    // The most recently used one is the conversation the user was last having about it.
    const best = owners.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
    return { action: 'reuse', chatId: best.id, unarchive: best.archived };
  }
  if (current?.empty) return { action: 'seed', chatId: current.id };
  return { action: 'create', because: current ? 'busy' : 'none' };
}

/**
 * Whether a mod's patterns cover the page the user is on, for the line the panel shows when they
 * are not. Not a guess at where it DOES run: the honest statement is "not on this page", plus the
 * patterns, and the user knows their own browsing better than a derived URL would.
 */
export function runsOnPage(mod: Pick<Mod, 'matches' | 'includeGlobs' | 'excludeMatches' | 'excludeGlobs'>, url: string): boolean {
  if (!url) return false;
  return modMatchesUrl(mod as Mod, url);
}

/**
 * A URL a mod plainly runs on, derived from one simple match pattern, or ''.
 *
 * Deliberately modest, as the brief asks. Only `scheme://host/path` patterns whose host carries at
 * most a leading `*.` are turned into a URL, and a path wildcard becomes `/`. Anything cleverer —
 * guessing a real article URL out of `*://*.wikipedia.org/wiki/*` — would produce a link that 404s
 * and reads as the product being confidently wrong, which is worse than offering nothing.
 */
export function likelyUrlFor(matches: string[]): string {
  for (const p of matches) {
    const m = p.match(/^(\*|https?):\/\/([^/*]+|\*\.[^/*]+)(\/.*)?$/);
    if (!m) continue;
    const scheme = m[1] === '*' ? 'https' : m[1]!;
    const host = m[2]!.replace(/^\*\./, '');
    const path = (m[3] ?? '/').replace(/\*.*$/, '');
    return `${scheme}://${host}${path.startsWith('/') ? path : `/${path}`}`;
  }
  return '';
}

/**
 * Whether open_mod may adopt a mod's source as this chat's draft, and what to tell the model if not.
 *
 * The rule: an UNSAVED draft is never silently replaced. The user may have spent five turns on it
 * and it exists nowhere else, so a model that opens a mod over the top of it destroys the only copy
 * — and the model cannot know it was unsaved, because nothing in the conversation says so. It is
 * refused with an explanation naming both ways out (save it, or pass replace: true), which is a tool
 * error the model recovers from inside the same turn.
 *
 * `replace: true` is honoured even then, and it still loses nothing: adopting a mod APPENDS a
 * version to the existing artifact rather than starting a new one, so every version the chat has
 * ever held is still in the strip and one rollback away. That is why `replace` can be a plain
 * boolean rather than a confirmation the user has to give.
 *
 * Opening the mod this chat is ALREADY linked to is a no-op rather than an error: it is what a
 * model does when it is being careful, and refusing it would teach it not to be.
 */
export function openModDecision(
  standing: DraftStanding,
  { replace = false, alreadyLinked = false }: { replace?: boolean; alreadyLinked?: boolean } = {},
): { ok: true; noop: boolean } | { ok: false; reason: string } {
  if (alreadyLinked) return { ok: true, noop: true };
  if (standing !== 'unsaved' || replace) return { ok: true, noop: false };
  return {
    ok: false,
    reason:
      'This chat already has a draft with unsaved changes, and opening a mod would make that mod the draft instead. Either tell the user to save the draft first, or call open_mod again with replace: true if they want to switch to editing the installed mod — the draft’s versions are kept in the panel’s history either way.',
  };
}
