// The "is it stuck?" line. Pure: given what the panel knows about the run, decide what the one
// live status line says, what colour it is, and whether it offers an action.
//
// The panel owns the clock and the port; this module owns the wording and the thresholds, so the
// whole behaviour is testable without a browser (test/activity.test.ts).

/**
 * A model call that has produced nothing for this long is described as "still waiting". Thinking
 * models legitimately spend this long before their first byte, so this is a reassurance, not an
 * error: same colour, longer sentence.
 */
export const STILL_WAITING_MS = 20_000;

/**
 * Silence this long is worth worrying about out loud: the line turns the warning colour, says the
 * provider may be stuck, and offers Stop. Still not an error — the run may yet produce something.
 */
export const STALL_MS = 90_000;

/** How often the panel re-renders the line so the elapsed timer ticks. */
export const TICK_MS = 1000;

/** What the agent is doing right now, as reported by the background over the port. */
export type Phase = 'model' | 'tool' | 'idle';

/** Everything the label depends on. Times are milliseconds. */
export interface ActivityState {
  phase: Phase;
  /** Tool name for phase 'tool', e.g. 'run_script'. */
  tool?: string;
  /** Human detail: the tool's description, a selector, or 'waiting for model' / 'continuing'. */
  detail?: string;
  /** Agent-loop iteration, 1-based. Shown as "step N" once past the first. */
  iteration?: number;
  /** Since the run started (or since this phase began, whichever the panel feeds in). */
  elapsed: number;
  /** Since the LAST event of any kind arrived from the port. This is what detects a stall. */
  sinceLastEvent: number;
  /** True once the model has streamed text in this model phase: waiting has become writing. */
  writing?: boolean;
  /** Messages the user sent that have not entered the conversation yet. */
  queued?: number;
  /** The port went away mid-run: the service worker died under us. */
  disconnected?: boolean;
}

/** What the component renders. `segments` join with " · ". */
export interface Activity {
  /** Drives the dot and text colour. */
  tone: 'live' | 'warn' | 'error';
  /** The phase label, e.g. 'waiting for model'. */
  label: string;
  /** Identifier-ish part of the label, rendered in the mono font (a tool name, or tool + selector). */
  mono?: string;
  /**
   * How `mono` and `label` join. A selector belongs to the tool that is reading it, so the two read
   * as one identifier: "find_elements #loginContainer". A prose description is its own clause, so it
   * gets the interpunct: "run_script · hide the login modal".
   */
  monoJoin: ' ' | ' · ';
  /** Everything after the label: elapsed, step count, queued count. Already formatted. */
  segments: string[];
  /** An inline action the line offers, if any. */
  action?: 'stop' | 'retry';
  /** True while the dot should pulse. A stalled or disconnected line holds still. */
  pulse: boolean;
}

/** "4s", "1m 04s". Seconds only below a minute, which is where this line spends its life. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
}

/** A detail that is a CSS selector rather than a sentence, so it reads as part of the identifier. */
function looksLikeSelector(detail: string): boolean {
  return !/\s/.test(detail) && /^[.#[:*a-zA-Z]/.test(detail);
}

/**
 * The tool phase's readable half: the tool's own name in mono, plus whatever the loop passed as a
 * human description (the script's `description`, or the selector it is about to query). A selector
 * joins the name inside the mono run; a description stands apart after an interpunct.
 */
function toolLabel(state: ActivityState): { label: string; mono: string; monoJoin: Activity['monoJoin'] } {
  const name = state.tool ?? 'tool';
  const detail = state.detail?.trim();
  if (!detail) return { label: '', mono: name, monoJoin: ' ' };
  if (looksLikeSelector(detail)) return { label: '', mono: `${name} ${detail}`, monoJoin: ' ' };
  return { label: detail, mono: name, monoJoin: ' · ' };
}

/**
 * Decide the whole line. Returns null when there is nothing to say — an idle run, which is how the
 * indicator disappears the instant the run ends.
 */
export function activityFor(state: ActivityState): Activity | null {
  const segments: string[] = [];

  // A dead port beats everything: nothing else the panel knows is true any more.
  if (state.disconnected) {
    return {
      tone: 'error',
      label: 'connection to the background worker was lost',
      monoJoin: ' ',
      segments,
      action: 'retry',
      pulse: false,
    };
  }

  if (state.phase === 'idle') return null;

  const stalled = state.sinceLastEvent >= STALL_MS;
  const slow = !stalled && state.phase === 'model' && !state.writing && state.sinceLastEvent >= STILL_WAITING_MS;

  let tone: Activity['tone'] = 'live';
  let label: string;
  let mono: string | undefined;
  let monoJoin: Activity['monoJoin'] = ' ';
  let action: Activity['action'];

  if (stalled) {
    tone = 'warn';
    label = `no response for ${Math.floor(state.sinceLastEvent / 1000)}s · the provider may be stuck`;
    action = 'stop';
  } else if (state.phase === 'model') {
    if (state.writing) label = 'writing';
    else if (slow) label = 'still waiting for model';
    else label = state.detail?.trim() || 'waiting for model';
  } else {
    const t = toolLabel(state);
    label = t.label;
    mono = t.mono;
    monoJoin = t.monoJoin;
  }

  // Elapsed always rides along, except on the stall line, which already names its own duration.
  if (!stalled) segments.push(formatElapsed(state.elapsed));
  if ((state.iteration ?? 1) > 1) segments.push(`step ${state.iteration}`);
  if (state.queued) segments.push(`${state.queued} queued`);

  return { tone, label, mono, monoJoin, segments, action, pulse: !stalled };
}

/** The whole line as one string, for tests and for the accessible label. */
export function activityText(a: Activity): string {
  const head = [a.mono, a.label].filter(Boolean).join(a.monoJoin);
  return [head, ...a.segments].filter(Boolean).join(' · ');
}
