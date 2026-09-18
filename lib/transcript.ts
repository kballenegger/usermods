// The side-panel transcript, as a pure reduction over agent events.
//
// This lives outside Chat.tsx because the panel has to apply the same reduction twice: once into
// React state for the chat the user is looking at, and once over the STORED items of a chat that
// is running in another tab. A run in chat A must keep filling in A's transcript while the user
// reads chat B, and neither may leak into the other — so the rule for "what does this event do to
// a transcript" has exactly one implementation, and it takes the items it edits as an argument.
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
    case 'error':
      return [...items, { kind: 'error', text: event.message }];
    case 'done':
      return items;
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
