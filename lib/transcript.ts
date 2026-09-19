// The side-panel transcript, as a pure reduction over agent events.
//
// This lives outside Chat.tsx because the panel has to apply the same reduction twice: once into
// React state for the chat the user is looking at, and once over the STORED items of a chat that
// is running in another tab. A run in chat A must keep filling in A's transcript while the user
// reads chat B, and neither may leak into the other — so the rule for "what does this event do to
// a transcript" has exactly one implementation, and it takes the items it edits as an argument.
// The .ts extension is load-bearing: this is a VALUE import (every other lib-to-lib import here is
// `import type`, which is erased), and `npm test` runs these files through node --experimental-
// strip-types, whose ESM resolver does not guess extensions. tsconfig sets
// allowImportingTsExtensions, so tsc and vite both take it as written.
import { parseWaitInput, waitConditionLabel } from './agent/wait.ts';
import type { AgentEventBody, ChatItem } from './types';

type ModelItem = Extract<ChatItem, { kind: 'model' }>;

/** The model the end of a transcript was produced by, or null when nothing recorded one. */
export function lastModel(items: ChatItem[]): ModelItem | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it?.kind === 'model') return it;
  }
  return null;
}

/**
 * What a model row says, or null when it should say nothing.
 *
 * The first one in a transcript is where the chat STARTED, not a change, so the panel shows nothing
 * for it (`showFirst: false`) — the composer already names the model. Every later one is a swap and
 * reads "switched to …". The dashboard's read-only preview has no composer to name the model, so it
 * shows the first one too.
 */
export function modelRowText(items: ChatItem[], index: number, { showFirst = false } = {}): string | null {
  const it = items[index];
  if (it?.kind !== 'model') return null;
  const name = it.label ? `${it.model} · ${it.label}` : it.model;
  const first = !items.slice(0, index).some((x) => x.kind === 'model');
  if (first) return showFirst ? `model: ${name}` : null;
  return `switched to ${name}`;
}

/**
 * Apply one agent event to a transcript. Returns a new array (never mutates the input), or the
 * same array when the event changes nothing, so a caller can skip a write.
 *
 * `unqueued` is only half-handled here: this drops the queued bubble, and the caller decides what
 * to do with the text it was carrying (put it back in the composer when that chat is visible,
 * drop it otherwise). Use `unqueuedItem` to read the bubble before reducing.
 */
export function reduceItems(items: ChatItem[], event: AgentEventBody): ChatItem[] {
  switch (event.type) {
    case 'text': {
      const last = items[items.length - 1];
      if (last?.kind === 'assistant') {
        const next = items.slice();
        next[next.length - 1] = { ...last, text: last.text + event.delta };
        return next;
      }
      return [...items, { kind: 'assistant', text: event.delta }];
    }
    case 'text_discard': {
      // The attempt that streamed this text failed and is being made again. What it wrote never
      // became part of the conversation, so it comes back off the transcript: `chars` from the end
      // of the LAST assistant row, which is the row those deltas were appended to. Counting
      // characters rather than dropping the row is what keeps this exact when a queued bubble has
      // landed after it, and harmless when a reconnecting panel saw only part of the stream (it
      // removes no more than the row holds).
      if (event.chars <= 0) return items;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it?.kind !== 'assistant') {
          // A tool row or a proposal means the text before it belongs to a reply that completed.
          if (it?.kind === 'tool' || it?.kind === 'proposal') return items;
          continue;
        }
        const kept = it.text.slice(0, Math.max(0, it.text.length - event.chars));
        const next = items.slice();
        if (kept) next[i] = { ...it, text: kept };
        else next.splice(i, 1);
        return next;
      }
      return items;
    }
    case 'tool_call':
      return [...items, { kind: 'tool', id: event.id, name: event.name, input: event.input }];
    case 'tool_result': {
      const i = items.findIndex((x) => x.kind === 'tool' && x.id === event.id);
      if (i < 0) return items;
      const next = items.slice();
      next[i] = { ...(next[i] as Extract<ChatItem, { kind: 'tool' }>), summary: event.summary, isError: event.isError };
      return next;
    }
    case 'proposal':
      return [...items, { kind: 'proposal', proposal: event.proposal }];
    case 'artifact': {
      // The version the proposal just became. It arrives immediately after its 'proposal' event,
      // from the same tool call, so it stamps the LAST proposal row — which is the one the loop
      // just emitted. Stamping by position rather than by matching the code is deliberate: two
      // identical proposals in one chat are two rows and the second one is the one that just
      // happened, and comparing code would put the number on the first.
      //
      // A transcript with no proposal row to stamp (one restored from before drafts existed, or a
      // reconnect that missed the proposal) is left exactly as it is: the card simply carries no
      // version and offers its old Save, which is the honest fallback.
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it?.kind !== 'proposal') continue;
        // Already stamped with this number: the event is a duplicate, not a second proposal, so
        // nothing changes. (The de-duped re-proposal case — the model proposing the same script
        // twice, which addVersion collapses — arrives as a row with NO version, and is stamped with
        // the version it de-duped into, which is the truthful answer to "which version is this
        // card?".)
        if (it.version === event.version) return items;
        const next = items.slice();
        next[i] = { ...it, version: event.version };
        return next;
      }
      return items;
    }
    case 'accepted': {
      // The message has entered the model conversation, so it is no longer merely queued.
      if (!items.some((it) => it.kind === 'user' && it.id === event.id && it.queued)) return items;
      return items.map((it) => (it.kind === 'user' && it.id === event.id ? { ...it, queued: false } : it));
    }
    case 'unqueued': {
      // The run was stopped before this message was sent: its bubble goes away.
      if (!items.some((it) => it.kind === 'user' && it.id === event.id)) return items;
      return items.filter((it) => !(it.kind === 'user' && it.id === event.id));
    }
    case 'model': {
      // Recorded when it CHANGES. The same array comes back for a run on the model the chat was
      // already on, so an unchanged chat gains no rows and an offscreen one schedules no write.
      const last = lastModel(items);
      if (last && last.connectionId === event.connectionId && last.model === event.model) return items;
      return [...items, { kind: 'model', connectionId: event.connectionId, label: event.label, model: event.model }];
    }
    case 'status':
      // What the run is doing right now drives the activity line, which is not a transcript row:
      // it says nothing that is worth reading back tomorrow. Returning the SAME array matters as
      // much as producing no item — status events arrive several times a second during a run, and
      // a new array would schedule a storage write for every one of them, for every offscreen chat.
      return items;
    case 'chat_title':
      // A model-written name renames a row in the switcher, not a message: the transcript is
      // untouched, and returning the same array means an offscreen chat schedules no write for it.
      return items;
    case 'stopped':
      // The step cap, not a failure: the conversation is intact and the next message continues it,
      // so it reads as a muted status line rather than a red error row. Saying nothing here is what
      // made a capped turn look like the agent had silently given up.
      return [...items, { kind: 'note', text: `stopped after ${event.steps} steps · send a message to continue` }];
    case 'compacted':
      return [...items, { kind: 'note', text: compactedNote(event) }];
    case 'note':
      // A fact about the run the user needs but the model did not say. Deduplicated against the
      // row before it, because the same note can be produced by every request in a turn (a
      // text-only endpoint refuses the first image of each one) and a column of identical lines
      // says no more than one of them does.
      return items[items.length - 1]?.kind === 'note' && (items[items.length - 1] as Extract<ChatItem, { kind: 'note' }>).text === event.text
        ? items
        : [...items, { kind: 'note', text: event.text }];
    case 'error':
      return [...items, { kind: 'error', text: event.message }];
    case 'done':
      return items;
  }
}

/**
 * The muted line shown when the model history was compacted. The transcript the user reads is
 * never rewritten — only the history sent to the model shrinks — so this is a note about what the
 * model can still see, not an edit to what the user said.
 */
export function compactedNote(event: Extract<AgentEventBody, { type: 'compacted' }>): string {
  const what = event.tier === 'elided' ? 'earlier tool output trimmed' : 'earlier conversation summarised';
  return `${what} · ${approxTokens(event.before)} → ${approxTokens(event.after)} tokens`;
}

/** 148_231 -> "148k". Small numbers keep their digits, because "0k" reads as a bug. */
function approxTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.max(0, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Tool rows
// ---------------------------------------------------------------------------

/**
 * The title of one tool row: the tool's name plus the one thing worth seeing without opening it.
 *
 * wait_for is the reason this moved out of the two components that render it. What a wait is
 * doing is entirely in its condition — `wait_for .result visible` — and neither `description` nor
 * `selector`, the two fields the old inline expression knew about, holds it. Rather than teach
 * two components the same new rule, both now ask here.
 */
export function toolRowTitle(name: string, input: Record<string, unknown>): string {
  if (name === 'wait_for') {
    const parsed = parseWaitInput(input);
    return parsed.ok ? `${name} ${waitConditionLabel(parsed.spec.condition)}` : name;
  }
  if (typeof input.description === 'string') return `${name}: ${input.description}`;
  if (typeof input.selector === 'string') return `${name} ${input.selector}`;
  return name;
}

/**
 * How a wait's outcome reads as a status: a timeout is `waiting`, not `error`.
 *
 * The distinction is the whole point of the tool. A timeout means the page did not do the thing,
 * which is information, not a failure — and a transcript that paints it coral teaches the user
 * (and, through the summary they read back, the model) that waiting went wrong when it went
 * exactly as designed. Only a wait that could not run at all is an error, and the loop already
 * flags those with `isError`.
 */
export type ToolDotState = 'running' | 'error' | 'waiting' | 'ok';

export function toolDotState(item: Extract<ChatItem, { kind: 'tool' }>): ToolDotState {
  if (item.summary === undefined) return 'running';
  if (item.isError) return 'error';
  if (item.name === 'wait_for' && /^timed out after/i.test(item.summary)) return 'waiting';
  return 'ok';
}

/** The class the dot wears for each state. 'waiting' reuses the amber dot a running row uses. */
export function toolDotClass(state: ToolDotState): string {
  switch (state) {
    case 'running':
    case 'waiting':
      return ' running';
    case 'error':
      return ' error';
    case 'ok':
      return '';
  }
}

/** The queued user bubble an `unqueued` event refers to, so the caller can recover its text. */
export function unqueuedItem(items: ChatItem[], id: string): Extract<ChatItem, { kind: 'user' }> | undefined {
  return items.find((it) => it.kind === 'user' && it.id === id) as Extract<ChatItem, { kind: 'user' }> | undefined;
}

/** What a tool row says when the run it belonged to died before the tool answered. */
export const INTERRUPTED_TOOL_SUMMARY = 'interrupted before it finished';

/**
 * Tidy a transcript whose run was interrupted (the service worker was evicted, the browser quit).
 *
 * Two kinds of row are left claiming something is still happening. A tool row with no result would
 * show its amber "running" dot for ever: it is closed, as an error, saying what happened. The saved
 * conversation never includes that call (a checkpoint is only written once every call in a step has
 * its result), so Resume has the model make it again, in a fresh row. And a message that was still
 * queued never reached the model and its queue died with the worker: its bubble is removed and
 * handed back to the caller, which puts the text back in the composer exactly as Stop does.
 *
 * Returns the same array when there was nothing to tidy.
 */
export function settleInterrupted(items: ChatItem[]): { items: ChatItem[]; dropped: Extract<ChatItem, { kind: 'user' }>[] } {
  if (!looksUnfinished(items)) return { items, dropped: [] };
  const dropped: Extract<ChatItem, { kind: 'user' }>[] = [];
  const next: ChatItem[] = [];
  for (const it of items) {
    if (it.kind === 'user' && it.queued) dropped.push(it);
    else if (it.kind === 'tool' && it.summary === undefined) next.push({ ...it, summary: INTERRUPTED_TOOL_SUMMARY, isError: true });
    else next.push(it);
  }
  return { items: next, dropped };
}

/**
 * The note for a transcript that is missing rows, and what it is careful NOT to say.
 *
 * It used to read "earlier output from this run was not captured", from the days when a run that
 * outlived the panel streamed into nothing. That stopped being true: the background now keeps the
 * transcript itself whenever no panel is attached (recordDetached), an open panel keeps every
 * chat's transcript whether or not it is on screen, the conversation the model sees is
 * checkpointed after every step, and the draft and saved mods never depended on the panel at all.
 * What can still go missing is narrow: ROWS ON SCREEN — a stretch of streamed text, a tool row's
 * result — from the instant between a panel page going away and the background noticing its port
 * had closed. So the note says exactly that, and says what is intact, because "output was not
 * captured" reads as "your work is gone".
 */
export const RECONNECT_NOTE =
  'some rows from this run are not shown here (streamed text or tool results from a moment the panel was reconnecting) · the conversation the model sees, the draft and your saved mods are intact';

/** What a tool row says when its result arrived in such a gap: it ran, and only the row missed it. */
export const GAP_TOOL_SUMMARY = 'result not shown here · the model received it';

/**
 * Whether a stored transcript is really missing rows, as opposed to merely being mid-run.
 *
 * The only evidence of a gap is a row that claims something is still happening when nothing is: a
 * tool row with no result, or a bubble still marked queued. That is a gap ONLY when
 *   - the chat is not running — while it runs, a tool row without a result is a tool that is running
 *     right now, captured the whole time by this panel or by the background; and
 *   - its run was not interrupted — an interrupted run (the worker died) leaves the same rows, but
 *     nothing was streamed that anyone failed to keep: settleInterrupted closes them and the chat
 *     says "This run was interrupted." with Resume, which is the true account of that case.
 * Everything else — a run that finished while the panel was closed, a chat switched away from and
 * back to, a failed run waiting on Resume — has a complete transcript and gets no note.
 */
export function hasRowGap(items: ChatItem[], state: { running: boolean; interrupted: boolean }): boolean {
  return !state.running && !state.interrupted && looksUnfinished(items);
}

/**
 * Put a transcript with a row gap into a truthful state, once: the rows that would otherwise claim
 * to be running for ever are closed (the tool did run and the model did get its result — only this
 * row missed it; a bubble is no longer "queued" when nothing is queued behind anything), and the
 * note is added after them. The result no longer looks unfinished, so this never repeats, and it
 * returns the same array when there is no gap.
 */
export function repairRowGap(items: ChatItem[], state: { running: boolean; interrupted: boolean }): ChatItem[] {
  if (!hasRowGap(items, state)) return items;
  const next: ChatItem[] = items.map((it) => {
    if (it.kind === 'tool' && it.summary === undefined) return { ...it, summary: GAP_TOOL_SUMMARY };
    if (it.kind === 'user' && it.queued) {
      const { queued: _queued, ...rest } = it;
      return rest;
    }
    return it;
  });
  return [...next, { kind: 'note', text: RECONNECT_NOTE }];
}

/**
 * Did this transcript stop mid-turn? A tool row without a result, or a message still marked queued,
 * means the panel went away while the background was working.
 */
export function looksUnfinished(items: ChatItem[]): boolean {
  return items.some((it) => (it.kind === 'tool' && it.summary === undefined) || (it.kind === 'user' && it.queued === true));
}
