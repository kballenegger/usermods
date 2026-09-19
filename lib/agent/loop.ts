// Every value import below carries its .ts extension, as lib/transcript.ts explains: `npm test`
// runs this file through node --experimental-strip-types (test/loop.test.ts drives the whole loop
// against a fake provider), and node's ESM resolver does not guess extensions or directory indexes.
import { imageNote } from '../images.ts';
import { createProvider } from '../providers/index.ts';
import type { Provider } from '../providers/types';
import { renderRunResult, type RunResult } from '../runscript.ts';
import { DEFAULT_CONTEXT_BUDGET, type AgentEventBody, type ModProposal, type Msg, type Part, type Settings, type UserTurn } from '../types.ts';
import { MAX_ITERATIONS, countReads, readBudgetNudge, wrapUpNudge } from './budget.ts';
import { compact, needsCompaction } from './compact.ts';
import { SYSTEM_PROMPT } from './prompt.ts';
import { checkProposal, type ProposalContext } from './propose.ts';
import { withRetry, type RetryDeps, type RetryPolicy } from './retry.ts';
import { TOOLS } from './tools.ts';
import {
  EMPTY_TALLY,
  foldWait,
  markNudged,
  parseWaitInput,
  renderWaitResult,
  waitAbuseNudge,
  waitActivityDetail,
  type WaitOutcome,
  type WaitSpec,
} from './wait.ts';

/** Everything a tool needs from the browser. Implemented in the background worker. */
export interface AgentEnv {
  sendToContent<T = unknown>(req: unknown): Promise<T>;
  runScript(code: string): Promise<RunResult>;
  screenshot(): Promise<{ mediaType: 'image/jpeg' | 'image/png'; data: string }>;
  pageInfo(): Promise<{ url: string; title: string }>;
  /**
   * Wait until a condition holds (lib/agent/wait.ts). DOM conditions go to the content script,
   * url/load to chrome.tabs.onUpdated, `ms` to a timer — which one is the background's business,
   * not the loop's. Never rejects: a wait that could not run reports `failure` in its outcome.
   *
   * The signal is the run's own: Stop must end a 15s wait immediately rather than at its timeout.
   */
  wait(spec: WaitSpec, signal: AbortSignal): Promise<WaitOutcome>;
}

export interface AgentInput {
  settings: Settings;
  history: Msg[];
  /**
   * The message that starts this run, or null to RESUME: carry on from `history` exactly as it
   * stands, adding no user turn at all. That is what the panel's Resume button does after a run
   * failed or was interrupted — the model gets the same conversation again, tool results and all,
   * and simply continues, so the prompt is never sent twice and no finished tool runs again.
   */
  turn: UserTurn | null;
  /** Messages the user sent while this run was in progress. Drained between model calls. */
  pullQueued: () => UserTurn[];
  env: AgentEnv;
  emit: (e: AgentEventBody) => void;
  signal: AbortSignal;
  /**
   * One tool-free model call, used for the compaction summary. Supplied by the background so the
   * loop stays free of provider plumbing; omitted, tier 2 degrades to dropping the oldest turns.
   */
  complete?: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
  /**
   * Called whenever compaction rewrote the history, so the caller can persist the smaller version
   * immediately rather than only at the end of the turn. Failures here are ignored.
   */
  onCompacted?: (messages: Msg[]) => void | Promise<void>;
  /**
   * The chat's current draft mod, rendered as the block prepended to each user turn
   * (lib/artifact.ts draftBlock). Supplied by the background, which owns artifact storage; the loop
   * only decides where it goes. Empty or absent means this chat has no draft yet, which is the
   * normal state of a first turn.
   *
   * It is a function rather than a string because the draft moves DURING a turn: a propose_mod in
   * step 3 becomes v2, and a message the user queues afterwards must be answered against v2, not
   * against the v1 the turn started on.
   */
  draft?: () => string;
  /**
   * Whether the chat has a draft. Passed through to compaction, which asks for a different summary
   * when the draft's code is being re-sent every turn anyway. A function, like `draft`, because a
   * turn that starts with no draft can end with one.
   */
  hasDraft?: () => boolean;
  /**
   * Record an accepted proposal as a new version of the draft. Returns the version number, which
   * the loop emits so the panel can select it. The background implements it; a loop running without
   * one (the unit tests) simply proposes as before.
   */
  onProposal?: (p: ModProposal) => Promise<number | null>;
  /**
   * Called with the conversation each time it reaches a point worth keeping: once the user's turn
   * is in it, and after every step whose tool calls have all been answered. The history is valid
   * for every provider at each of those points, so whatever kills the run next — an exhausted
   * retry, the service worker being evicted, the browser quitting — the caller has something it can
   * resume from. Awaited, so checkpoints land in order; failures are ignored.
   */
  onCheckpoint?: (messages: Msg[]) => void | Promise<void>;
  /** The provider to talk to. Defaults to the one `settings` describes; tests pass a fake. */
  provider?: Provider;
  /** The retry policy and its clock, for the model request (lib/agent/retry.ts). */
  retry?: { policy?: RetryPolicy; deps?: Partial<RetryDeps> };
}

/**
 * How a run ended. `messages` is ALWAYS a history every adapter will accept: a run that failed
 * hands back everything it completed, so the caller saves real progress rather than the bare
 * prompt. `failure` is set when the model request failed for good (not retryable, or out of
 * retries); Stop is not a failure.
 *
 * A result rather than an error with the messages attached: the caller does the same thing with
 * the messages on every path (save them), and a thrown error that must be caught to reach the
 * normal return value is a return value wearing a disguise.
 */
export interface RunOutcome {
  messages: Msg[];
  failure?: { message: string };
}

/**
 * The one synthetic line a resume may add. A conversation saved mid-run ends on a user message (the
 * prompt, or a step's tool results), which is exactly what every API wants to see last, so normally
 * nothing is added. The exception is a history that ends on an ASSISTANT message — a run that was
 * interrupted in the instant between finishing and being marked finished. Anthropic's current
 * models reject a trailing assistant message outright (it reads as a prefill), so that one case
 * gets a user line saying what happened.
 */
export const RESUME_NUDGE = '[The previous run was interrupted before it finished. Continue from where you left off.]';

/**
 * One user turn as the model sees it: where the page is, what the draft mod currently is, which
 * elements the user pointed at, and then their own words.
 *
 * The draft leads, because it is the thing most requests are about once one exists — "make the
 * button blue instead" is an edit to it and nothing else in the message says so. It is re-sent
 * every turn rather than relied upon from the history, so a compaction that summarised away the
 * proposal it came from cannot leave the model editing a script it can no longer see.
 */
function renderTurn(turn: UserTurn, page: { url: string; title: string } | null, injected: boolean, draft = ''): string {
  const lines: string[] = [];
  if (page) lines.push(`[Current page: ${page.title} — ${page.url}]`);
  if (draft) lines.push(draft);
  for (const ref of turn.refs ?? []) {
    const html = ref.html.length > 2500 ? ref.html.slice(0, 2500) + '…' : ref.html;
    lines.push(`[@${ref.token} = ${ref.label} — selector: ${ref.selector}]`, html);
  }
  // A caption per attached image, so the model can refer to "the second screenshot" and knows what
  // it is looking at without measuring it. The pictures themselves are separate parts, placed
  // before this text by turnParts().
  (turn.images ?? []).forEach((img, i) => lines.push(imageNote(img, i)));
  if (injected) lines.push('[The user sent this while you were working. Take it into account from here on.]');
  return `${lines.join('\n')}\n\n${turn.text}`.trim();
}

/**
 * One user turn as content parts: every attached image FIRST, then the text.
 *
 * The order is not cosmetic. Anthropic documents that an image placed before the text it is about
 * gives better results, the Responses API groups images after text in its own input array anyway,
 * and a chat-completions backend simply reads the parts in order — so image-then-text is the one
 * arrangement all three treat as "here is a picture, and here is what I am asking about it".
 *
 * The draft block is not a part of its own: it rides inside the single text part that renderTurn()
 * builds, ahead of the refs and the image captions. Keeping it there rather than in a part before
 * the images preserves the one rule the provider adapters care about — images immediately before
 * the text of the message they are about — while the model still reads the draft first within that
 * text, which is the only place the ordering matters to it.
 */
function turnParts(turn: UserTurn, page: { url: string; title: string } | null, injected: boolean, draft = ''): Part[] {
  const parts: Part[] = (turn.images ?? []).map((img) => ({ type: 'image', mediaType: img.mediaType, data: img.data }));
  parts.push({ type: 'text', text: renderTurn(turn, page, injected, draft) });
  return parts;
}

/**
 * Drop a trailing assistant turn whose tool calls were never answered, so the history stays valid.
 * Every adapter needs this: chat-completions and Responses reject a tool call with no output, and
 * Anthropic rejects a tool_use with no tool_result.
 */
export function trimUnanswered(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.content.some((p) => p.type === 'tool_call')) return messages.slice(0, -1);
  return messages;
}

/** The words of the last message the user actually typed, for a resumed run's proposal checks. */
function lastUserText(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== 'user' || m.content.some((p) => p.type === 'tool_result')) continue;
    return m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
  }
  return '';
}

/**
 * Has a run_script succeeded since the last proposal? A resumed run rebuilds this from the history,
 * because the flag it replaces lived in the run that died: without it, a model that tested its
 * script, lost the connection and resumed would be told to test it again.
 */
function testedSinceProposal(messages: Msg[]): boolean {
  const failed = new Set<string>();
  for (const m of messages) for (const p of m.content) if (p.type === 'tool_result' && p.isError) failed.add(p.toolCallId);
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user' && !m.content.some((p) => p.type === 'tool_result')) return false; // the turn began here
    if (m.role !== 'assistant') continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const p = m.content[j]!;
      if (p.type !== 'tool_call') continue;
      if (p.name === 'propose_mod') return false;
      if (p.name === 'run_script' && !failed.has(p.id)) return true;
    }
  }
  return false;
}

export async function runAgent(input: AgentInput): Promise<RunOutcome> {
  const { settings, env, emit, signal } = input;
  const provider = input.provider ?? createProvider(settings);
  const messages: Msg[] = [...input.history];
  const draft = () => input.draft?.() ?? '';
  const checkpoint = () => Promise.resolve(input.onCheckpoint?.(trimUnanswered(messages))).catch(() => {});

  if (input.turn) {
    const page = await env.pageInfo().catch(() => null);
    messages.push({ role: 'user', content: turnParts(input.turn, page, false, draft()) });
    emit({ type: 'accepted', id: input.turn.id });
  } else {
    // Resuming. The conversation is sent as it stands; see RESUME_NUDGE for the one exception.
    const kept = trimUnanswered(messages);
    if (kept !== messages) messages.splice(0, messages.length, ...kept);
    if (messages[messages.length - 1]?.role === 'assistant') messages.push({ role: 'user', content: [{ type: 'text', text: RESUME_NUDGE }] });
  }
  // The turn is safe before the first request is made: a run that dies waiting for its first byte
  // still has the user's message in the saved conversation, so Resume needs nothing resent.
  await checkpoint();

  try {
    await loop();
  } catch (e) {
    // Stop is not a failure. Anything else is the model request failing for good: the messages
    // completed so far go back to the caller either way, which is the whole point.
    if (!signal.aborted) return { messages: trimUnanswered(messages), failure: { message: e instanceof Error ? e.message : String(e) } };
  }
  return { messages: signal.aborted ? trimUnanswered(messages) : messages };

  /**
   * Keep the history inside the context budget before every provider call.
   *
   * Compaction rewrites `messages` in place (splice, not reassign) because the array is the one
   * the caller gets back and the one every closure below reads. Each tier emits its own event, so
   * a turn that both elided and summarised shows two notes — which is the honest picture.
   */
  async function maybeCompact() {
    const budget = settings.contextBudget ?? DEFAULT_CONTEXT_BUDGET;
    if (!needsCompaction(messages, budget)) return;
    const res = await compact(messages, {
      budget,
      signal,
      summarise: input.complete ? (system, user) => input.complete!(system, user, signal) : undefined,
      hasDraft: input.hasDraft?.() ?? false,
    });
    if (!res.steps.length) return;
    messages.splice(0, messages.length, ...res.messages);
    // One event per tier, each reporting the sizes that tier actually saw.
    for (const step of res.steps) emit({ type: 'compacted', tier: step.tier, before: step.before, after: step.after });
    await Promise.resolve(input.onCompacted?.(messages)).catch(() => {});
  }

  async function loop() {
    // Page reads since the model last ran or proposed anything. The prompt's read budget is only a
    // rule until something in the conversation contradicts the model when it breaks it; this is
    // that something. Per turn, reset by run_script or propose_mod.
    let reads = 0;
    // Whether a run_script has completed since the last proposal, which is what propose_mod's
    // "test it first" check reads. Held here rather than derived from the message history, because
    // by the time the history is stored a tool result is provider-neutral text.
    const ctx: ProposalContext = input.turn
      ? { testedSinceProposal: false, userText: input.turn.text }
      : { testedSinceProposal: testedSinceProposal(messages), userText: lastUserText(messages) };
    // How much this turn has waited (lib/agent/wait.ts). Waiting is neither a read nor an act, so
    // it has its own counter: it must not trip the read budget (polling was the problem wait_for
    // exists to remove, and charging for the fix would push the model straight back to polling),
    // and it must not reset it either (a wait proves nothing about the page).
    let tally = EMPTY_TALLY;
    // Every other exit from the for loop is deliberate and says something; falling off the end is
    // the one that used to say nothing at all.
    let ranOut = true;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      if (signal.aborted) {
        ranOut = false;
        break;
      }
      // Compaction runs before the status line, so "waiting for model" is not shown while the
      // summariser's own call is in flight — that would read as the user's turn hanging. It also
      // runs after the previous iteration appended its nudges, so their cost is inside the
      // estimate this check makes.
      await maybeCompact();
      if (signal.aborted) {
        ranOut = false;
        break;
      }
      // The panel's activity line is driven entirely by these: it has no other way to tell a model
      // that is thinking from one that has hung.
      const modelStatus = () => emit({ type: 'status', phase: 'model', detail: i === 0 ? 'waiting for model' : 'continuing', iteration: i + 1 });
      modelStatus();
      // The model request, and only the model request, is retried (lib/agent/retry.ts). Nothing
      // below this call runs twice: the tools execute once, after a reply has arrived whole.
      //
      // `streamed` counts the text this ATTEMPT has put on screen. A reply that dies half-way is
      // not part of the conversation, and the retry streams its own from the start, so the panel is
      // told to take those characters back before it sees the same sentence again.
      let streamed = 0;
      const res = await withRetry(
        () => {
          streamed = 0;
          return provider.chat({
            system: SYSTEM_PROMPT,
            messages,
            tools: TOOLS,
            signal,
            callbacks: {
              onText: (delta) => {
                streamed += delta.length;
                emit({ type: 'text', delta });
              },
            },
          });
        },
        {
          signal,
          policy: input.retry?.policy,
          deps: input.retry?.deps,
          onAttemptFailed: () => {
            if (streamed) emit({ type: 'text_discard', chars: streamed });
            streamed = 0;
          },
          onRetry: (n) =>
            emit({
              type: 'status',
              phase: 'model',
              detail: 'retrying',
              iteration: i + 1,
              retry: { reason: n.reason, attempt: n.attempt, max: n.max, until: Date.now() + n.delayMs, ...(n.status === undefined ? {} : { status: n.status }) },
            }),
          onOffline: (capMs) =>
            emit({ type: 'status', phase: 'model', detail: 'offline', iteration: i + 1, retry: { reason: 'offline', attempt: 0, max: 0, until: Date.now() + capMs } }),
          // Back to the ordinary label: the wait is over and a request is in flight again.
          onResume: modelStatus,
        },
      );
      messages.push({ role: 'assistant', content: res.content });

      const calls = res.content.filter((p): p is Extract<Part, { type: 'tool_call' }> => p.type === 'tool_call');
      if (res.stopReason === 'max_tokens' && calls.length) {
        messages.pop();
        emit({ type: 'error', message: 'The model hit its output limit mid tool call. Try again with a smaller request.' });
        ranOut = false;
        break;
      }
      if (res.stopReason === 'refusal') {
        emit({ type: 'error', message: 'The model declined this request.' });
        ranOut = false;
        break;
      }
      if (!calls.length) {
        ranOut = false;
        break;
      }

      const results: Part[] = [];
      let proposed = false;
      // Real time spent inside wait_for and run_script's then_wait this iteration, so the abuse
      // guard charges what waiting actually cost rather than what it was allowed to cost.
      let waitedMs = 0;
      for (const call of calls) {
        emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
        emit({ type: 'status', phase: 'tool', tool: call.name, detail: describeCall(call.name, call.input), iteration: i + 1 });
        const r = await executeTool(call.name, call.input, env, emit, ctx, signal, input.onProposal);
        emit({ type: 'tool_result', id: call.id, summary: summarize(r.content), isError: !!r.isError });
        results.push({ type: 'tool_result', toolCallId: call.id, content: r.content, isError: r.isError });
        if (call.name === 'propose_mod' && !r.isError) proposed = true;
        waitedMs += r.waitedMs ?? 0;
      }

      // Both nudges ride along with the tool results rather than as a separate user message, so the
      // history keeps its assistant/tool-result pairing and no orphan turn appears in the panel.
      const before = reads;
      const names = calls.map((c) => c.name);
      reads = countReads(reads, names);
      const budget = readBudgetNudge(reads, before);
      if (budget) results.push({ type: 'text', text: budget });
      // The waiting guard. A turn that waits, acts, waits, acts is using the tool as intended and
      // is never nudged; a turn that has stopped doing anything but wait is told so once.
      tally = foldWait(tally, names, waitedMs);
      const waited = waitAbuseNudge(tally);
      if (waited) {
        results.push({ type: 'text', text: waited });
        tally = markNudged(tally);
      }
      const wrapUp = wrapUpNudge(i);
      if (wrapUp) results.push({ type: 'text', text: wrapUp });

      // Anything the user typed meanwhile joins this message, after the tool results.
      const queued = signal.aborted ? [] : input.pullQueued();
      for (const q of queued) {
        // A queued message rides back with the tool results, images and all. Its pictures go in
        // before its text for the same reason a fresh turn's do.
        //
        // The draft is read again here, not captured at the top of the turn: a proposal made two
        // steps ago has already become the current version, and a queued "make it bigger" is about
        // that version.
        results.push(...turnParts(q, null, true, draft()));
        emit({ type: 'accepted', id: q.id });
      }
      messages.push({ role: 'user', content: results });
      // Every call in this step has its result, so the conversation is whole again: keep it.
      await checkpoint();
      if (signal.aborted) {
        ranOut = false;
        break;
      }
      // A proposal ends the turn: the user decides what happens next.
      if (proposed && !queued.length) {
        ranOut = false;
        break;
      }
    }

    // Falling out of the for loop used to be silent: the panel simply stopped, with no proposal and
    // no explanation, which is the "i can't tell if it's stuck" complaint exactly. This is a soft
    // stop, not an error - the history is valid and a reply picks the turn back up.
    if (ranOut && !signal.aborted) emit({ type: 'stopped', reason: 'max_steps', steps: MAX_ITERATIONS });
  }
}

/**
 * The human half of a tool's status line: what a person would say the agent is doing. run_script
 * carries its own description; the page-inspection tools are best described by what they look at.
 */
function describeCall(name: string, input: Record<string, unknown>): string | undefined {
  // A wait says what it is waiting for, which is what makes a 15s pause legible rather than a
  // hang: "waiting for .result · 3s". The identifier is truncated in lib/agent/wait.ts so a long
  // selector cannot push the elapsed timer off a 420px panel.
  if (name === 'wait_for') {
    const parsed = parseWaitInput(input);
    return parsed.ok ? waitActivityDetail(parsed.spec.condition) : 'waiting';
  }
  if (name === 'run_script' && typeof input.description === 'string' && input.description.trim()) return input.description.trim();
  if ((name === 'find_elements' || name === 'get_styles' || name === 'get_page') && typeof input.selector === 'string' && input.selector.trim()) {
    return input.selector.trim();
  }
  return undefined;
}

function summarize(parts: Part[]): string {
  const p = parts[0];
  if (!p) return '';
  if (p.type === 'image') return '[image]';
  if (p.type === 'text') return p.text.length > 160 ? p.text.slice(0, 160) + '…' : p.text;
  return '';
}

/** What one tool call produced. `waitedMs` is real time spent waiting, for the abuse guard. */
interface ToolOutcome {
  content: Part[];
  isError?: boolean;
  waitedMs?: number;
}

function text(s: string): ToolOutcome {
  return { content: [{ type: 'text', text: s }] };
}
function err(s: string): ToolOutcome & { isError: true } {
  return { content: [{ type: 'text', text: s }], isError: true };
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  env: AgentEnv,
  emit: (e: AgentEventBody) => void,
  ctx: ProposalContext,
  signal: AbortSignal,
  onProposal?: (p: ModProposal) => Promise<number | null>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'get_page': {
        const r = await env.sendToContent<{ html?: string; url?: string; title?: string; error?: string }>({
          type: 'snapshot',
          selector: typeof input.selector === 'string' ? input.selector : undefined,
          maxChars: Math.min(60_000, Number(input.max_chars) || 20_000),
        });
        if (r.error) return err(r.error);
        return text(`URL: ${r.url}\nTitle: ${r.title}\n\n${r.html}`);
      }
      case 'find_elements': {
        if (typeof input.selector !== 'string') return err('selector is required');
        const r = await env.sendToContent<{ text: string }>({ type: 'query', selector: input.selector, limit: Number(input.limit) || 20 });
        return text(r.text);
      }
      case 'get_styles': {
        if (typeof input.selector !== 'string') return err('selector is required');
        const r = await env.sendToContent<{ text: string }>({
          type: 'styles',
          selector: input.selector,
          properties: Array.isArray(input.properties) ? (input.properties as string[]) : undefined,
        });
        return text(r.text);
      }
      case 'run_script': {
        if (typeof input.code !== 'string') return err('code is required');
        // then_wait is parsed BEFORE the code runs: a malformed condition should cost nothing and
        // change nothing, rather than mutate the page and then report an input error.
        let thenWait: WaitSpec | null = null;
        if (input.then_wait !== undefined && input.then_wait !== null) {
          const parsed = parseWaitInput(input.then_wait);
          if (!parsed.ok) return err(`then_wait: ${parsed.error}`);
          thenWait = parsed.spec;
        }
        const r = await env.runScript(input.code);
        const rendered = renderRunResult(r);
        // Only a run that actually completed counts as having tested the script. A navigation, a
        // timeout or a throw proves nothing, so propose_mod will still ask for a real test.
        if (r.outcome.kind === 'ok') ctx.testedSinceProposal = true;
        if (!thenWait) return rendered.isError ? err(rendered.text) : text(rendered.text);

        // The composition case. A script that navigates loses its result (renderRunResult says so,
        // and rightly — normally that IS a lost result). But when the model said it was waiting for
        // a url or load condition, the navigation is the thing it asked for, so the same outcome
        // stops being a loss and becomes the expected first half of a successful step. The wait
        // below then confirms it, and the two halves are reported together either way.
        const navigatedAsExpected = r.outcome.kind === 'navigated' && (thenWait.condition.kind === 'url' || thenWait.condition.kind === 'load');
        const startedAt = Date.now();
        const outcome = await env.wait(thenWait, signal);
        const waitedMs = Date.now() - startedAt;
        const waitText = renderWaitResult(thenWait, outcome).text;

        const scriptLine = navigatedAsExpected
          ? `The script ran and the page navigated to ${(r.outcome as Extract<RunResult['outcome'], { kind: 'navigated' }>).url}, which is what then_wait was waiting for.`
          : rendered.text;
        const combined = `${scriptLine}\n\nthen_wait: ${waitText}`;
        // A failed wait (a closed tab, a torn-down page) is an error; a timeout is not, and neither
        // is a navigation the model asked for.
        const isError = outcome.failure ? true : navigatedAsExpected ? false : rendered.isError;
        return { content: [{ type: 'text', text: combined }], isError: isError || undefined, waitedMs };
      }
      case 'wait_for': {
        const parsed = parseWaitInput(input);
        // Invalid input is the one thing here that IS an error: the model wrote a condition that
        // cannot be answered, and telling it so is more useful than waiting 5s to say nothing.
        if (!parsed.ok) return err(parsed.error);
        const startedAt = Date.now();
        const outcome = await env.wait(parsed.spec, signal);
        const waitedMs = Date.now() - startedAt;
        const rendered = renderWaitResult(parsed.spec, outcome);
        return { content: [{ type: 'text', text: rendered.text }], isError: rendered.isError || undefined, waitedMs };
      }
      case 'screenshot': {
        const img = await env.screenshot();
        return { content: [{ type: 'image', mediaType: img.mediaType, data: img.data }] };
      }
      case 'propose_mod': {
        const p = input as Partial<ModProposal> & { untested_reason?: unknown };
        if (!p.name || !p.code || !Array.isArray(p.matches) || !p.matches.length) return err('name, code and at least one match pattern are required');
        const untestedReason = typeof p.untested_reason === 'string' && p.untested_reason.trim() ? p.untested_reason.trim() : undefined;
        const problem = checkProposal({ code: p.code, matches: p.matches, untestedReason }, ctx);
        if (problem) return err(problem);
        const proposal: ModProposal = {
          name: p.name,
          description: p.description ?? '',
          matches: p.matches,
          code: p.code,
          ...(untestedReason ? { untestedReason } : {}),
        };
        // A fresh proposal starts a fresh testing obligation: a revision written after this one has
        // to be run before it can be proposed in turn. This is unchanged by drafts: an EDIT to the
        // draft is still a proposal, and still has to have been run.
        ctx.testedSinceProposal = false;
        // The draft is versioned before the card is shown, so the panel never renders a proposal
        // whose version does not exist yet. A storage failure here is not the user's problem — the
        // proposal is still valid and still worth showing — so it degrades to an unversioned card.
        const version = onProposal ? await onProposal(proposal).catch(() => null) : null;
        emit({ type: 'proposal', proposal });
        if (version != null) emit({ type: 'artifact', version });
        return text(
          version == null
            ? 'The mod has been shown to the user with Try and Save buttons. Wait for their feedback.'
            : `The draft mod is now v${version} in the user's artifact panel, where they can try, save or roll it back. Wait for their feedback.`,
        );
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
