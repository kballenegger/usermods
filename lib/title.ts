// Model-written chat titles.
//
// The truncated first message (lib/chats titleFromText) is a decent placeholder but a poor name:
// "hide the sidebar and make the article full width" says less at a glance than "Full-width
// Wikipedia articles". So after the first turn of a chat completes, the background makes one extra,
// tool-free call through the same provider and asks for a short name.
//
// Everything in this module is pure so it can be tested without a browser or a provider; the call
// itself lives in entrypoints/background.ts.
import type { Msg, Part } from './types';

/** Titles are stored through lib/chats, which clamps to the same length. */
export const TITLE_MAX = 60;

/** Roughly how much of the conversation is worth sending. Titles do not improve with more. */
export const TITLE_INPUT_MAX = 1500;

export const TITLE_SYSTEM_PROMPT = [
  'You name chat conversations. Reply with a title for the conversation below and nothing else.',
  'Rules: 3 to 6 words; sentence case; no quotes; no markdown; no trailing punctuation; no emoji.',
  'Name what the user is trying to do, not the fact that they asked. Never refuse: if the request is unclear, name its subject anyway.',
].join('\n');

/** Plain text of a message, tool calls and images dropped. */
function textOf(msg: Msg): string {
  return msg.content
    .filter((p): p is Extract<Part, { type: 'text' }> => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
}

/**
 * The agent prefixes each user turn with bracketed context lines ("[Current page: … — …]",
 * "[@token = …]"). They are noise for a title and eat the budget, so they come off here.
 */
export function stripTurnContext(text: string): string {
  return text
    .split('\n')
    .filter((line) => !/^\s*\[(Current page:|@|The user sent this while)/.test(line))
    .join('\n')
    .trim();
}

function userTexts(messages: Msg[]): string[] {
  return messages
    .filter((m) => m.role === 'user')
    .map((m) => stripTurnContext(textOf(m)))
    .filter(Boolean);
}

/** The assistant's last plain text, and the name of the last mod it proposed, if any. */
function assistantSummary(messages: Msg[]): string[] {
  const out: string[] = [];
  let lastText = '';
  let proposal = '';
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    const t = textOf(m);
    if (t) lastText = t;
    for (const p of m.content) {
      if (p.type === 'tool_call' && p.name === 'propose_mod' && typeof p.input.name === 'string') proposal = p.input.name;
    }
  }
  if (proposal) out.push(`Proposed mod: ${proposal}`);
  if (lastText) out.push(`Assistant: ${lastText}`);
  return out;
}

/** Trim to a budget on a word boundary where possible, so the model never sees a cut-off word. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

/**
 * The user message for the title call.
 *
 * `userMessages` is how many of the user's turns to include, counting back from the end: one for
 * the first-turn title, three for the refresh. The assistant's contribution is only worth including
 * for the first-turn title, where the proposal's name is often the best summary the chat has.
 */
export function buildTitleInput(messages: Msg[], { userMessages = 1, includeAssistant = true }: { userMessages?: number; includeAssistant?: boolean } = {}): string {
  const users = userTexts(messages);
  const picked = userMessages >= users.length ? users : users.slice(-userMessages);
  const lines = picked.map((t) => `User: ${t}`);
  if (includeAssistant) lines.push(...assistantSummary(messages));
  if (!lines.length) return '';
  // Budget the whole block, newest first, so the most recent request always survives the clamp.
  const budget = Math.floor(TITLE_INPUT_MAX / Math.max(1, lines.length));
  return clip(lines.map((l) => clip(l, Math.max(120, budget))).join('\n'), TITLE_INPUT_MAX);
}

/** A reply that is the model declining rather than naming the chat. */
function looksLikeRefusal(s: string): boolean {
  return /^(i('m| am| cannot|'ve| can't| won't)|sorry\b|as an ai\b|unable to\b|i apologi[sz]e)/i.test(s.trim());
}

/**
 * Turn whatever the model said into a title, or '' if nothing usable came back.
 *
 * Models wrap titles in quotes, prefix them with "Title:", bold them, or answer in several lines
 * despite being told not to. All of that is stripped here; the caller keeps the existing title when
 * this returns ''.
 */
export function sanitizeTitle(raw: string): string {
  if (typeof raw !== 'string') return '';
  // First non-empty line only: extra lines are commentary, not part of the name.
  let s = raw.replace(/\r/g, '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  s = s.replace(/^\s*(?:title|chat title|name)\s*[:\-—]\s*/i, '');
  s = s.replace(/^#{1,6}\s*/, ''); // markdown heading
  s = s.replace(/^[-*•]\s+/, ''); // list bullet
  s = s.replace(/\*\*|__|[`*_]/g, ''); // bold / italics / code
  s = s.replace(/\s+/g, ' ').trim();
  // Matching wrapping quotes, possibly doubled up by the stripping above.
  for (let i = 0; i < 2; i++) {
    const m = /^(["'“”‘’«»])(.*)(["'“”‘’«»])$/.exec(s);
    if (!m?.[2]) break;
    s = m[2].trim();
  }
  s = s.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
  // Emoji and other pictographs; the prompt forbids them but models add them anyway.
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}️]/gu, '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[.,;:!?]+$/, '').trim();
  if (!s) return '';
  if (looksLikeRefusal(s)) return '';
  if (s.length > TITLE_MAX) s = s.slice(0, TITLE_MAX - 1).trimEnd() + '…';
  return s;
}

/** How many turns of this chat have completed: one per user message in the stored history. */
export function completedTurns(messages: Msg[]): number {
  return messages.filter((m) => m.role === 'user' && m.content.some((p) => p.type === 'text')).length;
}

/** What lib/chats records about where a title came from. */
export type TitleSource = 'auto-first' | 'auto-model' | 'user';

export interface RetitleState {
  titleSource?: TitleSource;
  titleRefreshed?: boolean;
}

export type TitleDecision =
  | { kind: 'none' }
  /** The first-turn title: one user message plus what the assistant made of it. */
  | { kind: 'first' }
  /** The one refresh, at the 4th completed turn, from the last three user messages. */
  | { kind: 'refresh' };

/** A chat is retitled once more when it has grown past a first exchange into a real conversation. */
export const REFRESH_AT_TURN = 4;

/**
 * Should the background write a model title now, and from what?
 *
 * - A title the user typed is never touched, at either point.
 * - The first completed turn names the chat.
 * - The 4th completed turn refreshes a model-written title exactly once.
 * - Turns in between, and everything after the refresh, do nothing.
 */
export function titleDecision(chat: RetitleState | null | undefined, turns: number, enabled: boolean): TitleDecision {
  if (!enabled || !chat) return { kind: 'none' };
  if (chat.titleSource === 'user') return { kind: 'none' };
  if (turns === 1) return { kind: 'first' };
  if (turns === REFRESH_AT_TURN && chat.titleSource === 'auto-model' && !chat.titleRefreshed) return { kind: 'refresh' };
  return { kind: 'none' };
}
