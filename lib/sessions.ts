// Agent runs, keyed by chat.
//
// The background worker used to keep ONE run per side-panel port: a single `running` flag, one
// queue and one AbortController in the onConnect closure. The port, though, is per PANEL, not per
// chat — the user switches tabs and the same port now belongs to a different chat — so a run
// started in chat A went on streaming into whatever chat was visible, a message sent in B was
// injected into A's model conversation, and Stop in B aborted A. This map is the fix: the port is
// only a transport, and every run is owned by its chat id.
//
// Different chats may run at the same time (they are on different tabs). Within one chat the
// behaviour is unchanged: a second message while a run is going is queued and handed to the model
// between tool calls.
import type { UserTurn } from './types';

export interface Session {
  /** The tab the run is driving. A chat is bound to a site, so this does not move mid-run. */
  tabId: number;
  running: boolean;
  queue: UserTurn[];
  controller: AbortController | null;
}

export class SessionMap {
  private readonly sessions = new Map<string, Session>();

  get(chatId: string): Session | undefined {
    return this.sessions.get(chatId);
  }

  /** The session for a chat, created idle if this is the chat's first message. */
  ensure(chatId: string, tabId: number): Session {
    const existing = this.sessions.get(chatId);
    if (existing) {
      // A chat can be re-targeted at a new tab id (the site was reopened), but only between runs.
      if (!existing.running) existing.tabId = tabId;
      return existing;
    }
    const fresh: Session = { tabId, running: false, queue: [], controller: null };
    this.sessions.set(chatId, fresh);
    return fresh;
  }

  /**
   * Decide what a 'send' does for this chat: start a run now, or queue behind the one in flight.
   * Returns the session either way so the caller can start the run it was told to start.
   */
  accept(chatId: string, tabId: number, turn: UserTurn): { session: Session; start: boolean } {
    const session = this.ensure(chatId, tabId);
    if (session.running) {
      session.queue.push(turn);
      return { session, start: false };
    }
    return { session, start: true };
  }

  /**
   * Stop one chat's run. Returns the ids of the queued messages that were dropped, so the panel can
   * hand their text back — and nothing happens to any other chat, which is the whole point.
   */
  abort(chatId: string): string[] {
    const session = this.sessions.get(chatId);
    if (!session) return [];
    const dropped = session.queue.splice(0).map((q) => q.id);
    session.controller?.abort();
    return dropped;
  }

  /** Forget a chat's session once its run is over and nothing is queued. */
  release(chatId: string): void {
    const session = this.sessions.get(chatId);
    if (session && !session.running && !session.queue.length) this.sessions.delete(chatId);
  }

  /** Every chat that currently has a session, for diagnostics and disconnect handling. */
  ids(): string[] {
    return [...this.sessions.keys()];
  }

  /** Is anything running for this chat right now? */
  isRunning(chatId: string): boolean {
    return this.sessions.get(chatId)?.running === true;
  }
}
