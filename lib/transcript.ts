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

/** The note shown when a run outlived the panel and we could not capture what it streamed. */
export const RECONNECT_NOTE = 'reconnected — earlier output from this run was not captured';

/**
 * Did this transcript stop mid-turn? A tool row without a result, or a message still marked queued,
 * means the panel went away while the background was working.
 */
export function looksUnfinished(items: ChatItem[]): boolean {
  return items.some((it) => (it.kind === 'tool' && it.summary === undefined) || (it.kind === 'user' && it.queued === true));
}
