import { createProvider } from '../providers';
import { renderRunResult, type RunResult } from '../runscript';
import { DEFAULT_CONTEXT_BUDGET, type AgentEventBody, type ElementRef, type ModProposal, type Msg, type Part, type Settings, type UserTurn } from '../types';
import { MAX_ITERATIONS, countReads, readBudgetNudge, wrapUpNudge } from './budget';
import { compact, needsCompaction } from './compact';
import { SYSTEM_PROMPT } from './prompt';
import { checkProposal, type ProposalContext } from './propose';
import { TOOLS } from './tools';
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
} from './wait';

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
  turn: UserTurn;
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
}

function renderTurn(turn: UserTurn, page: { url: string; title: string } | null, injected: boolean): string {
  const lines: string[] = [];
  if (page) lines.push(`[Current page: ${page.title} — ${page.url}]`);
  for (const ref of turn.refs ?? []) {
    const html = ref.html.length > 2500 ? ref.html.slice(0, 2500) + '…' : ref.html;
    lines.push(`[@${ref.token} = ${ref.label} — selector: ${ref.selector}]`, html);
  }
  if (injected) lines.push('[The user sent this while you were working. Take it into account from here on.]');
  return `${lines.join('\n')}\n\n${turn.text}`.trim();
}

/** Drop a trailing assistant turn whose tool calls were never answered, so the history stays valid. */
function trimUnanswered(messages: Msg[]): Msg[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant' && last.content.some((p) => p.type === 'tool_call')) return messages.slice(0, -1);
  return messages;
}

export async function runAgent(input: AgentInput): Promise<Msg[]> {
  const { settings, env, emit, signal } = input;
  const provider = createProvider(settings);
  const messages: Msg[] = [...input.history];

  const page = await env.pageInfo().catch(() => null);
  messages.push({ role: 'user', content: [{ type: 'text', text: renderTurn(input.turn, page, false) }] });
  emit({ type: 'accepted', id: input.turn.id });

  try {
    await loop();
  } catch (e) {
    if (!signal.aborted) throw e;
  }
  return signal.aborted ? trimUnanswered(messages) : messages;

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
    const ctx: ProposalContext = { testedSinceProposal: false, userText: input.turn.text };
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
      emit({ type: 'status', phase: 'model', detail: i === 0 ? 'waiting for model' : 'continuing', iteration: i + 1 });
      const res = await provider.chat({
        system: SYSTEM_PROMPT,
        messages,
        tools: TOOLS,
        signal,
        callbacks: { onText: (delta) => emit({ type: 'text', delta }) },
      });
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
        const r = await executeTool(call.name, call.input, env, emit, ctx, signal);
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
        results.push({ type: 'text', text: renderTurn(q, null, true) });
        emit({ type: 'accepted', id: q.id });
      }
      messages.push({ role: 'user', content: results });
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
        // to be run before it can be proposed in turn.
        ctx.testedSinceProposal = false;
        emit({ type: 'proposal', proposal });
        return text('The mod has been shown to the user with Try and Save buttons. Wait for their feedback.');
      }
      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
