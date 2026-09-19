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

/**
 * A wait_for that is running is silent BY DESIGN, so silence during one means nothing is wrong.
 *
 * Every other phase reports progress: the model streams text, a tool answers in milliseconds. A
 * wait deliberately produces no events until its condition is true or its timeout is reached, and
 * its timeout can be 20s — well past STILL_WAITING_MS and, with a couple of long waits in a row,
 * within sight of STALL_MS. Applying the ordinary thresholds to it would put "the provider may be
 * stuck" on screen for a tool doing exactly what it was asked to do, which is worse than saying
 * nothing: it teaches the user to distrust the one line that is supposed to be trustworthy.
 *
 * So a wait gets its own, much later threshold. It is not infinite — a wait that outruns the
 * longest timeout the tool permits, plus the round trips around it, really has hung — but it is
 * far beyond any legitimate wait.
 */
export const WAIT_STALL_MS = 45_000;

/** The tool whose silence is its normal behaviour. */
const WAIT_TOOL = 'wait_for';

/**
 * How lib/agent/wait.ts phrases a wait's detail. The label splits on it so the condition lands in
 * the mono identifier slot; the two must stay in step, which is what test/activity.test.ts pins.
 */
const WAIT_PREFIX = 'waiting for ';

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
  /**
   * The model request failed and the loop is waiting to make it again (lib/agent/retry.ts).
   * `remainingMs` is how much of that wait is left, computed by the panel from the event's `until`.
   */
  retry?: { reason: RetryReason; attempt: number; max: number; remainingMs: number; status?: number };
}

/** Why the request is being retried, as the loop reports it. 'offline' spends no attempt. */
export type RetryReason = 'network' | 'stream' | 'rate_limit' | 'overloaded' | 'server' | 'offline';

/**
 * What went wrong, in the line's own voice: short, lower case, no blame. A dropped stream and a
 * connection that never opened are the same thing to the person watching, so they share a label.
 */
export function retryLabel(reason: RetryReason, status?: number): string {
  switch (reason) {
    case 'network':
    case 'stream':
      return 'connection lost';
    case 'rate_limit':
      return 'rate limited by the provider';
    case 'overloaded':
      return 'the provider is overloaded';
    case 'server':
      return status ? `the provider returned ${status}` : 'the provider returned an error';
    case 'offline':
      return 'you are offline';
  }
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
  /**
   * Render `label` BEFORE `mono` rather than after it. Only a wait uses this: its prose comes
   * first and its identifier second ("waiting for .result"), which is the opposite of every other
   * tool line, where the tool name leads ("find_elements #login").
   */
  labelFirst?: boolean;
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
function toolLabel(state: ActivityState): { label: string; mono: string; monoJoin: Activity['monoJoin']; labelFirst?: boolean } {
  const name = state.tool ?? 'tool';
  const detail = state.detail?.trim();
  if (!detail) return { label: '', mono: name, monoJoin: ' ' };

  // A wait is the one tool whose detail is a sentence WITH an identifier inside it: "waiting for
  // .result". The prose belongs in the label and the thing being waited for belongs in the mono
  // run, so the line reads "waiting for .result · 3s" with the selector in the identifier font —
  // which is what makes a 15s pause legible at a glance rather than a wall of grey text.
  const waitedFor = detail.startsWith(WAIT_PREFIX) ? detail.slice(WAIT_PREFIX.length).trim() : null;
  if (waitedFor) return { label: WAIT_PREFIX.trim(), mono: waitedFor, monoJoin: ' ', labelFirst: true };

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

  // A retry in progress is the whole story while it lasts: what went wrong, when the next attempt
  // is, and which one it will be. It takes the warning colour and offers Stop, because a user who
  // knows the network is gone should not have to sit through five attempts to say so. It is also
  // exempt from the stall rule below — a 60 second Retry-After is silence by arrangement.
  if (state.retry) {
    const r = state.retry;
    if (r.reason === 'offline') {
      segments.push('waiting for the connection to come back');
    } else {
      const secs = Math.ceil(r.remainingMs / 1000);
      segments.push(secs > 0 ? `retrying in ${secs}s` : 'retrying now', `attempt ${r.attempt} of ${r.max}`);
    }
    if (state.queued) segments.push(`${state.queued} queued`);
    return { tone: 'warn', label: retryLabel(r.reason, r.status), monoJoin: ' ', segments, action: 'stop', pulse: false };
  }

  // A wait that is legitimately in progress is held to its own, later threshold (WAIT_STALL_MS).
  const waiting = state.phase === 'tool' && state.tool === WAIT_TOOL;
  const stalled = state.sinceLastEvent >= (waiting ? WAIT_STALL_MS : STALL_MS);
  const slow = !stalled && state.phase === 'model' && !state.writing && state.sinceLastEvent >= STILL_WAITING_MS;

  let tone: Activity['tone'] = 'live';
  let label: string;
  let mono: string | undefined;
  let monoJoin: Activity['monoJoin'] = ' ';
  let labelFirst = false;
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
    labelFirst = !!t.labelFirst;
  }

  // Elapsed always rides along, except on the stall line, which already names its own duration.
  if (!stalled) segments.push(formatElapsed(state.elapsed));
  if ((state.iteration ?? 1) > 1) segments.push(`step ${state.iteration}`);
  if (state.queued) segments.push(`${state.queued} queued`);

  return { tone, label, mono, monoJoin, segments, action, pulse: !stalled, ...(labelFirst ? { labelFirst } : {}) };
}

/** The whole line as one string, for tests and for the accessible label. */
export function activityText(a: Activity): string {
  const head = (a.labelFirst ? [a.label, a.mono] : [a.mono, a.label]).filter(Boolean).join(a.monoJoin);
  return [head, ...a.segments].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// The per-chat layer: which chat's run each event belongs to.
//
// Runs are keyed by chat (lib/sessions.ts), several can be in flight at once, and one panel port
// carries all of their events. So "what is the run doing" is a question about a CHAT, never about
// the panel — exactly as `busy` and the transcript are. A single activity object would have shown
// chat A's tool call to someone reading chat B, and would have gone blank the moment A finished
// while B was still working. These two reducers are what keeps each chat's line its own; they live
// here rather than in Chat.tsx so the routing can be tested without a browser.
// ---------------------------------------------------------------------------

/** What the panel records about one chat's run. The clock deltas are computed at render time. */
export interface ChatActivity {
  phase: Phase;
  tool?: string;
  detail?: string;
  iteration?: number;
  /** When this chat's run started, as Date.now(). */
  startedAt: number | null;
  /** …and when its last event of any kind arrived. Silence here is what a stall is. */
  lastEventAt: number | null;
  /** True once the model has streamed text in this model phase. */
  writing?: boolean;
  /** Messages sent into this chat that have not entered its conversation yet. */
  queued: number;
  /** The port went away while this chat was mid-run. */
  disconnected?: boolean;
  /** The model request is being retried; `until` is when the next attempt starts (Date.now()). */
  retry?: { reason: RetryReason; attempt: number; max: number; until: number; status?: number };
}

/** A chat with nothing to say. Also what an unknown chat reads as, so lookups need no null check. */
export const IDLE_ACTIVITY: ChatActivity = { phase: 'idle', startedAt: null, lastEventAt: null, queued: 0 };

/** The shape of a port event this layer cares about. Structurally satisfied by AgentEvent. */
type ActivityEvent =
  | { type: 'status'; phase: Phase; tool?: string; detail?: string; iteration?: number; retry?: ChatActivity['retry'] }
  | { type: 'text' }
  | { type: 'text_discard' }
  | { type: 'accepted' }
  | { type: 'unqueued' }
  | { type: 'done' }
  | { type: 'error' }
  | { type: 'chat_title' }
  | { type: string };

/**
 * Fold one event into ONE chat's activity. Two things matter: every event of the run refreshes
 * lastEventAt (silence is the stall signal), and the first text delta of a model phase flips
 * "waiting for model" to "writing". `now` is injected so the thresholds are testable.
 */
export function activityFromEvent(a: ChatActivity, e: ActivityEvent, now: number = Date.now()): ChatActivity {
  switch (e.type) {
    case 'status': {
      const s = e as Extract<ActivityEvent, { type: 'status' }>;
      if (s.phase === 'idle') return IDLE_ACTIVITY;
      return {
        ...a,
        phase: s.phase,
        tool: s.tool,
        detail: s.detail,
        iteration: s.iteration,
        startedAt: a.startedAt ?? now,
        lastEventAt: now,
        // A new phase has not written anything yet.
        writing: false,
        disconnected: false,
        // Set explicitly, never inherited: the ordinary status event that follows a retry wait
        // carries no `retry`, and that absence is what puts the line back to normal.
        retry: s.retry,
      };
    }
    case 'text':
      return { ...a, lastEventAt: now, writing: a.phase === 'model' ? true : a.writing, retry: undefined };
    case 'text_discard':
      // The attempt that was writing has failed; whatever comes next starts from "waiting" again.
      return { ...a, lastEventAt: now, writing: false };
    case 'accepted':
    case 'unqueued':
      return { ...a, lastEventAt: now, queued: Math.max(0, a.queued - 1) };
    case 'done':
    case 'error':
    // Running out of steps ends the run as surely as finishing it does. The transcript's note is
    // what explains it from here on, so the live line must not stay up as if work were continuing.
    case 'stopped':
      return IDLE_ACTIVITY;
    case 'chat_title':
      // A rename arrives AFTER 'done', from the tool-free naming call. It is not the run, so it
      // neither revives a finished line nor counts as proof of life for one still going.
      return a;
    default:
      return { ...a, lastEventAt: now };
  }
}

/**
 * Apply an update to one chat's entry in the panel's map. An entry that comes out idle is dropped
 * rather than kept as an idle row, so the map holds only chats with something to say and a chat
 * that finished leaves nothing behind for the next one to inherit. Returns the same map when
 * nothing changed, so React can skip the render.
 */
export function withActivity(
  map: ReadonlyMap<string, ChatActivity>,
  id: string,
  fn: (prev: ChatActivity) => ChatActivity,
): ReadonlyMap<string, ChatActivity> {
  const prev = map.get(id) ?? IDLE_ACTIVITY;
  const updated = fn(prev);
  if (updated === prev) return map;
  // A disconnected line is kept even though its phase reads idle: it is still saying something.
  if (updated.phase === 'idle' && !updated.disconnected) return withoutActivity(map, id);
  const next = new Map(map);
  next.set(id, updated);
  return next;
}

/** One chat's entry removed, or the same map when it had none. */
export function withoutActivity(map: ReadonlyMap<string, ChatActivity>, id: string): ReadonlyMap<string, ChatActivity> {
  if (!map.has(id)) return map;
  const next = new Map(map);
  next.delete(id);
  return next;
}

/**
 * Every mid-run chat marked as having lost its connection. The port is the panel's only link to all
 * of them at once, so when it dies they all did — each then offers its own Retry.
 */
export function allDisconnected(map: ReadonlyMap<string, ChatActivity>): ReadonlyMap<string, ChatActivity> {
  let next: Map<string, ChatActivity> | null = null;
  for (const [id, a] of map) {
    if (a.phase === 'idle' || a.disconnected) continue;
    next ??= new Map(map);
    next.set(id, { ...a, disconnected: true });
  }
  return next ?? map;
}
