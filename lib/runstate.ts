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
}

export type RunMap = Record<string, RunRecord>;

/** What the panel needs to offer Resume for a chat. */
export interface ResumableRun {
  state: 'failed' | 'interrupted';
  error?: string;
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
    out[id] = { state: rec.state, ...(rec.error ? { error: rec.error } : {}) };
  }
  return out;
}

/** Whatever is stored under RUNS_KEY, with anything malformed dropped. */
export function parseRuns(raw: unknown): RunMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: RunMap = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const r = v as Partial<RunRecord> | null;
    if (!r || (r.state !== 'running' && r.state !== 'failed' && r.state !== 'interrupted')) continue;
    out[id] = {
      state: r.state,
      tabId: typeof r.tabId === 'number' ? r.tabId : -1,
      startedAt: typeof r.startedAt === 'number' ? r.startedAt : 0,
      updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : 0,
      ...(typeof r.error === 'string' && r.error ? { error: r.error } : {}),
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
