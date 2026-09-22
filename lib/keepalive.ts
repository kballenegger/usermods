// Keeping a run alive on Safari, and picking it up again when Safari took it anyway.
//
// ---------------------------------------------------------------------------
// The problem
// ---------------------------------------------------------------------------
//
// A run lives in the background worker. On Chrome that worker is stopped after 30 seconds without
// an extension event, and the documented answer is to call a trivial extension API on a timer for
// as long as the work lasts — which is what `holdWorker` in entrypoints/background.ts does, and it
// works there.
//
// Safari is not Chrome. On iOS the extension's background is suspended shortly after the popup
// goes away, which is exactly when the user dismisses the sheet and goes back to reading the page.
// The run then stalls, and the next time the popup opens lib/runstate.ts finds a 'running' record
// with no live session behind it, marks it interrupted, and the user is shown a Resume button for
// something they never stopped.
//
// ---------------------------------------------------------------------------
// What the research actually established
// ---------------------------------------------------------------------------
//
// There is no Apple documentation for this. Apple's "Creating a Safari web extension" and the
// WWDC sessions describe the background as non-persistent and say nothing about how to hold it,
// and `runtime.getPlatformInfo` on a timer — Chrome's documented trick — is not honoured: it is an
// API call, not an extension EVENT, and Safari's suspension is driven by the app lifecycle rather
// than by an idle timer. So the evidence is developer reports on Apple's own forums:
//
//   - https://developer.apple.com/forums/thread/758346
//     "Safari Extension Service Worker Permanently Killed on iOS 17.4.x-17.6". The background is
//     killed 30-45 seconds in and, once dead, does NOT wake for webNavigation or for a content
//     script's sendMessage. Apple marked it fixed twice; developers report it unfixed as late as
//     iOS 18.6.2. The only workaround discussed there is reverting to the MV2 `background.scripts`
//     form, which is not open to an MV3 extension with a service-worker background.
//
//   - https://developer.apple.com/forums/thread/764594
//     "Safari Extension Stops on iOS 17.5.1 - 18". This is the one that names a mechanism that
//     measurably helps: a `runtime.connect({ name })` port, reconnected when it drops and pinged
//     on a ~9 second interval, took the background's life from about a minute to about a day on
//     iOS 17.5.1, and roughly a day on 17.6.1 and 18. The same thread reports that reinjecting
//     scripts, `scripting.updateContentScripts` and reconnecting on a null `sendMessage` reply all
//     failed.
//
//   - https://developer.apple.com/forums/thread/757926
//     The related iOS 17.4.1 regression where rapid `sendMessage` calls wedged the background.
//     Apple's engineer says 17.6.1 fixed it. Relevant as evidence that message traffic alone is
//     not a lifeline: the fix was a fix, not a keepalive.
//
// So: an open port from a content script, pinged on an interval, is the mechanism with reported
// evidence behind it. It is a mitigation and not a guarantee, and the honest limits are:
//
//   - iOS can still kill the background under memory pressure, and nothing survives Safari itself
//     being killed or the device rebooting.
//   - A port is held by a CONTENT SCRIPT, so a page with no content script — a CSP or sandbox that
//     blocks injection, a browser-internal page — cannot hold one, and the run falls back to the
//     interrupted/Resume path exactly as it does today.
//   - Nobody outside Apple can say whether a given iOS build honours it. Only a real device can.
//
// Which is why part two exists: if Safari pauses the extension anyway, the run resumes ITSELF once
// when the worker comes back, rather than asking the user to press a button for something they did
// not do. See `autoResumeDecision` below.
//
// ---------------------------------------------------------------------------
// Why this file is pure
// ---------------------------------------------------------------------------
//
// Everything here is a decision, not an effect: which tab should be holding a port, how long to
// wait before reconnecting, and whether a stopped-short run has earned an automatic resume. The
// background owns the ports and the timers and asks these functions what to do, so the rules are
// unit tested in node (test/keepalive.test.ts) rather than inferred from a browser flow.

// Type-only, so this module stays importable by the node test runner, which resolves no
// extensionless relative specifiers.
import type { RunMap, RunRecord } from './runstate';

/**
 * The port a content script opens to hold the background alive.
 *
 * Distinct from the panel's 'agent' port and from lib/exec/protocol's 'usermods-exec', because the
 * background's `onConnect` listeners all share one channel and each has to be able to say "not
 * mine" by name. Namespaced for the same reason every other wire constant here is.
 */
export const KEEPALIVE_PORT = 'usermods-keepalive';

/**
 * How often the holder pings down its port.
 *
 * Nine seconds is the interval in the forum report that measured an effect (thread 764594). It is
 * comfortably under every suspension window anybody has described, and the cost is one empty
 * message every nine seconds on ONE tab, and only while a run is actually in flight — the ping
 * stops the moment the background releases the hold, so an idle extension does nothing at all.
 */
export const KEEPALIVE_PING_MS = 9_000;

/**
 * How long a run may hold the worker before the hold is dropped on its own.
 *
 * Without a ceiling, a run that somehow never ends — a provider that streams a byte an hour, a bug
 * — would pin the background awake on a phone forever, which is a battery cost the user never
 * agreed to. Twenty minutes is well past the agent loop's own limits (its per-request deadline and
 * step cap both land far short of it), so a healthy run is never cut off by this; it only catches
 * the pathological case. When it fires the run is not killed: the hold is released, and if Safari
 * then suspends the background the ordinary interrupted/auto-resume path picks it up.
 */
export const KEEPALIVE_MAX_HOLD_MS = 20 * 60 * 1000;

/** Reconnect backoff for a port that dropped: the page navigated, or the background was suspended. */
export const RECONNECT_BASE_MS = 500;
export const RECONNECT_MAX_MS = 8_000;

/**
 * How long to wait before attempt `n` of reconnecting a dropped port (n counted from 1).
 *
 * Exponential with a ceiling, and no jitter: there is exactly one holder per tab, so there is no
 * thundering herd to spread out, and a predictable delay is a testable one. A dropped port is the
 * NORMAL case during a navigation (the old document's content script is gone and the new one has
 * not loaded yet), so the first retry is quick; a background that is genuinely gone is what the
 * ceiling is for, and the holder keeps trying at that ceiling rather than giving up, because the
 * only thing that can revive a suspended Safari background is something reaching for it.
 */
export function reconnectDelay(attempt: number, base: number = RECONNECT_BASE_MS, max: number = RECONNECT_MAX_MS): number {
  if (attempt <= 1) return base;
  return Math.min(max, base * 2 ** (attempt - 1));
}

// ---------------------------------------------------------------------------
// Which tabs should be holding a port
// ---------------------------------------------------------------------------

/** A run in flight, as the keepalive cares about it: which chat, and which tab it is driving. */
export interface LiveRun {
  chatId: string;
  tabId: number;
}

/**
 * The tabs that should be holding a keepalive port right now.
 *
 * One port per TAB, not per run: two chats running against the same tab need one port between
 * them, and asking that tab's content script twice would have it open two ports and ping twice for
 * no extra life. A tab id that is not a real tab (-1, which is what a run records when the tab
 * could not be resolved) cannot host a content script and is left out.
 *
 * Returns a sorted array so the caller's diff against what it currently holds is stable, and so
 * the tests can assert on it without sorting at the call site.
 */
export function tabsNeedingHold(runs: readonly LiveRun[]): number[] {
  const out = new Set<number>();
  for (const r of runs) if (Number.isInteger(r.tabId) && r.tabId >= 0) out.add(r.tabId);
  return [...out].sort((a, b) => a - b);
}

/** What the background should do to its set of holds to match the runs in flight. */
export interface HoldPlan {
  /** Tabs to ask for a port, because a run needs them and nothing is holding them yet. */
  acquire: number[];
  /** Tabs to release, because no run is driving them any more (or the tab is gone). */
  release: number[];
}

/**
 * Diff what is held against what is needed.
 *
 * The whole keepalive is driven through this one function, so there is a single answer to "is a
 * port open right now?" and it is always "because a run needs it". That is what makes the battery
 * promise checkable: with no runs, `needed` is empty, every hold is released, and nothing pings.
 */
export function holdPlan(held: Iterable<number>, runs: readonly LiveRun[]): HoldPlan {
  const needed = new Set(tabsNeedingHold(runs));
  const current = new Set(held);
  return {
    acquire: [...needed].filter((t) => !current.has(t)).sort((a, b) => a - b),
    release: [...current].filter((t) => !needed.has(t)).sort((a, b) => a - b),
  };
}

/**
 * Whether a hold has outlived KEEPALIVE_MAX_HOLD_MS and should be dropped.
 *
 * Kept as a predicate rather than a `setTimeout` inside the holder so the bound is a rule the tests
 * can state, and so the background can check it on the same tick it checks everything else.
 */
export function holdExpired(acquiredAt: number, now: number, maxMs: number = KEEPALIVE_MAX_HOLD_MS): boolean {
  return now - acquiredAt >= maxMs;
}

/**
 * The note shown when a run's tab was closed under it.
 *
 * The run cannot continue — every tool it has is addressed to that tab — so this is not a Resume
 * situation, and offering one would produce a second failure on the first click. It says what
 * happened instead, in one line.
 */
export const TAB_CLOSED_TEXT = 'The tab this run was working on was closed, so the run stopped.';

// ---------------------------------------------------------------------------
// Automatic resume, on Safari only
// ---------------------------------------------------------------------------

/**
 * How many times a run may resume itself before the user is asked.
 *
 * One. The point of the safety net is a run the USER did not interrupt carrying on across a
 * suspension they did not cause; a run that dies again after being picked up is telling us
 * something the retry loop already failed to fix, and quietly restarting it a third time would be
 * a loop with a model bill attached. After this, the manual Resume button comes back, which is the
 * Chrome behaviour and the behaviour this project shipped.
 */
export const MAX_AUTO_RESUMES = 1;

/** What the panel shows in place of the Resume button when a run picked itself up. */
export const AUTO_RESUMED_TEXT = 'Resumed after Safari paused the extension.';

/**
 * A run record, plus the fields the auto-resume rule adds.
 *
 * `autoResumes` counts the automatic pickups this run has had, and `stoppedByUser` records that the
 * run ended because Stop was pressed. Both live on the stored record rather than in worker memory,
 * because the entire point is that the worker died: anything the decision depends on has to have
 * been written down before it did.
 */
export interface AutoResumeInput {
  record: Pick<RunRecord, 'state'> & { autoResumes?: number; stoppedByUser?: boolean };
  /** Whether a session for this chat is live in THIS worker right now. */
  live: boolean;
  /** Whether this build should auto-resume at all. False on Chrome. */
  safari: boolean;
}

/**
 * Should this chat's stopped-short run be picked up automatically?
 *
 * Every clause is a way this could go wrong, and each is here because the alternative is worse than
 * a Resume button:
 *
 *   - **not Safari** — Chrome's worker eviction is rare and its keepalive is documented and works.
 *     The owner asked about Safari, and silently restarting model calls on Chrome is a behaviour
 *     change nobody asked for.
 *   - **a live session** — the run is going in this worker. Resuming it would run the same
 *     conversation twice, against the same chat, which is the one thing this must never do.
 *   - **'running'** — a record still marked running has not been through markInterrupted yet, so
 *     nothing has established that it is dead. recoverRuns settles that first, and this reads the
 *     settled record.
 *   - **'failed'** — the provider gave an answer and it was a bad one (no key, a 400, out of
 *     retries). Sending exactly the same thing again would fail exactly the same way; that is what
 *     the button and the error text are for.
 *   - **stopped by the user** — Stop means stop. This is the clause the owner would notice.
 *   - **out of attempts** — see MAX_AUTO_RESUMES.
 *
 * What is left is precisely the case the owner described: a run that was going, that the user did
 * not stop, that died with a worker Safari suspended.
 */
export function shouldAutoResume({ record, live, safari }: AutoResumeInput): boolean {
  if (!safari) return false;
  if (live) return false;
  if (record.state !== 'interrupted') return false;
  if (record.stoppedByUser) return false;
  return (record.autoResumes ?? 0) < MAX_AUTO_RESUMES;
}

/**
 * The chats to resume automatically, given the whole runs map.
 *
 * Sorted by when the run started, so the order is the order the user began them rather than
 * whatever order the storage object happens to enumerate in.
 */
export function autoResumable(runs: RunMap, isLive: (chatId: string) => boolean, safari: boolean): string[] {
  return Object.entries(runs)
    .filter(([id, rec]) => shouldAutoResume({ record: rec, live: isLive(id), safari }))
    .sort((a, b) => (a[1].startedAt || 0) - (b[1].startedAt || 0))
    .map(([id]) => id);
}

/** Record that a chat is being resumed automatically: the attempt is spent whether or not it works. */
export function countAutoResume(runs: RunMap, chatId: string): RunMap {
  const prev = runs[chatId];
  if (!prev) return runs;
  return { ...runs, [chatId]: { ...prev, autoResumes: (prev.autoResumes ?? 0) + 1 } };
}
