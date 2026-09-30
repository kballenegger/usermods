// What propose_mod checks before a proposal card reaches the user.
//
// Until now it validated only that the required fields were present, so an untested script with a
// syntax error and a `<all_urls>` match was as acceptable as a working one. Each check below
// returns a message the model can act on and recover from within the same turn — they are tool
// errors, not thrown exceptions, because the point is to get a better proposal, not to end the run.
//
// Pure: no chrome APIs, no DOM. Tested under node.

import { parseError } from '../runscript.ts';
import { sourceKey } from './testmod.ts';

export interface ProposalContext {
  /** Whether a run_script or test_mod has completed successfully since the last accepted proposal. */
  testedSinceProposal: boolean;
  /** The user's message for this turn, used to decide whether a site-wide match was asked for. */
  userText: string;
  /** The last test_mod since the last proposal: which code it ran (sourceKey), how, and whether it ran. */
  lastTest?: { key: string; fresh: boolean; ok: boolean };
}

/**
 * How the proposed code was tested, as the card shows it. `undefined` is "not tested": the gate
 * has already refused it unless the model gave an untested_reason, which the card shows instead.
 *
 *   fresh-load  test_mod with reload ran THIS code as the saved mod, on a clean page load
 *   open-page   something ran on the already-loaded page: test_mod without reload, a test_mod of
 *               different code, or run_script — evidence, but not that this mod works on a visit
 */
export type TestedAs = 'fresh-load' | 'open-page';

export function testedAs(ctx: ProposalContext, code: string): TestedAs | undefined {
  const t = ctx.lastTest;
  if (t?.ok && t.key === sourceKey(code)) return t.fresh ? 'fresh-load' : 'open-page';
  return ctx.testedSinceProposal ? 'open-page' : undefined;
}

/**
 * The sentence the model gets back about testing, so it knows what the user was told. Stated, not
 * demanded: a model told to go back and test tends to loop, and a mod whose target only appears
 * after interaction cannot be tested on load at all. The card telling the truth is the point.
 */
export function testedNote(ctx: ProposalContext, code: string): string {
  const state = testedAs(ctx, code);
  if (state === 'fresh-load') return 'The card says it was tested as the saved mod on a fresh load.';
  if (state !== 'open-page') return '';
  const t = ctx.lastTest;
  const why = !t ? '' : t.key !== sourceKey(code) ? ' (this code is not what test_mod last ran)' : !t.ok ? ' (test_mod failed on this code)' : '';
  return `The card says it was tested on the open page only, not as the saved mod on a fresh load${why}.`;
}

export interface ProposalCandidate {
  code: string;
  matches: string[];
  /** The model's stated reason for proposing without a test. Bypasses only the "test it" check. */
  untestedReason?: string;
}

/** Match patterns broad enough that the user has to have asked for them. */
const EVERY_SITE_PATTERNS = new Set(['<all_urls>', '*://*/*', '*://*', 'http://*/*', 'https://*/*']);

/** Phrases that read as "yes, everywhere" rather than "on this site". */
const EVERY_SITE_PHRASES = [/\bevery site\b/i, /\ball sites\b/i, /\beverywhere\b/i, /\bevery website\b/i, /\ball websites\b/i];

export function askedForEverySite(userText: string): boolean {
  return EVERY_SITE_PHRASES.some((re) => re.test(userText));
}

/**
 * Constructs a mod must not use, each one either blocked by the user-script world's CSP or by our
 * own prompt rules. Catching them here rather than at save time means the model gets to fix its
 * own script while it still has the page in front of it.
 */
const BANNED: Array<{ re: RegExp; what: string }> = [
  { re: /\beval\s*\(/, what: 'eval()' },
  { re: /\bnew\s+Function\s*\(/, what: 'new Function()' },
  { re: /\bdocument\s*\.\s*write(?:ln)?\s*\(/, what: 'document.write()' },
  // An inline handler attribute set through the DOM, e.g. setAttribute('onclick', …) or `onclick="…"`
  // inside an HTML string. Both are refused by the isolated world's CSP at run time.
  { re: /setAttribute\s*\(\s*['"`]on[a-z]+['"`]/i, what: 'an inline event-handler attribute' },
  { re: /<[a-z][^>]*\son[a-z]+\s*=\s*['"]/i, what: 'an inline event-handler attribute' },
];

/**
 * Check a candidate proposal. Returns null when it is acceptable, or the message the model is sent
 * as a tool error. Checks run in the order a human would care about: is it tested, does it parse,
 * is it safe, is its reach what the user asked for.
 */
export function checkProposal(candidate: ProposalCandidate, ctx: ProposalContext): string | null {
  if (!ctx.testedSinceProposal && !candidate.untestedReason) {
    return 'Test the script with test_mod before proposing it, and confirm it does what you expect; if you genuinely cannot test it here, call propose_mod again with untested_reason explaining why, and the user will be told it is untested.';
  }

  const syntax = parseError(candidate.code);
  if (syntax) return `The script does not parse, so it would fail on every page load. ${syntax.message}`;

  for (const b of BANNED) {
    if (b.re.test(candidate.code)) {
      return `The script uses ${b.what}, which the isolated user-script world blocks — it would throw at run time. Rewrite it using the DOM (createElement, addEventListener, textContent) and propose again.`;
    }
  }

  const broad = candidate.matches.find((m) => EVERY_SITE_PATTERNS.has(m.trim()));
  if (broad && !askedForEverySite(ctx.userText)) {
    return `The match pattern ${broad} would run this mod on every site the user visits, and they did not ask for that. Narrow it to the site this is for, e.g. *://*.example.com/*. If they really do want it everywhere, ask them first.`;
  }

  return null;
}
