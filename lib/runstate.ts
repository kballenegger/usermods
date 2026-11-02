// Which chats have a run in flight, and which have one that stopped short.
//
// Sessions live in the service worker's memory (lib/sessions.ts), and an MV3 worker's memory is not
// a place to keep a promise: Chrome evicts it, the browser quits, the extension reloads. Before this
// record existed, any of those mid-run meant the conversation simply stopped, with nothing anywhere
// saying a run had been going — the panel showed a transcript that ended mid-step and the only way
// forward was to type the prompt again.
//
// So the fact that a run is in flight is written down, in one small storage key, before the run
// does anything else. Three states:
//
//   running      a run is in flight. If the worker starts up and finds this with no live session
//                behind it, the run died with the previous worker: it becomes 'interrupted'.
//   failed       the model request failed for good (not retryable, or out of retries).
//   interrupted  the run died with its worker.
//
// 'failed' and 'interrupted' both mean the same thing to the user: the conversation is saved up to
// the last completed step (the loop checkpoints it; see AgentInput.onCheckpoint), and Resume carries
// on from there. Finishing, Stop and a new message all clear the record.
//
// It is one key holding a map rather than a key per chat, because the question asked at worker
// start is "which chats, of all of them?", and answering that from per-chat keys would mean reading
// the whole of storage, attached images included.
//
// The pure half of this is tested in test/runstate.test.ts; the storage half is three lines.

import { ACT_OFF } from './buildflags.ts';

export const RUNS_KEY = 'runs';

export type RunState = 'running' | 'failed' | 'interrupted';

export interface RunRecord {
  state: RunState;
  /** The tab the run was driving, so a resume can default to it. */
  tabId: number;
  startedAt: number;
  updatedAt: number;
  /** Why it failed, in the provider's words. Only on 'failed'. */
  error?: string;
  /**
   * The run ended because the user pressed Stop.
   *
   * Recorded so that the Safari auto-resume (lib/keepalive.ts) can tell "Safari took this away"
   * from "the user ended it". It has to be on the STORED record rather than in worker memory,
   * because the decision is made by a worker that was not there when Stop was pressed.
   */
  stoppedByUser?: boolean;
  /**
   * How many times this run has picked itself up automatically. See MAX_AUTO_RESUMES.
   *
   * Bounded and written down for the same reason: a worker that has just started has no other way
   * to know it is about to do this for the second time.
   */
  autoResumes?: number;
  /** The step in flight, if any. See PendingStep. */
  pending?: PendingStep;
  /** This run is a skill's, with no model in it: a resume carries on through lib/skillrun.ts. */
  skill?: RunSkill;
}

/** Which skill a run is, and which step it is on. `key` says whether the file is still the one it started on. */
export interface RunSkill {
  id: string;
  name: string;
  step: number;
  total: number;
  key: string;
  /** A draft in the chat, which has no record to look up. */
  draft?: boolean;
}

export type RunMap = Record<string, RunRecord>;

/**
 * A step that may or may not have happened: an action or a script, written down before it runs and
 * cleared with its result.
 *
 * A checkpoint is written after a step's result is in. If the worker dies between the two, the resumed
 * conversation has no trace of the step, the model does it again, and for a submit that is a double
 * submit. So this is the journal of the one step in flight, and the rule that goes with it is that
 * nothing replays it: a resume tells the model it may have happened and to look first, a skill's run
 * card asks the user, and Safari's automatic resume does not fire at all (lib/keepalive.ts).
 *
 * `label` is what the extension read ("click button \"Place order\""). It never holds what a field
 * was filled with.
 */
export interface PendingStep {
  /** `skill-start` and `skill-repair` are not a step of the file, so an answer about them settles no step of it. */
  kind: 'act' | 'script' | 'skill' | 'skill-start' | 'skill-repair';
  label: string;
  at: number;
}

/** What the Resume block says when the record holds a pending step. */
export function pendingResumeText(step: Pick<PendingStep, 'label'>, skill?: boolean): string {
  return `The last action may or may not have happened: ${step.label}. ${skill ? 'usermods will ask you before going on.' : 'usermods will look at the page before doing anything else.'}`;
}

/** Say which skill this run is. */
export function withRunSkill(runs: RunMap, chatId: string, skill: RunSkill, now: number = Date.now()): RunMap {
  const prev = runs[chatId];
  if (!prev) return runs;
  return { ...runs, [chatId]: { ...prev, skill, updatedAt: now } };
}

/** A skill the model started has ended, and the model's own run carries on. */
export function withoutRunSkill(runs: RunMap, chatId: string, now: number = Date.now()): RunMap {
  const prev = runs[chatId];
  if (!prev?.skill) return runs;
  const { skill: _skill, ...rest } = prev;
  return { ...runs, [chatId]: { ...rest, updatedAt: now } };
}

/** Move a skill's run to this step. Nothing changes for a record that is not a skill's. */
export function withSkillStep(runs: RunMap, chatId: string, step: number, now: number = Date.now()): RunMap {
  const prev = runs[chatId];
  if (!prev?.skill || prev.skill.step === step) return runs;
  return { ...runs, [chatId]: { ...prev, skill: { ...prev.skill, step }, updatedAt: now } };
}

/** Write the step down, before it runs. */
export function withPending(runs: RunMap, chatId: string, step: Omit<PendingStep, 'at'>, now: number = Date.now()): RunMap {
  const prev = runs[chatId];
  if (!prev) return runs;
  return { ...runs, [chatId]: { ...prev, pending: { ...step, at: now }, updatedAt: now } };
}

/** Clear it, with its result. Returns the same map when there was nothing to clear. */
export function withoutPending(runs: RunMap, chatId: string, now: number = Date.now()): RunMap {
  const prev = runs[chatId];
  if (!prev?.pending) return runs;
  const { pending: _pending, ...rest } = prev;
  return { ...runs, [chatId]: { ...rest, updatedAt: now } };
}

/**
 * The record a state change leaves. The pending step and the count of automatic resumes outlive it:
 * a run that fails or restarts has not answered whether the step happened, and a resumed run writes
 * 'running' over the record that says it has already had its one automatic pickup.
 */
export function nextRunRecord(prev: RunRecord | undefined, patch: Pick<RunRecord, 'state' | 'tabId'> & { error?: string }, now: number = Date.now()): RunRecord {
  const startedAt = patch.state === 'running' || !prev ? now : prev.startedAt;
  return {
    state: patch.state,
    tabId: patch.tabId,
    startedAt,
    updatedAt: now,
    ...(patch.error ? { error: patch.error } : {}),
    ...(prev?.pending ? { pending: prev.pending } : {}),
    ...(prev?.autoResumes ? { autoResumes: prev.autoResumes } : {}),
  };
}

/** What the panel needs to offer Resume for a chat. */
export interface ResumableRun {
  state: 'failed' | 'interrupted';
  error?: string;
  /**
   * This run has already picked itself up automatically at least once (Safari; lib/keepalive.ts).
   *
   * The panel uses it for the one thing the user sees differently: a run that came back by itself
   * says so, and a run that came back and then stopped AGAIN gets the ordinary Resume button, since
   * its one automatic attempt is spent.
   */
  autoResumed?: boolean;
  /** What may or may not have happened, for the Resume block to say. */
  pending?: PendingStep;
  /** The run was a skill's. */
  skill?: RunSkill;
}

/** What the panel shows when a run died with its worker. */
export const INTERRUPTED_TEXT = 'This run was interrupted.';

/** The button. One word, one place, so the panel and the smoke flow cannot drift apart. */
export const RESUME_LABEL = 'Resume';

/** What sits beside the button, under whatever went wrong. */
export const RESUME_HINT = 'Your progress is saved. Resume carries on from the last completed step, without sending your message again.';

/**
 * Turn every 'running' record with no live session behind it into 'interrupted'.
 *
 * `isLive` is asked rather than assumed, so this is safe to call at any time and not only at worker
 * start: a run that really is in flight in this worker is left alone. Returns the same map when
 * nothing changed, so the caller can skip the write.
 */
export function markInterrupted(runs: RunMap, isLive: (chatId: string) => boolean, now: number = Date.now()): { runs: RunMap; interrupted: string[] } {
  const interrupted: string[] = [];
  let next: RunMap | null = null;
  for (const [id, rec] of Object.entries(runs)) {
    if (rec.state !== 'running' || isLive(id)) continue;
    next ??= { ...runs };
    next[id] = { ...rec, state: 'interrupted', updatedAt: now };
    interrupted.push(id);
  }
  return { runs: next ?? runs, interrupted };
}

/** Drop records whose chat no longer exists (deleted, or evicted by the MAX_CHATS cap). */
export function pruneRuns(runs: RunMap, existing: ReadonlySet<string>): RunMap {
  const gone = Object.keys(runs).filter((id) => !existing.has(id));
  if (!gone.length) return runs;
  const next = { ...runs };
  for (const id of gone) delete next[id];
  return next;
}

/** The chats that can be resumed, as the panel wants them. */
export function resumableRuns(runs: RunMap): Record<string, ResumableRun> {
  const out: Record<string, ResumableRun> = {};
  for (const [id, rec] of Object.entries(runs)) {
    if (rec.state === 'running') continue;
    out[id] = { state: rec.state, ...(rec.error ? { error: rec.error } : {}), ...(rec.autoResumes ? { autoResumed: true } : {}), ...(rec.pending ? { pending: rec.pending } : {}), ...(!ACT_OFF && rec.skill ? { skill: rec.skill } : {}) };
  }
  return out;
}

/**
 * A stored pending step. Anything present but unreadable still counts as a step in flight, because
 * reading it as "none" would be the unsafe direction: it would let a resume replay it.
 */
function parsePending(raw: unknown): PendingStep | undefined {
  if (raw === undefined || raw === null) return undefined;
  const p = raw as Partial<PendingStep>;
  return {
    kind: p.kind === 'script' || (!ACT_OFF && (p.kind === 'skill' || p.kind === 'skill-start' || p.kind === 'skill-repair')) ? p.kind : 'act',
    label: typeof p.label === 'string' && p.label ? p.label : 'an action',
    at: typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : 0,
  };
}

/** A stored skill reference. A malformed one reads as none: the run then resumes as a chat, which asks nothing of it. */
function parseRunSkill(raw: unknown): RunSkill | undefined {
  const r = raw as Partial<RunSkill> | null | undefined;
  if (!r || typeof r.id !== 'string' || typeof r.step !== 'number' || typeof r.total !== 'number' || typeof r.key !== 'string') return undefined;
  return { id: r.id, name: typeof r.name === 'string' ? r.name : '', step: r.step, total: r.total, key: r.key, ...(r.draft === true ? { draft: true } : {}) };
}

/** Whatever is stored under RUNS_KEY, with anything malformed dropped. */
export function parseRuns(raw: unknown): RunMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: RunMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<RunRecord> | null;
    if (!r || (r.state !== 'running' && r.state !== 'failed' && r.state !== 'interrupted')) continue;
    const pending = parsePending(r.pending);
    const skill = ACT_OFF ? undefined : parseRunSkill(r.skill);
    out[id] = {
      state: r.state,
      tabId: typeof r.tabId === 'number' ? r.tabId : -1,
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
      ...(r.stoppedByUser === true ? { stoppedByUser: true } : {}),
      // A count that is not a whole number is a count nothing wrote: it reads as none, which is the
      // safe direction — the bound is then checked against a real number rather than against NaN,
      // which would make every comparison false and let a run resume itself forever.
      ...(typeof r.autoResumes === 'number' && Number.isFinite(r.autoResumes) && r.autoResumes > 0
        ? { autoResumes: Math.floor(r.autoResumes) }
        : {}),
      ...(pending ? { pending } : {}),
      ...(skill ? { skill } : {}),
    };
  }
  return out;
}

export async function loadRuns(): Promise<RunMap> {
  const r = await chrome.storage.local.get(RUNS_KEY);
  return parseRuns(r[RUNS_KEY]);
}

export async function saveRuns(runs: RunMap): Promise<void> {
  await chrome.storage.local.set({ [RUNS_KEY]: runs });
}
