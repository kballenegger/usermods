// wait_for: the tool that lets the agent wait for the page instead of polling it.
//
// The complaint this answers is "it's not handling waiting for things well". With no way to wait,
// a model faced with anything asynchronous — a lazy-loaded list, a SPA route change, a modal that
// animates in, a click whose result arrives 800ms later — has exactly three moves, and all three
// are bad:
//
//   * poll with run_script or get_page in a loop, which burns the 30-step budget and trips the
//     read-budget nudge, so the loop then tells it off for doing the only thing it could do;
//   * write a setTimeout loop inside run_script, which sits against that tool's 20s timeout and
//     comes back as "No result after 20s" — an error row for something that worked;
//   * proceed too early, find nothing, and report failure on a page that was merely still loading.
//
// So this module owns everything about waiting that does not need a browser: what a condition is,
// what a valid one looks like, how a finished wait is worded for the model, and when a run has
// waited so much that it should be told to stop. The DOM half lives in the content script and the
// navigation half in the background, both of which take a NORMALISED condition from here — so the
// defaults and the caps exist in exactly one place and a test can reach all of them.
//
// Two decisions shape the rest of the file.
//
// A timeout is NOT an error. It is the single most informative thing a wait can report: it says
// the condition did not happen, and — with the diagnostics attached — usually says whether it was
// never going to. A model that gets `isError` back treats waiting as a thing that failed and goes
// back to polling; a model that gets "no elements match .result; closest: 12 elements match li"
// changes its selector. Only invalid input and a closed tab are real errors here.
//
// Waiting must be cheap to attempt and expensive to repeat. One wait is the right move; four in a
// row means the condition is not coming, and the model needs to hear that rather than keep going.

/** Default timeout for a wait, in ms. Long enough for ordinary page work, short enough to retry. */
export const DEFAULT_TIMEOUT_MS = 5_000;

/** The hard cap on a single wait. Beyond this the model should be telling the user what is stuck. */
export const MAX_TIMEOUT_MS = 20_000;

/** Default quiet window for `idle`. */
export const DEFAULT_QUIET_MS = 500;

/** The range `quiet_ms` is clamped into. Below 100 every rAF looks like noise; above 2s it is a nap. */
export const MIN_QUIET_MS = 100;
export const MAX_QUIET_MS = 2_000;

/**
 * The cap on a plain `ms` delay. Deliberately far below MAX_TIMEOUT_MS: a blind sleep is the last
 * resort, and one that could run 20s would be reached for instead of a real condition.
 */
export const MAX_SLEEP_MS = 5_000;

/** More than this many wait_for calls in a row earns a nudge. */
export const CONSECUTIVE_WAIT_LIMIT = 3;

/** …as does this much cumulative waiting inside one turn. */
export const CUMULATIVE_WAIT_LIMIT_MS = 60_000;

/** How long an element must have existed to be worth reporting — see `visible`, below. */
export type ElementState = 'attached' | 'visible' | 'hidden' | 'detached';

export const ELEMENT_STATES: readonly ElementState[] = ['attached', 'visible', 'hidden', 'detached'];

export type LoadState = 'domcontentloaded' | 'complete';

export const LOAD_STATES: readonly LoadState[] = ['domcontentloaded', 'complete'];

/**
 * A normalised condition: exactly one kind, every default filled in, every cap applied. Nothing
 * downstream re-reads the model's raw input, so nothing downstream can disagree about what 'a
 * wait with no timeout' means.
 */
export type WaitCondition =
  | { kind: 'selector'; selector: string; state: ElementState; count: number; text?: string }
  | { kind: 'text'; text: string; gone: boolean }
  | { kind: 'url'; pattern: string; regex: boolean }
  | { kind: 'load'; state: LoadState }
  | { kind: 'idle'; quietMs: number }
  | { kind: 'ms'; ms: number };

/** A validated wait: the condition plus how long we will give it. */
export interface WaitSpec {
  condition: WaitCondition;
  timeoutMs: number;
}

export type ParseResult = { ok: true; spec: WaitSpec } | { ok: false; error: string };

/** Which kinds run in the page (content script) rather than against the tab (background). */
export function isDomCondition(c: WaitCondition): boolean {
  return c.kind === 'selector' || c.kind === 'text' || c.kind === 'idle';
}

// ---------------------------------------------------------------------------
// Parsing the model's input
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * A `/…/flags` pattern, or null when the string is a plain substring.
 *
 * Only a string that both starts and ends with `/` is treated as a regex, which is the form the
 * tool description promises. A URL genuinely containing slashes at both ends ("/docs/") is
 * vanishingly rare next to the usefulness of the shorthand, and a model that wants that exact
 * substring can write `docs/`.
 */
export function regexBody(pattern: string): { body: string; flags: string } | null {
  const m = /^\/(.*)\/([gimsuy]*)$/s.exec(pattern);
  if (!m || m[1] === '') return null;
  return { body: m[1]!, flags: m[2]! };
}

/**
 * Validate a URL pattern up front, so a bad regex is an input error the model can fix rather than
 * a wait that silently never matches. Returns an error message, or null when the pattern is fine.
 */
export function urlPatternError(pattern: string): string | null {
  const re = regexBody(pattern);
  if (!re) return null;
  try {
    new RegExp(re.body, re.flags.replace(/g/g, ''));
    return null;
  } catch (e) {
    return `Invalid regular expression in url: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** Does a URL satisfy a url condition? Shared by the background and by tests. */
export function urlMatches(url: string, c: Extract<WaitCondition, { kind: 'url' }>): boolean {
  if (!c.regex) return url.includes(c.pattern);
  const re = regexBody(c.pattern);
  if (!re) return url.includes(c.pattern);
  try {
    // 'g' is dropped: a global regex carries lastIndex between tests, so the same URL would match
    // and then not match on alternate polls. Nothing here wants iteration semantics.
    return new RegExp(re.body, re.flags.replace(/g/g, '')).test(url);
  } catch {
    return false;
  }
}

/**
 * Turn whatever the model sent into a WaitSpec, or into a sentence saying what is wrong with it.
 *
 * "Exactly one condition" is enforced rather than resolved by precedence, because the alternative
 * silently ignores half of what the model asked for: `{selector: '.result', text: 'Done'}` reads,
 * to a model, like "wait for .result containing Done", and quietly answering a different question
 * than the one asked is how an agent loses the thread.
 *
 * `selector` + `text` is the one legal pair, and it is one condition, not two: the text is a
 * filter on the matched elements, which is exactly how a person would say it ("wait for the row
 * that says Done").
 */
export function parseCondition(raw: unknown): { ok: true; condition: WaitCondition } | { ok: false; error: string } {
  if (!isRecord(raw)) return { ok: false, error: 'wait_for needs an object describing one condition.' };

  const has = (k: string) => raw[k] !== undefined && raw[k] !== null;
  // `state` and `count` belong to `selector`, `gone` to `text`, `quiet_ms` to `idle`: they are
  // modifiers, so they never count as a condition of their own.
  const present = (['selector', 'text', 'url', 'load', 'idle', 'ms'] as const).filter((k) => has(k));

  // selector + text is the filtered-element form, so it collapses to one condition.
  const kinds = present.filter((k) => !(k === 'text' && present.includes('selector')));
  if (!kinds.length) {
    return {
      ok: false,
      error: 'wait_for needs exactly one condition: selector, text, url, load, idle or ms.',
    };
  }
  if (kinds.length > 1) {
    return {
      ok: false,
      error: `wait_for takes exactly one condition, but got ${kinds.join(' and ')}. Make one call per thing you are waiting for.`,
    };
  }

  switch (kinds[0]) {
    case 'selector': {
      const selector = raw.selector;
      if (typeof selector !== 'string' || !selector.trim()) return { ok: false, error: 'selector must be a non-empty CSS selector.' };
      let state: ElementState = 'visible';
      if (has('state')) {
        if (typeof raw.state !== 'string' || !ELEMENT_STATES.includes(raw.state as ElementState)) {
          return { ok: false, error: `state must be one of ${ELEMENT_STATES.join(', ')}.` };
        }
        state = raw.state as ElementState;
      }
      let count = 1;
      if (has('count')) {
        const n = Number(raw.count);
        if (!Number.isFinite(n) || n < 1) return { ok: false, error: 'count must be a positive integer.' };
        count = Math.floor(n);
      }
      let textFilter: string | undefined;
      if (has('text')) {
        if (typeof raw.text !== 'string' || !raw.text.trim()) return { ok: false, error: 'text must be a non-empty string.' };
        textFilter = raw.text;
      }
      // 'detached' with a count is a contradiction the model would never get an answer to: it asks
      // for at least N elements that are not there. Refusing says so; silently ignoring the count
      // would wait 5s and report a timeout that looks like the page's fault.
      if (state === 'detached' && has('count') && count > 1) {
        return { ok: false, error: 'count does not apply to state "detached", which waits for nothing to match.' };
      }
      return { ok: true, condition: { kind: 'selector', selector: selector.trim(), state, count, ...(textFilter ? { text: textFilter } : {}) } };
    }
    case 'text': {
      if (typeof raw.text !== 'string' || !raw.text.trim()) return { ok: false, error: 'text must be a non-empty string.' };
      return { ok: true, condition: { kind: 'text', text: raw.text, gone: raw.gone === true } };
    }
    case 'url': {
      if (typeof raw.url !== 'string' || !raw.url.trim()) return { ok: false, error: 'url must be a non-empty substring or /regex/.' };
      const pattern = raw.url.trim();
      const bad = urlPatternError(pattern);
      if (bad) return { ok: false, error: bad };
      return { ok: true, condition: { kind: 'url', pattern, regex: regexBody(pattern) !== null } };
    }
    case 'load': {
      if (typeof raw.load !== 'string' || !LOAD_STATES.includes(raw.load as LoadState)) {
        return { ok: false, error: `load must be one of ${LOAD_STATES.join(', ')}.` };
      }
      return { ok: true, condition: { kind: 'load', state: raw.load as LoadState } };
    }
    case 'idle': {
      // `idle: true` is the natural way to ask for it; `idle: {quiet_ms}` and a bare number are
      // accepted too, because a model that has read the schema will try all three.
      const v = raw.idle;
      let quiet: number = DEFAULT_QUIET_MS;
      if (typeof v === 'number') quiet = v;
      else if (isRecord(v) && v.quiet_ms !== undefined) quiet = Number(v.quiet_ms);
      else if (has('quiet_ms')) quiet = Number(raw.quiet_ms);
      else if (v !== true && v !== 'true') return { ok: false, error: 'idle must be true, or a quiet_ms number.' };
      if (!Number.isFinite(quiet)) return { ok: false, error: 'quiet_ms must be a number of milliseconds.' };
      return { ok: true, condition: { kind: 'idle', quietMs: clamp(Math.round(quiet), MIN_QUIET_MS, MAX_QUIET_MS) } };
    }
    case 'ms': {
      const n = Number(raw.ms);
      if (!Number.isFinite(n) || n < 0) return { ok: false, error: 'ms must be a number of milliseconds.' };
      return { ok: true, condition: { kind: 'ms', ms: clamp(Math.round(n), 0, MAX_SLEEP_MS) } };
    }
  }
  /* c8 ignore next */
  return { ok: false, error: 'wait_for needs exactly one condition.' };
}

/**
 * The whole input: one condition plus `timeout_ms`.
 *
 * A plain `ms` delay takes its own duration as the timeout, so the two numbers cannot contradict
 * each other — `{ms: 3000, timeout_ms: 1000}` would otherwise be a sleep that times out before it
 * finishes, and there is no sensible thing to report for that.
 */
export function parseWaitInput(raw: unknown): ParseResult {
  const parsed = parseCondition(raw);
  if (!parsed.ok) return parsed;
  const condition = parsed.condition;

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (isRecord(raw) && raw.timeout_ms !== undefined && raw.timeout_ms !== null) {
    const n = Number(raw.timeout_ms);
    if (!Number.isFinite(n) || n <= 0) return { ok: false, error: 'timeout_ms must be a positive number of milliseconds.' };
    timeoutMs = clamp(Math.round(n), 1, MAX_TIMEOUT_MS);
  }
  if (condition.kind === 'ms') timeoutMs = Math.max(condition.ms, 1);
  return { ok: true, spec: { condition, timeoutMs } };
}

// ---------------------------------------------------------------------------
// Describing a condition
// ---------------------------------------------------------------------------

/** One short phrase naming what is being waited for, e.g. `.result to be visible`. */
export function describeCondition(c: WaitCondition): string {
  switch (c.kind) {
    case 'selector': {
      const what = c.count > 1 ? `${c.count} elements matching ${c.selector}` : c.selector;
      const filter = c.text ? ` containing "${c.text}"` : '';
      if (c.state === 'detached') return `${c.selector}${filter} to be gone from the DOM`;
      return `${what}${filter} to be ${c.state}`;
    }
    case 'text':
      return c.gone ? `the text "${c.text}" to disappear from the page` : `the text "${c.text}" to appear on the page`;
    case 'url':
      return `the URL to match ${c.pattern}`;
    case 'load':
      return `the page to reach ${c.state}`;
    case 'idle':
      return `the DOM to stop changing for ${c.quietMs}ms`;
    case 'ms':
      return `${c.ms}ms to pass`;
  }
}

/**
 * The compact form for a transcript row's title: `.result visible`, `url /checkout/`.
 *
 * Shorter than describeCondition, which is a sentence for the model. This sits after the tool
 * name in a 420px row, so it says only what varies between one wait and the next.
 */
export function waitConditionLabel(c: WaitCondition): string {
  switch (c.kind) {
    case 'selector': {
      const count = c.count > 1 ? `×${c.count} ` : '';
      const filter = c.text ? ` "${c.text}"` : '';
      return `${c.selector}${filter} ${count}${c.state}`.trim();
    }
    case 'text':
      return `text "${c.text}"${c.gone ? ' gone' : ''}`;
    case 'url':
      return `url ${c.pattern}`;
    case 'load':
      return `load ${c.state}`;
    case 'idle':
      return `idle ${c.quietMs}ms`;
    case 'ms':
      return `${c.ms}ms`;
  }
}

/**
 * The identifier the activity line shows in its mono slot: the selector, the text, the URL
 * pattern. Truncated, because a long selector would push the elapsed timer off a 420px panel.
 */
export function waitIdentifier(c: WaitCondition, max = 32): string {
  const raw = (() => {
    switch (c.kind) {
      case 'selector':
        return c.selector;
      case 'text':
        return `"${c.text}"`;
      case 'url':
        return c.pattern;
      case 'load':
        return c.state;
      case 'idle':
        return 'idle';
      case 'ms':
        return `${c.ms}ms`;
    }
  })();
  return raw.length > max ? raw.slice(0, max - 1) + '…' : raw;
}

/**
 * The activity line's label for a wait in progress: `waiting for .result`.
 *
 * It goes through the same `detail` channel every other tool uses, and lib/activity.ts decides
 * whether that detail reads as an identifier or as prose. A selector does; "waiting for X" as a
 * whole does not, which is why this returns the two halves rather than one string.
 */
export function waitActivityDetail(c: WaitCondition): string {
  return `waiting for ${waitIdentifier(c)}`;
}

// ---------------------------------------------------------------------------
// The outcome
// ---------------------------------------------------------------------------

/**
 * What a finished wait knows. `diagnostics` is what makes a timeout worth reading: the current
 * state of the thing that did not happen, so the model can tell "still loading" from "never".
 */
export interface WaitOutcome {
  matched: boolean;
  /** How long the wait actually took, in ms. */
  elapsedMs: number;
  /** On a match: what matched, e.g. '3 elements match .result (first: <li class="result">…)'. */
  detail?: string;
  /** On a timeout: the current state, one fact per line. */
  diagnostics?: string[];
  /** Set when the wait could not run at all (closed tab, torn-down page). Renders as an error. */
  failure?: string;
}

/** `1,240ms` — grouped, because a model reading `1240ms` next to `240ms` misreads the magnitude. */
export function formatMs(ms: number): string {
  return `${Math.round(ms).toLocaleString('en-US')}ms`;
}

/** `1.2s` / `5s`, for the transcript row, where the precise millisecond is noise. */
export function formatSeconds(ms: number): string {
  const s = ms / 1000;
  if (s >= 10) return `${Math.round(s)}s`;
  const r = Math.round(s * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)}s`;
}

/**
 * The text the model gets back, and whether it counts as an error.
 *
 * A timeout is never an error (see the header). It is phrased as a plain statement of fact —
 * "waited 5,000ms; X did not happen" — followed by whatever we could learn about why, because a
 * model that is told only "timed out" will either retry the identical wait or give up, and both
 * are wrong roughly half the time.
 */
export function renderWaitResult(spec: WaitSpec, outcome: WaitOutcome): { text: string; isError: boolean } {
  if (outcome.failure) return { text: outcome.failure, isError: true };

  const what = describeCondition(spec.condition);
  if (outcome.matched) {
    const head = `matched after ${formatMs(outcome.elapsedMs)}: ${outcome.detail ?? what}`;
    return { text: head, isError: false };
  }

  const lines = [`Timed out after ${formatMs(outcome.elapsedMs)} waiting for ${what}. This is not an error — it is what the page did.`];
  if (outcome.diagnostics?.length) lines.push(...outcome.diagnostics);
  lines.push(
    'If the state below says it will never happen, change approach rather than waiting again; if it looks like progress, one more wait is reasonable.',
  );
  return { text: lines.join('\n'), isError: false };
}

/** The transcript row's one-line outcome: `matched after 1.2s` / `timed out after 5s`. */
export function waitRowSummary(outcome: WaitOutcome): string {
  if (outcome.failure) return outcome.failure;
  return outcome.matched ? `matched after ${formatSeconds(outcome.elapsedMs)}` : `timed out after ${formatSeconds(outcome.elapsedMs)}`;
}

// ---------------------------------------------------------------------------
// The abuse guard
// ---------------------------------------------------------------------------

/**
 * How much this turn has waited. Held by the loop, folded by `foldWait`, read by `waitAbuseNudge`.
 *
 * It counts CONSECUTIVE waits rather than total ones on purpose: a turn that waits, acts, waits,
 * acts is using the tool exactly as intended and must never be nudged for it. What is worth
 * interrupting is a run that has stopped doing anything but wait.
 */
export interface WaitTally {
  /** wait_for calls since the last non-wait tool call. */
  consecutive: number;
  /** Total ms spent inside wait_for in this turn, across all of them. */
  totalMs: number;
  /** True once the nudge has fired, so it does not repeat on every subsequent wait. */
  nudged: boolean;
}

export const EMPTY_TALLY: WaitTally = { consecutive: 0, totalMs: 0, nudged: false };

/**
 * Fold one iteration's tool calls into the tally. `waitedMs` is the real elapsed time of the waits
 * in this batch, so a wait that matched in 30ms costs the budget 30ms rather than its timeout —
 * the cheap, correct wait is the one we want the model making.
 *
 * Any non-wait tool in the batch resets the streak, which mirrors how countReads treats an act.
 */
export function foldWait(tally: WaitTally, toolNames: readonly string[], waitedMs: number): WaitTally {
  const waits = toolNames.filter((n) => n === 'wait_for').length;
  const acted = toolNames.some((n) => n !== 'wait_for');
  const totalMs = tally.totalMs + waitedMs;
  if (!waits) return { consecutive: 0, totalMs, nudged: false };
  const consecutive = acted ? waits : tally.consecutive + waits;
  // Acting clears the "already nudged" flag too: the model did what it was told, so a later streak
  // deserves to be told again.
  return { consecutive, totalMs, nudged: acted ? false : tally.nudged };
}

/**
 * The nudge, or null. Fires once per streak, on the call that crosses either line, and names the
 * count so the model can see it is a pattern rather than one unlucky wait.
 */
export function waitAbuseNudge(tally: WaitTally): string | null {
  if (tally.nudged) return null;
  const tooMany = tally.consecutive > CONSECUTIVE_WAIT_LIMIT;
  // `>=`, not `>`: a turn that has spent exactly the limit waiting has spent it.
  const tooLong = tally.totalMs >= CUMULATIVE_WAIT_LIMIT_MS;
  if (!tooMany && !tooLong) return null;
  // The two triggers need different first sentences. "You have waited 1 time in a row" is what
  // the streak wording produces for the cumulative case — three 20s waits with real work between
  // them — and a nudge whose opening line is visibly false is one the model is right to discount.
  const opening = tooMany
    ? `You have waited ${tally.consecutive} times in a row.`
    : `You have spent ${Math.round(tally.totalMs / 1000)}s of this turn waiting.`;
  return `[${opening} If the condition is not going to happen, change approach or tell the user what is blocking you.]`;
}

/** The tally after a nudge has been emitted for it. */
export function markNudged(tally: WaitTally): WaitTally {
  return tally.nudged ? tally : { ...tally, nudged: true };
}
