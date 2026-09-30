// The two nudges the loop appends to a tool-results message, kept pure so their wording and their
// firing conditions are testable without a provider, a browser or a model.
//
// Both exist because a stated rule in the system prompt is not a constraint: the model reads
// "do not over-investigate", makes twelve get_page calls anyway, and nothing ever contradicts it.
// A counter the loop keeps, surfaced in the conversation at the moment it matters, is.

/** The hard cap on model round-trips in one turn. */
export const MAX_ITERATIONS = 30;

/** How many iterations remain when the wrap-up nudge fires. */
export const WRAPUP_AT = 5;

/** Tools that only look at the page. Making one of these is not progress. */
export const READ_TOOLS = new Set(['get_page', 'find_elements', 'get_styles', 'screenshot']);

/** Tools that count as acting, and so reset the read counter. */
export const ACT_TOOLS = new Set(['run_script', 'test_mod', 'propose_mod']);

/**
 * wait_for is in NEITHER set, deliberately, and this constant exists to say so out loud.
 *
 * It is not a read: it returns no page content, and counting it as one would charge the model for
 * the very fix that replaced the polling this budget was invented to punish — wait, get nudged
 * for reading too much, go back to run_script loops.
 *
 * It is not an act either: a wait proves nothing about the page and must not clear a read streak,
 * or "get_page, get_page, get_page, wait_for, get_page" would slip the budget forever.
 *
 * It still costs a step, because it is a model round trip like any other. Its own overuse is
 * caught by the separate guard in lib/agent/wait.ts, which measures the thing that actually goes
 * wrong: waiting over and over for something that is not coming.
 *
 * open_mod is here for the same shape of reason. It reads no page — its answer is the user's own
 * installed script — so charging it as a read would make "pick up the existing mod before changing
 * it", the behaviour this product wants most, cost the model a step of its investigation budget.
 * Nor is it an act: adopting a draft proves nothing about the page, so it must not clear a streak
 * of get_page calls that had earned a nudge. It is idempotent and bounded by the mods on the page,
 * so there is nothing here to overuse.
 */
export const NEUTRAL_TOOLS = new Set(['wait_for', 'open_mod']);

/** More than this many whole page reads with nothing acted on earns a nudge. */
export const READ_BUDGET = 3;

/**
 * Reads are charged by what they returned, not one per call.
 *
 * The budget exists because models over-read, and what over-reading costs is tokens and steps. A
 * count per call charged a 150-token find_elements the same as a 15,000-token get_page, so a model
 * that checked three selectors the cheap way was told to stop looking and "act now", which in
 * practice meant injecting scripts to look instead. So:
 *
 *   - FULL_READ_CHARS: a result this long or longer is one whole read. 6,000 characters is about
 *     1,500 tokens, roughly a get_page scoped to one region; the default get_page returns up to
 *     20,000, so every real page read still costs a whole one and four in a row still earn the
 *     nudge, exactly as before. Capped at one, because a long read is not worse than a second read.
 *   - MIN_READ_COST: never less than a quarter. Every call is also a model round trip out of the
 *     turn's 30, so even a one-line answer is not free. Four small lookups cost one page read, and
 *     the budget allows about a dozen of them, or three page reads and a few lookups.
 *   - A screenshot, or a result of unknown size, is charged as a whole read: an image costs about
 *     as much as a page read, and screenshots are not how an element should be found.
 */
export const FULL_READ_CHARS = 6000;
export const MIN_READ_COST = 0.25;

/** One call as the budget sees it. A bare tool name means "size unknown". */
export type ReadCall = string | { name: string; chars?: number; image?: boolean };

/** Reads since the last act: the cost that decides the nudge, and the call count it reports. */
export interface ReadTally {
  units: number;
  calls: number;
}
export const NO_READS: ReadTally = { units: 0, calls: 0 };

/** What one call costs, in whole reads. Zero for anything that is not a read. */
export function readCost(call: ReadCall): number {
  const c = typeof call === 'string' ? { name: call } : call;
  if (!READ_TOOLS.has(c.name)) return 0;
  if (c.image || c.chars === undefined) return 1;
  return Math.min(1, Math.max(MIN_READ_COST, c.chars / FULL_READ_CHARS));
}

/**
 * The wrap-up nudge, or null while there is still room. `iteration` is 0-based, so on the very
 * first pass through the loop it is 0.
 *
 * Fires once, at exactly WRAPUP_AT remaining, rather than on every later iteration: repeating it
 * each step would train the model to ignore it, and it would crowd out the read-budget nudge.
 */
export function wrapUpNudge(iteration: number, max = MAX_ITERATIONS): string | null {
  const remaining = max - iteration - 1;
  if (remaining !== WRAPUP_AT) return null;
  return `[${WRAPUP_AT} steps left in this turn. Do not start new investigation. Finish: propose the mod, report the result, or say what is blocking you.]`;
}

/**
 * Fold one iteration's tool calls into the running tally of page reads since the last time the
 * model actually did something.
 *
 * An act anywhere in the batch clears the tally, even if reads came after it in the same batch:
 * the model that ran a script and then looked at the result is doing the right thing, and
 * punishing it for the look would push it toward acting blind.
 */
export function countReads(previous: ReadTally, calls: readonly ReadCall[]): ReadTally {
  const names = calls.map((c) => (typeof c === 'string' ? c : c.name));
  if (names.some((n) => ACT_TOOLS.has(n))) return NO_READS;
  const reads = calls.filter((c) => readCost(c) > 0);
  return { units: previous.units + reads.reduce((s, c) => s + readCost(c), 0), calls: previous.calls + reads.length };
}

/**
 * The read-budget nudge, or null while under budget. It fires on the step where the cost first
 * exceeds the budget, and again only after an act has reset it and it has climbed back over.
 */
export function readBudgetNudge(reads: ReadTally, previousReads: ReadTally, budget = READ_BUDGET): string | null {
  if (reads.units <= budget || previousReads.units > budget) return null;
  return `[You have made ${reads.calls} page reads without running or proposing anything. Act now: test with run_script or ask the user one question.]`;
}
