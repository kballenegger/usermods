// Keeping a chat's model history inside the context window.
//
// A chat's history used to grow without bound: every get_page snapshot (up to 60k chars), every
// find_elements listing and every run_script log was resent on every model call, forever. A long
// session on a dense page hits the provider's context limit and the user's turn simply fails.
//
// Two tiers, cheapest first, both driven by a token ESTIMATE (we never call a tokenizer — the
// point is a decision, not an invoice):
//
//   Tier 1 — elision. No model call. The CONTENT of old bulky tool results is replaced by a
//            one-line stub telling the model the tool exists and can be called again. The
//            structure is untouched, so every tool_call still has its tool_result and all three
//            provider adapters keep producing a valid request.
//   Tier 2 — summarisation. One extra, tool-free model call folds the oldest turns into a single
//            synthetic user message at the front of the history, and the most recent K user turns
//            survive verbatim. Cuts happen only at user-turn boundaries, so no tool call is ever
//            separated from its result.
//
// Everything here is pure except `compact`, which takes its model call as a parameter, so the
// whole policy is testable in node without a browser or a provider.

import { elidedImageNote } from '../images.ts';
import type { Msg, Part } from '../types';

// ---------------------------------------------------------------------------
// Size estimation
// ---------------------------------------------------------------------------

/** ~4 characters per token is the usual English rule of thumb, and close enough to decide with. */
const CHARS_PER_TOKEN = 4;

/**
 * A flat cost for an image. Real vision models price by tile (Anthropic ≈ w*h/750, OpenAI ≈ 85 +
 * 170/tile), which we cannot compute from a base64 blob without decoding it. A screenshot of the
 * panel-sized viewport lands around 1.1-1.6k tokens on both, so 1500 is a fair single number, and
 * anything we get wrong here only shifts when compaction triggers, never whether it is correct.
 */
export const IMAGE_TOKENS = 1500;

/** Per-message envelope: role, delimiters and the wrapper each adapter adds around content. */
const MESSAGE_OVERHEAD_TOKENS = 4;

/** Per-part envelope: a tool_use block's id/name, a tool_result's tool_use_id, JSON punctuation. */
const PART_OVERHEAD_TOKENS = 4;

const fromChars = (n: number) => Math.ceil(n / CHARS_PER_TOKEN);

/** Estimated tokens for one content part, including its own envelope. */
export function estimatePart(part: Part): number {
  switch (part.type) {
    case 'text':
      return PART_OVERHEAD_TOKENS + fromChars(part.text.length);
    case 'image':
      return PART_OVERHEAD_TOKENS + IMAGE_TOKENS;
    case 'tool_call':
      // The input is sent as JSON on every adapter, so its serialized length is the honest measure.
      return PART_OVERHEAD_TOKENS + fromChars(part.name.length + JSON.stringify(part.input ?? {}).length);
    case 'tool_result':
      return PART_OVERHEAD_TOKENS + part.content.reduce((n, c) => n + estimatePart(c), 0);
    case 'opaque':
      // Reasoning / function_call items replayed verbatim: JSON length is exactly what goes on the
      // wire. Encrypted reasoning payloads are much denser than prose per token, so this
      // overestimates them — which is the safe direction for a budget check.
      return PART_OVERHEAD_TOKENS + fromChars(safeJsonLength(part.item));
  }
}

function safeJsonLength(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0; // a cycle or a BigInt; it would not have survived storage either
  }
}

export function estimateMessage(msg: Msg): number {
  return MESSAGE_OVERHEAD_TOKENS + msg.content.reduce((n, p) => n + estimatePart(p), 0);
}

export function estimateTokens(messages: Msg[]): number {
  return messages.reduce((n, m) => n + estimateMessage(m), 0);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** Above this share of the budget, tier 1 runs. */
export const ELIDE_AT = 0.7;
/** Tier 1 stops once the history is back under this share. */
export const ELIDE_TARGET = 0.5;
/** Still above this share after tier 1 means tier 2 runs. */
export const SUMMARISE_AT = 0.7;
/** Tier 2 aims for this share, and always keeps KEEP_USER_TURNS turns whatever that costs. */
export const SUMMARISE_TARGET = 0.5;

/** How many of the most recent user turns survive tier 2 verbatim. */
export const KEEP_USER_TURNS = 3;

/** How many of the most recent user turns tier 1 refuses to touch. */
export const PROTECT_RECENT_TURNS = 2;

/**
 * When there are not PROTECT_RECENT_TURNS turns to protect, protect this many recent MESSAGES
 * instead.
 *
 * This matters more than it looks. One user turn can run to thirty tool rounds — "trace every
 * heading on this page" is a single turn that reads the page six times — and a turn-only rule
 * protects that entire history, so nothing is ever elided and the run dies on a context error with
 * the compactor watching. Six messages is two or three complete call/result rounds: enough that the
 * model always has its recent work in front of it, small enough that the other twenty-odd rounds
 * are reachable.
 */
export const PROTECT_RECENT_MESSAGES = 6;

/** Roughly how long the tier-2 summary may be. Enforced as characters on the returned text. */
export const SUMMARY_MAX_TOKENS = 1500;

/** Tool results big enough to be worth eliding, and cheap enough for the model to re-fetch. */
export const ELIDABLE_TOOLS = new Set(['get_page', 'find_elements', 'get_styles', 'screenshot', 'run_script']);

/**
 * Below this, eliding a result buys less than the stub costs to explain. Snapshots run tens of
 * thousands of characters, so this only skips the small stuff.
 */
export const MIN_ELIDE_TOKENS = 100;

/** The marker that makes an already-elided result recognisable, so compaction is idempotent. */
export const ELIDED_MARK = '[elided ·';

/** The note dropped in place of turns thrown away when the summary call fails. */
export const OMITTED_NOTE = '[earlier conversation omitted]';

/** One tier that ran, with the estimated size it started from and ended at. */
export interface CompactStep {
  tier: 'elided' | 'summarised';
  before: number;
  after: number;
}

export interface CompactResult {
  messages: Msg[];
  /** What was done, in the order it was done. Empty means the history was already small enough. */
  steps: CompactStep[];
  before: number;
  after: number;
}

// ---------------------------------------------------------------------------
// Tier 1 — elision
// ---------------------------------------------------------------------------

/** The tool_call id -> tool name map for a history, so a tool_result knows what produced it. */
function toolNames(messages: Msg[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of messages) {
    for (const p of m.content) if (p.type === 'tool_call') names.set(p.id, p.name);
  }
  return names;
}

/** Has this result already been replaced by a stub? */
export function isElided(part: Extract<Part, { type: 'tool_result' }>): boolean {
  const only = part.content.length === 1 ? part.content[0] : undefined;
  return !!only && only.type === 'text' && only.text.startsWith(ELIDED_MARK);
}

function stub(name: string, chars: number, images: number): Part {
  const size = images && !chars ? `${images} image${images === 1 ? '' : 's'}` : `${chars.toLocaleString('en-US')} chars`;
  return { type: 'text', text: `${ELIDED_MARK} ${name} result · ${size} · call ${name} again if you need it]` };
}

/** How many characters and images a tool result carries, for the stub's own text. */
function resultSize(part: Extract<Part, { type: 'tool_result' }>): { chars: number; images: number } {
  let chars = 0;
  let images = 0;
  for (const c of part.content) {
    if (c.type === 'text') chars += c.text.length;
    else if (c.type === 'image') images += 1;
    else chars += safeJsonLength(c);
  }
  return { chars, images };
}

/** Index of the message that begins the Nth-from-last user TURN (a user message that is not purely tool results). */
function recentTurnStart(messages: Msg[], turnsBack: number): number {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && isUserTurnStart(m)) {
      seen += 1;
      if (seen === turnsBack) return i;
    }
  }
  // Fewer turns than asked for: fall back to a message count, so a single long turn is still
  // elidable. Returning 0 here would protect the whole history and disable tier 1 entirely.
  return Math.max(0, messages.length - PROTECT_RECENT_MESSAGES);
}

/**
 * A user message that starts a turn, as opposed to one carrying tool results back to the model.
 * The loop writes tool results into a `user` message, so "role === 'user'" alone is not a turn.
 */
export function isUserTurnStart(msg: Msg): boolean {
  return msg.role === 'user' && !msg.content.some((p) => p.type === 'tool_result');
}

/**
 * Replace the content of old, bulky tool results with a one-line stub, largest-and-oldest first,
 * until the history is under `target` tokens.
 *
 * Protections, in the order they matter:
 *   - anything inside the most recent PROTECT_RECENT_TURNS user turns is untouched;
 *   - the LATEST result of each tool kind survives, so the model always has one fresh example of
 *     what each tool returns;
 *   - propose_mod is never elidable at all — the mod code is the artefact of the whole session;
 *   - only the CONTENT is replaced. The tool_result part, its toolCallId and its isError flag stay,
 *     so every adapter still emits a result for every call.
 *
 * Cache note: every provider caches on a prefix. Rewriting an old message invalidates the cached
 * prefix from that point on, so the next call pays full input price for everything after the
 * earliest thing we touched. That is why this runs in batches at a threshold rather than trimming a
 * little on every turn: one expensive call beats twenty slightly-less-expensive ones.
 */
export function elide(messages: Msg[], target: number): { messages: Msg[]; changed: boolean } {
  const names = toolNames(messages);
  const cutoff = recentTurnStart(messages, PROTECT_RECENT_TURNS);

  // Attached images in old turns are elided first, before any tool result is touched.
  //
  // They are the cheapest thing to lose and the most expensive thing to keep: IMAGE_TOKENS each,
  // resent on every call for the rest of the chat, and — unlike a tool result — the model cannot
  // call anything to get one back, so there is no point protecting "the most recent of each kind"
  // the way ELIDABLE_TOOLS are protected. What makes it safe is that the user's own recent turns
  // are off-limits (the same `cutoff`), so "make it look like this" keeps its picture for as long
  // as the request is live, and the full-size copy is still in the chat's blob store for the panel.
  const images = elideOldImages(messages, cutoff);
  messages = images.messages;
  if (images.changed && estimateTokens(messages) <= target) return { messages, changed: true };

  // Candidates, oldest first, and the latest of each tool kind marked off-limits.
  interface Candidate {
    msg: number;
    part: number;
    name: string;
    tokens: number;
  }
  const candidates: Candidate[] = [];

  for (let i = 0; i < messages.length; i++) {
    const content = messages[i]?.content ?? [];
    for (let j = 0; j < content.length; j++) {
      const p = content[j];
      if (p?.type !== 'tool_result') continue;
      const name = names.get(p.toolCallId) ?? '';
      if (!name) continue;
      if (i >= cutoff) continue; // recent turns are off-limits
      if (!ELIDABLE_TOOLS.has(name)) continue; // propose_mod and anything unknown stay whole
      if (isElided(p)) continue;
      const tokens = estimatePart(p);
      if (tokens < MIN_ELIDE_TOKENS) continue;
      candidates.push({ msg: i, part: j, name, tokens });
    }
  }

  // The latest result of each kind anywhere in the history is protected, recent or not.
  const protectedKeys = new Set<string>();
  for (const name of new Set(candidates.map((c) => c.name))) {
    const last = lastResultOf(messages, names, name);
    if (last) protectedKeys.add(`${last.msg}:${last.part}`);
  }

  const usable = candidates.filter((c) => !protectedKeys.has(`${c.msg}:${c.part}`));
  if (!usable.length) return { messages, changed: images.changed };

  // Largest first; ties broken oldest first, so a long-settled snapshot goes before a newer one.
  const order = [...usable].sort((a, b) => b.tokens - a.tokens || a.msg - b.msg || a.part - b.part);

  let total = estimateTokens(messages);
  const drop = new Set<string>();
  for (const c of order) {
    if (total <= target) break;
    drop.add(`${c.msg}:${c.part}`);
    total -= c.tokens;
  }
  if (!drop.size) return { messages, changed: images.changed };

  const out = messages.map((m, i) => {
    if (!m.content.some((_, j) => drop.has(`${i}:${j}`))) return m;
    return {
      ...m,
      content: m.content.map((p, j) => {
        if (!drop.has(`${i}:${j}`) || p.type !== 'tool_result') return p;
        const { chars, images } = resultSize(p);
        return { ...p, content: [stub(names.get(p.toolCallId) ?? 'tool', chars, images)] };
      }),
    };
  });
  return { messages: out, changed: true };
}

/**
 * Replace every attached image before `cutoff` with its one-line stub.
 *
 * Only user-attached images are touched. A screenshot lives inside a tool_result, which this
 * skips entirely — those are elided by the tool-result pass above, with the stub that tells the
 * model it can take another one. An attached image has no such option, so its stub simply says it
 * was there, numbered as the user attached it.
 */
export function elideOldImages(messages: Msg[], cutoff: number): { messages: Msg[]; changed: boolean } {
  let changed = false;
  const out = messages.map((m, i) => {
    if (i >= cutoff || !m.content.some((p) => p.type === 'image')) return m;
    let n = 0;
    const content = m.content.map((p) => {
      if (p.type !== 'image') return p;
      const replaced: Part = { type: 'text', text: elidedImageNote(n) };
      n += 1;
      changed = true;
      return replaced;
    });
    return { ...m, content };
  });
  return changed ? { messages: out, changed } : { messages, changed: false };
}

/** Where the most recent result of `name` lives, so it can be protected. */
function lastResultOf(messages: Msg[], names: Map<string, string>, name: string): { msg: number; part: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const content = messages[i]?.content ?? [];
    for (let j = content.length - 1; j >= 0; j--) {
      const p = content[j];
      if (p?.type === 'tool_result' && names.get(p.toolCallId) === name) return { msg: i, part: j };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tier 2 — summarisation
// ---------------------------------------------------------------------------

const SUMMARY_HEAD = [
  'You compress the earlier part of a conversation between a user and a browser-automation agent that writes userscripts ("mods") for web pages.',
  'The conversation continues after your summary, so write everything the agent needs to carry on without re-reading what you were given.',
  'Reply with the summary only. No preamble, no sign-off, no markdown headings beyond simple labels.',
  '',
  'The summary MUST cover, in this order:',
  "1. GOALS AND PREFERENCES — what the user is trying to achieve on this site, and every stated preference (style, wording, what they do not want).",
  '2. DECISIONS — what was decided, and which approaches were tried and REJECTED, with the reason. The agent must not retry a dead end.',
  '3. SELECTORS — every CSS selector discovered, verbatim, each labelled with whether it proved stable, was wrong, or was never verified.',
];

const SUMMARY_TAIL = ['5. OPEN PROBLEMS — what is still broken or unknown.', '6. LATEST REQUEST — what the user asked for most recently.', ''];

/**
 * The summary prompt when the chat has no draft mod: section 4 has to reproduce the latest proposed
 * code verbatim, because the summary is the only thing that will still be carrying it.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  ...SUMMARY_HEAD,
  '4. CURRENT PROPOSAL — the FULL text of the latest proposed mod code, character for character, inside a fenced code block, with its name and match patterns. If there is no proposal yet, say so.',
  ...SUMMARY_TAIL,
  'Be terse everywhere except section 4, which is copied exactly and never abbreviated.',
].join('\n');

/**
 * The summary prompt when the chat HAS a draft mod.
 *
 * Section 4 stops asking for the code. The draft is re-sent in full on every user turn
 * (lib/artifact.ts draftBlock, prepended by the loop's renderTurn), so asking a summariser to copy
 * a 200-line script "character for character" into a 1500-token budget is paying twice for the one
 * thing that cannot go missing — and paying for it in the lossy copy, since a model asked to
 * reproduce code exactly sometimes does not. What the summary owes here is the part the draft
 * block cannot say: how the script got to be what it is.
 */
export const SUMMARY_SYSTEM_PROMPT_WITH_DRAFT = [
  ...SUMMARY_HEAD,
  '4. THE DRAFT SO FAR — how the current draft mod came to be what it is: what each revision changed and why, and anything the user asked for that it does NOT yet do. Do NOT copy the code: the current draft is attached in full to every turn, so reproducing it here would only risk a worse copy of something the agent can already see.',
  ...SUMMARY_TAIL,
  'Be terse throughout.',
].join('\n');

/** The header the synthetic summary message wears, so the model knows what it is reading. */
export const SUMMARY_PREFIX = '[Summary of the earlier part of this conversation, written because the conversation grew too long to resend in full. Treat it as established context.]';

/**
 * The transcript handed to the summariser. Plain text, tool results clipped: the summary call has
 * its own budget, and feeding it the megabyte we are trying to shed defeats the point.
 */
export function renderForSummary(messages: Msg[], maxCharsPerPart = 2000): string {
  const names = toolNames(messages);
  const lines: string[] = [];
  const clip = (s: string) => (s.length > maxCharsPerPart ? `${s.slice(0, maxCharsPerPart)}… [${s.length - maxCharsPerPart} more chars]` : s);

  for (const m of messages) {
    for (const p of m.content) {
      switch (p.type) {
        case 'text':
          lines.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: ${clip(p.text)}`);
          break;
        case 'image':
          // The caption text part that follows carries the dimensions and the filename, so the
          // summary already has what it needs to mention the picture; this only marks its place.
          lines.push(`${m.role === 'user' ? 'USER' : 'ASSISTANT'}: [attached image]`);
          break;
        case 'tool_call':
          // propose_mod inputs go in whole: the mod code is what section 4 has to reproduce.
          lines.push(
            p.name === 'propose_mod'
              ? `TOOL CALL ${p.name}: ${safeStringify(p.input)}`
              : `TOOL CALL ${p.name}: ${clip(safeStringify(p.input))}`,
          );
          break;
        case 'tool_result': {
          const name = names.get(p.toolCallId) ?? 'tool';
          const text = p.content.map((c) => (c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : safeStringify(c))).join('\n');
          lines.push(`TOOL RESULT ${name}${p.isError ? ' (error)' : ''}: ${clip(text)}`);
          break;
        }
        case 'opaque':
          // Provider-private reasoning items carry nothing a summary can use, and their encrypted
          // payloads are pure noise in a prompt.
          break;
      }
    }
  }
  return lines.join('\n');
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Where to cut so `keepTurns` user turns survive: the index of the message that starts the
 * keepTurns-th user turn from the end, or 0 when there are not that many turns.
 *
 * Cutting only at a turn start is what keeps tool calls with their results, and what keeps a turn
 * containing `opaque` provider items whole — those replay verbatim or not at all, so a turn holding
 * one is either summarised entirely or kept entirely, never partially edited.
 */
export function cutIndex(messages: Msg[], keepTurns = KEEP_USER_TURNS): number {
  // A summary we wrote earlier is a user message, but it is not a TURN: counting it would let a
  // second pass fold the summary into a summary of itself, losing a little more each time. It is
  // also the one message that must never be cut away, since everything before it is already gone.
  const floor = startsWithSummary(messages) ? 1 : 0;
  let seen = 0;
  for (let i = messages.length - 1; i >= floor; i--) {
    const m = messages[i];
    if (!m || !isUserTurnStart(m)) continue;
    seen += 1;
    if (seen === keepTurns) return i <= floor ? 0 : i;
  }
  return 0;
}

/** Did this history already begin with a summary we wrote? */
export function startsWithSummary(messages: Msg[]): boolean {
  const first = messages[0];
  if (!first || first.role !== 'user') return false;
  const text = first.content.find((p) => p.type === 'text');
  return !!text && text.type === 'text' && text.text.startsWith(SUMMARY_PREFIX);
}

function summaryMessage(text: string): Msg {
  const capped = text.length > SUMMARY_MAX_TOKENS * CHARS_PER_TOKEN ? `${text.slice(0, SUMMARY_MAX_TOKENS * CHARS_PER_TOKEN)}…` : text;
  return { role: 'user', content: [{ type: 'text', text: `${SUMMARY_PREFIX}\n\n${capped}` }] };
}

/** The fallback when the summary call fails or is aborted: drop the old turns, say that we did. */
export function dropOldest(messages: Msg[], cut: number): Msg[] {
  if (cut <= 0) return messages;
  // An existing summary is context we already paid a model call for; it survives the fallback.
  const head: Msg[] = startsWithSummary(messages) ? [messages[0]!] : [];
  return [...head, { role: 'user', content: [{ type: 'text', text: OMITTED_NOTE }] }, ...messages.slice(cut)];
}

// ---------------------------------------------------------------------------
// The whole policy
// ---------------------------------------------------------------------------

export interface CompactOptions {
  budget: number;
  /**
   * One tool-free model call: system + user in, plain text out. Omitted (or throwing) means tier 2
   * degrades to dropping the oldest turns rather than failing the user's turn.
   */
  summarise?: (system: string, user: string) => Promise<string>;
  signal?: AbortSignal;
  keepTurns?: number;
  /**
   * Whether the chat has a draft mod that is re-sent on every turn. When it does, the summary is
   * asked for the draft's HISTORY rather than its code — see SUMMARY_SYSTEM_PROMPT_WITH_DRAFT.
   */
  hasDraft?: boolean;
}

/** Is this history worth compacting at all? Cheap enough to call before every provider request. */
export function needsCompaction(messages: Msg[], budget: number): boolean {
  return budget > 0 && estimateTokens(messages) > budget * ELIDE_AT;
}

/**
 * Bring a history under budget, cheapest tier first.
 *
 * Never throws: a failing summary call falls back to dropping the oldest turns, because losing
 * context is survivable and failing the user's turn is not.
 */
export async function compact(messages: Msg[], opts: CompactOptions): Promise<CompactResult> {
  const before = estimateTokens(messages);
  const steps: CompactStep[] = [];
  const { budget } = opts;
  if (budget <= 0 || before <= budget * ELIDE_AT) return { messages, steps, before, after: before };

  let out = messages;
  let size = before;

  // Tier 1.
  const elided = elide(out, Math.floor(budget * ELIDE_TARGET));
  if (elided.changed) {
    out = elided.messages;
    const after = estimateTokens(out);
    steps.push({ tier: 'elided', before: size, after });
    size = after;
  }

  // Tier 2, only if elision was not enough.
  if (size > budget * SUMMARISE_AT) {
    const keepTurns = opts.keepTurns ?? KEEP_USER_TURNS;
    const cut = cutIndex(out, keepTurns);
    // Nothing to fold: fewer turns than we promised to keep, so there is no older half at all.
    // A history that is already a summary plus the kept turns cuts at 0 too, which makes
    // compacting an already-compact history a no-op rather than a summary of a summary.
    if (cut > 0) {
      const older = out.slice(0, cut);
      const recent = out.slice(cut);
      // The older half already carries any previous summary at its front, so the new summary is
      // written over "summary so far + the turns since", not over the turns alone.
      let summary: string | null = null;
      if (opts.summarise && !opts.signal?.aborted) {
        try {
          const system = opts.hasDraft ? SUMMARY_SYSTEM_PROMPT_WITH_DRAFT : SUMMARY_SYSTEM_PROMPT;
          const raw = await opts.summarise(system, renderForSummary(older));
          const text = raw.trim();
          if (text) summary = text;
        } catch {
          summary = null; // a 429, a timeout, an abort: the fallback below still keeps the chat usable
        }
      }
      out = summary ? [summaryMessage(summary), ...recent] : dropOldest(out, cut);
      const after = estimateTokens(out);
      steps.push({ tier: 'summarised', before: size, after });
      size = after;
    }
  }

  return { messages: out, steps, before, after: size };
}
