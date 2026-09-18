// What propose_mod checks before a proposal card reaches the user.
//
// Until now it validated only that the required fields were present, so an untested script with a
// syntax error and a `<all_urls>` match was as acceptable as a working one. Each check below
// returns a message the model can act on and recover from within the same turn — they are tool
// errors, not thrown exceptions, because the point is to get a better proposal, not to end the run.
//
// Pure: no chrome APIs, no DOM. Tested under node.

import { parseError } from '../runscript.ts';

export interface ProposalContext {
  /** Whether a run_script has completed successfully since the last accepted proposal. */
  testedSinceProposal: boolean;
  /** The user's message for this turn, used to decide whether a site-wide match was asked for. */
  userText: string;
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
    return 'Test the script with run_script before proposing it. Run it once on this page and confirm it does what you expect; if you genuinely cannot test it here, call propose_mod again with untested_reason explaining why, and the user will be told it is untested.';
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
