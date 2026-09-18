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
export const ACT_TOOLS = new Set(['run_script', 'propose_mod']);

/** More than this many reads with nothing acted on earns a nudge. */
export const READ_BUDGET = 3;

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
 * Fold one iteration's tool calls into the running count of page reads since the last time the
 * model actually did something.
 *
 * An act anywhere in the batch clears the count, even if reads came after it in the same batch:
 * the model that ran a script and then looked at the result is doing the right thing, and
 * punishing it for the look would push it toward acting blind.
 */
export function countReads(previous: number, toolNames: readonly string[]): number {
  if (toolNames.some((n) => ACT_TOOLS.has(n))) return 0;
  return previous + toolNames.filter((n) => READ_TOOLS.has(n)).length;
}

/**
 * The read-budget nudge, or null while under budget. `justCrossed` keeps it from repeating: it
 * fires on the step where the count first exceeds the budget, and again only after the count has
 * been reset by an act and climbed back over.
 */
export function readBudgetNudge(reads: number, previousReads: number, budget = READ_BUDGET): string | null {
  if (reads <= budget || previousReads > budget) return null;
  return `[You have made ${reads} page reads without running or proposing anything. Act now: test with run_script or ask the user one question.]`;
}
