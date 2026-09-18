import { createProvider } from '../providers';
import type { AgentEventBody, ElementRef, ModProposal, Msg, Part, Settings, UserTurn } from '../types';
import { SYSTEM_PROMPT } from './prompt';
import { TOOLS } from './tools';

const MAX_ITERATIONS = 30;

/** Everything a tool needs from the browser. Implemented in the background worker. */
export interface AgentEnv {
  sendToContent<T = unknown>(req: unknown): Promise<T>;
  runScript(code: string): Promise<{ ok: boolean; result?: string; logs: string[]; error?: string }>;
  screenshot(): Promise<{ mediaType: 'image/jpeg' | 'image/png'; data: string }>;
  pageInfo(): Promise<{ url: string; title: string }>;
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

  async function loop() {
  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) break;
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
      break;
    }
    if (res.stopReason === 'refusal') {
      emit({ type: 'error', message: 'The model declined this request.' });
      break;
    }
    if (!calls.length) break;

    const results: Part[] = [];
    let proposed = false;
    for (const call of calls) {
      emit({ type: 'tool_call', id: call.id, name: call.name, input: call.input });
      emit({ type: 'status', phase: 'tool', tool: call.name, detail: describeCall(call.name, call.input), iteration: i + 1 });
      const r = await executeTool(call.name, call.input, env, emit);
      emit({ type: 'tool_result', id: call.id, summary: summarize(r.content), isError: !!r.isError });
      results.push({ type: 'tool_result', toolCallId: call.id, content: r.content, isError: r.isError });
      if (call.name === 'propose_mod' && !r.isError) proposed = true;
    }
    // Anything the user typed meanwhile joins this message, after the tool results.
    const queued = signal.aborted ? [] : input.pullQueued();
    for (const q of queued) {
      results.push({ type: 'text', text: renderTurn(q, null, true) });
      emit({ type: 'accepted', id: q.id });
    }
    messages.push({ role: 'user', content: results });
    if (signal.aborted) break;
    // A proposal ends the turn: the user decides what happens next.
    if (proposed && !queued.length) break;
  }
  }
}

/**
 * The human half of a tool's status line: what a person would say the agent is doing. run_script
 * carries its own description; the page-inspection tools are best described by what they look at.
 */
function describeCall(name: string, input: Record<string, unknown>): string | undefined {
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

function text(s: string): { content: Part[]; isError?: boolean } {
  return { content: [{ type: 'text', text: s }] };
}
function err(s: string): { content: Part[]; isError: true } {
  return { content: [{ type: 'text', text: s }], isError: true };
}

async function executeTool(
  name: string,
  input: Record<string, unknown>,
  env: AgentEnv,
  emit: (e: AgentEventBody) => void,
): Promise<{ content: Part[]; isError?: boolean }> {
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
        const r = await env.runScript(input.code);
        const lines: string[] = [];
        if (r.ok) lines.push(`Result: ${r.result ?? 'undefined'}`);
        else lines.push(`Error: ${r.error}`);
        if (r.logs.length) lines.push('Console:', ...r.logs.slice(-50));
        return r.ok ? text(lines.join('\n')) : err(lines.join('\n'));
      }
      case 'screenshot': {
        const img = await env.screenshot();
        return { content: [{ type: 'image', mediaType: img.mediaType, data: img.data }] };
      }
      case 'propose_mod': {
        const p = input as Partial<ModProposal>;
        if (!p.name || !p.code || !Array.isArray(p.matches) || !p.matches.length) return err('name, code and at least one match pattern are required');
        const proposal: ModProposal = { name: p.name, description: p.description ?? '', matches: p.matches, code: p.code };
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
