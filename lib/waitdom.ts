// The page-side half of wait_for: watching the DOM until a condition is true.
//
// This runs inside the content script, where `document` is real. Everything about WHAT is being
// waited for and HOW the answer is worded lives in lib/agent/wait.ts; this file only knows how to
// watch a live page and how to describe what it currently sees.
//
// Three things decide the shape of it.
//
// A MutationObserver alone is not enough. It fires for DOM changes, and the single most common
// "it appeared" on a real site is a class flip that changes nothing but computed style — an
// element that was always in the DOM and becomes visible via a CSS transition, or a parent whose
// `display` changes in a stylesheet rule the observer never sees as a mutation on our subtree. So
// the observer is a fast path and a polling fallback is the floor: without the poll, a class-only
// reveal would sit there until the timeout on a condition that came true 200ms in.
//
// The condition is checked BEFORE anything is installed. An already-true condition is the common
// case after a run_script that did its work synchronously, and it must cost ~0ms rather than one
// observer tick — otherwise the model learns that waiting is expensive and goes back to polling.
//
// Everything is torn down exactly once, through one `finish`. A wait that leaves an observer, an
// interval or a listener behind on someone else's page is a bug that compounds: Stop, a closing
// tab and a navigation all have to arrive at the same cleanup, and the browser flow asserts that
// the page has none left (see __usermodsWaitObservers under the test flag).

import type { WaitCondition, WaitOutcome } from './agent/wait';

/**
 * How often the fallback poll checks, in ms. Fast enough that a style-only reveal is reported as
 * having taken roughly when it happened, slow enough to be free on a busy page.
 */
const POLL_MS = 100;

/**
 * Is an element visible? Attached, non-zero box, and not hidden by display / visibility / opacity.
 *
 * Deliberately NOT "in the viewport". A model waiting for `.result` after a click wants to know
 * the result exists and is rendered; whether it happens to be below the fold is a question about
 * scrolling, not about loading, and answering it here would make every wait on a long page time
 * out for the wrong reason. The tool description says so explicitly.
 */
export function isElementVisible(el: Element): boolean {
  if (!el.isConnected) return false;
  const html = el as HTMLElement;
  const cs = getComputedStyle(html);
  if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  if (Number(cs.opacity) === 0) return false;
  const r = html.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    // A zero box is usually invisible, but not always: an element whose only content is an
    // absolutely positioned child measures zero and is plainly on screen. offsetParent catches the
    // ordinary rendered case without a second layout pass.
    if (!html.offsetParent && cs.position !== 'fixed') return false;
  }
  return true;
}

/** The visible text of the page, lowercased once so repeated polls do not re-lower it per check. */
function pageText(): string {
  return (document.body?.innerText ?? document.body?.textContent ?? '').toLowerCase();
}

function elementText(el: Element): string {
  return ((el as HTMLElement).innerText ?? el.textContent ?? '').toLowerCase();
}

/** A short `<li class="result">…` for the "what matched" half of a success message. */
export function describeElement(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const attrs: string[] = [];
  if (el.id) attrs.push(`id="${el.id}"`);
  const cls = el.getAttribute('class');
  if (cls) attrs.push(`class="${cls.length > 40 ? cls.slice(0, 39) + '…' : cls}"`);
  const text = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const short = text.length > 40 ? text.slice(0, 39) + '…' : text;
  return `<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>${short}`;
}

/** The elements a selector condition currently counts as matching. Throws on an invalid selector. */
function matchesFor(c: Extract<WaitCondition, { kind: 'selector' }>): Element[] {
  const all = [...document.querySelectorAll(c.selector)];
  const filtered = c.text ? all.filter((el) => elementText(el).includes(c.text!.toLowerCase())) : all;
  switch (c.state) {
    case 'attached':
      return filtered;
    case 'visible':
      return filtered.filter(isElementVisible);
    case 'hidden':
      return filtered.filter((el) => !isElementVisible(el));
    case 'detached':
      return filtered;
  }
}

/** Is the condition true right now? Plus, on success, what to say about it. */
function evaluate(c: WaitCondition, mutations: number, idleSince: number): { matched: boolean; detail?: string } {
  switch (c.kind) {
    case 'selector': {
      const hits = matchesFor(c);
      if (c.state === 'detached') {
        if (hits.length) return { matched: false };
        return { matched: true, detail: `no elements match ${c.selector}${c.text ? ` containing "${c.text}"` : ''}` };
      }
      if (hits.length < c.count) return { matched: false };
      const noun = hits.length === 1 ? 'element matches' : 'elements match';
      const filter = c.text ? ` containing "${c.text}"` : '';
      return { matched: true, detail: `${hits.length} ${noun} ${c.selector}${filter} and ${c.state === 'hidden' ? 'are hidden' : `are ${c.state}`} (first: ${describeElement(hits[0]!)})` };
    }
    case 'text': {
      const present = pageText().includes(c.text.toLowerCase());
      if (c.gone) return present ? { matched: false } : { matched: true, detail: `the text "${c.text}" is no longer on the page` };
      return present ? { matched: true, detail: `the page text contains "${c.text}"` } : { matched: false };
    }
    case 'idle': {
      const quiet = Date.now() - idleSince;
      if (quiet < c.quietMs) return { matched: false };
      return { matched: true, detail: `the DOM has been quiet for ${Math.round(quiet)}ms (${mutations} mutation batches seen before that)` };
    }
    default:
      // url / load / ms never reach the page: they are the background's job.
      return { matched: false };
  }
}

/**
 * What to tell the model when the condition did not happen.
 *
 * This is the reason a timeout is worth having at all. "Timed out" alone leaves the model with two
 * indistinguishable worlds — a page still loading and a selector that was wrong from the start —
 * and it will usually guess the first and wait again. The closest-match line is what separates
 * them: "0 elements match .result; the closest selector that does match is li (12 elements)" says
 * the page has content and the selector is wrong, which is a different next step entirely.
 */
function diagnose(c: WaitCondition, mutations: number, elapsedMs: number): string[] {
  const lines: string[] = [];
  switch (c.kind) {
    case 'selector': {
      const all = (() => {
        try {
          return [...document.querySelectorAll(c.selector)];
        } catch {
          return [];
        }
      })();
      const visible = all.filter(isElementVisible);
      if (!all.length) {
        lines.push(`0 elements match ${c.selector}.`);
        const closest = closestSelector(c.selector);
        if (closest) lines.push(`closest: ${closest}`);
      } else if (c.text) {
        const withText = all.filter((el) => elementText(el).includes(c.text!.toLowerCase()));
        lines.push(`${all.length} element(s) match ${c.selector}, but ${withText.length} contain "${c.text}".`);
        if (all.length && !withText.length) lines.push(`first one's text: ${JSON.stringify(((all[0] as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 120))}`);
      } else {
        // The diagnostics are gathered AFTER the timeout, so the condition can have become true in
        // the moments since. Saying "3 are visible — wanted 3 visible" without explaining it reads
        // as a contradiction and tells the model nothing; saying it became true just too late tells
        // it to wait a little longer next time, which is the correct next step.
        const nowTrue = (() => {
          try {
            return matchesFor(c).length >= c.count;
          } catch {
            return false;
          }
        })();
        if (nowTrue) {
          lines.push(`${all.length} element(s) match ${c.selector}, and the condition is true NOW — it became true just after the timeout. Wait longer next time.`);
        } else {
          lines.push(`${all.length} element(s) match ${c.selector}, of which ${visible.length} are visible — wanted ${c.count} ${c.state}.`);
        }
        if (all[0]) lines.push(`first one: ${describeElement(all[0])}`);
      }
      break;
    }
    case 'text': {
      const present = pageText().includes(c.text.toLowerCase());
      lines.push(c.gone ? `page text still contains "${c.text}".` : `page text does not contain "${c.text}".`);
      if (!c.gone && !present) lines.push(`page text is ${pageText().length} characters long.`);
      break;
    }
    case 'idle':
      lines.push(`the DOM is still changing: ${mutations} mutation batches in the last ${Math.round(elapsedMs)}ms.`);
      break;
    default:
      break;
  }
  lines.push(`document.readyState=${document.readyState}; ${mutations} mutation batches observed in the last ${Math.round(elapsedMs)}ms.`);
  return lines;
}

/**
 * A simpler selector that DOES match, when the asked-for one does not.
 *
 * It walks the selector back one component at a time — `.panel .result li.item` becomes
 * `.panel .result li`, then `.panel .result`, then `.panel` — and reports the first that matches
 * anything. That is the shape of a real mistake: a selector that is right about the region and
 * wrong about the leaf, or right about the tag and wrong about a class the site renamed.
 */
export function closestSelector(selector: string): string | null {
  const attempts: string[] = [];
  // Strip the last compound's qualifiers: `li.item.active` -> `li.item` -> `li`.
  const parts = selector.trim().split(/\s+/);
  for (let i = parts.length; i > 0; i--) {
    const head = parts.slice(0, i).join(' ');
    const last = parts[i - 1]!;
    // Progressive de-qualification of the final compound, longest first.
    const quals = [...last.matchAll(/[.#[:][^.#[:]*/g)].map((m) => m[0]);
    for (let q = quals.length; q >= 0; q--) {
      const base = last.slice(0, last.length - quals.slice(q).join('').length);
      if (!base) continue;
      const candidate = [...parts.slice(0, i - 1), base].join(' ');
      if (candidate && candidate !== selector) attempts.push(candidate);
    }
  }
  for (const a of attempts) {
    try {
      const n = document.querySelectorAll(a).length;
      if (n) return `${n} element(s) match ${a}`;
    } catch {
      /* a partial selector need not be valid; try the next */
    }
  }
  return null;
}

/**
 * The live counter the browser flow reads to prove a wait left nothing behind. It exists only
 * under the test flag, so an ordinary page never gets a property from us.
 */
function debugCounter(delta: number): void {
  const w = globalThis as unknown as { __usermodsWaitDebug?: boolean; __usermodsWaitObservers?: number };
  if (!w.__usermodsWaitDebug) return;
  w.__usermodsWaitObservers = Math.max(0, (w.__usermodsWaitObservers ?? 0) + delta);
}

/**
 * Wait for a DOM condition. Resolves with the outcome; never rejects, never throws after the
 * initial selector validation.
 *
 * `cancel` is how Stop reaches this: the caller stores it and invokes it when the run's
 * AbortSignal fires. The returned promise then settles immediately with `failure` set, and every
 * observer, interval and listener is gone before it does.
 */
export function waitForDom(
  c: WaitCondition,
  timeoutMs: number,
): { promise: Promise<WaitOutcome>; cancel: (reason?: string) => void } {
  const startedAt = Date.now();
  let settled = false;
  let mutations = 0;
  // For `idle`: when the DOM last changed. Starting at "now" means an already-quiet page still has
  // to be quiet for quietMs before it counts, which is the honest reading of "has stopped changing"
  // — we have not observed it being quiet for any length of time yet.
  let idleSince = startedAt;

  let observer: MutationObserver | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onUnload: (() => void) | null = null;
  let resolve!: (o: WaitOutcome) => void;

  const promise = new Promise<WaitOutcome>((r) => {
    resolve = r;
  });

  const teardown = () => {
    if (observer) {
      observer.disconnect();
      observer = null;
      debugCounter(-1);
    }
    if (poll !== null) {
      clearInterval(poll);
      poll = null;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (onUnload) {
      window.removeEventListener('pagehide', onUnload);
      window.removeEventListener('beforeunload', onUnload);
      onUnload = null;
    }
  };

  const finish = (o: WaitOutcome) => {
    if (settled) return;
    settled = true;
    teardown();
    resolve(o);
  };

  const check = () => {
    if (settled) return;
    let r: { matched: boolean; detail?: string };
    try {
      r = evaluate(c, mutations, idleSince);
    } catch (e) {
      finish({ matched: false, elapsedMs: Date.now() - startedAt, failure: `Invalid selector: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    if (r.matched) finish({ matched: true, elapsedMs: Date.now() - startedAt, detail: r.detail });
  };

  // An invalid selector is an input error, reported before a single millisecond is spent on it.
  if (c.kind === 'selector') {
    try {
      document.querySelectorAll(c.selector);
    } catch (e) {
      finish({ matched: false, elapsedMs: 0, failure: `Invalid selector "${c.selector}": ${e instanceof Error ? e.message : String(e)}` });
      return { promise, cancel: () => {} };
    }
  }

  // The already-true case, before anything is installed. This is what makes a wait after a
  // synchronous change cost nothing.
  check();
  if (settled) return { promise, cancel: () => {} };

  observer = new MutationObserver(() => {
    mutations++;
    idleSince = Date.now();
    // `idle` is the one condition a mutation makes LESS true, so there is nothing to re-check on
    // the mutation itself; its poll is what notices the quiet.
    if (c.kind !== 'idle') check();
  });
  debugCounter(1);
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });

  // The floor under the observer: style-only reveals, and `idle`'s quiet window, which by
  // definition is only observable when nothing is firing.
  poll = setInterval(check, POLL_MS);

  // A page that goes away mid-wait resolves with a clear outcome rather than hanging until the
  // timeout. The tool result then says the page navigated, which composes with a then_wait on
  // url/load in the background rather than reading as a failure.
  onUnload = () => {
    finish({
      matched: false,
      elapsedMs: Date.now() - startedAt,
      failure: `The page navigated away after ${Date.now() - startedAt}ms, before ${describeForUnload(c)} happened. Check the new page rather than waiting again.`,
    });
  };
  window.addEventListener('pagehide', onUnload);
  window.addEventListener('beforeunload', onUnload);

  timer = setTimeout(() => {
    const elapsedMs = Date.now() - startedAt;
    let diagnostics: string[];
    try {
      diagnostics = diagnose(c, mutations, elapsedMs);
    } catch {
      diagnostics = [`document.readyState=${document.readyState}`];
    }
    finish({ matched: false, elapsedMs, diagnostics });
  }, timeoutMs);

  return {
    promise,
    cancel: (reason = 'The wait was stopped.') => finish({ matched: false, elapsedMs: Date.now() - startedAt, failure: reason }),
  };
}

/** A minimal phrase for the unload message; the full wording lives in lib/agent/wait.ts. */
function describeForUnload(c: WaitCondition): string {
  if (c.kind === 'selector') return c.selector;
  if (c.kind === 'text') return `"${c.text}"`;
  return 'the condition';
}
