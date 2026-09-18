import { createProvider } from '../providers';
import type { AgentEvent, ModProposal, Msg, Part, PickedElement, Settings } from '../types';
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
  text: string;
  picked?: PickedElement;
  env: AgentEnv;
  emit: (e: AgentEvent) => void;
  signal: AbortSignal;
}

export async function runAgent(input: AgentInput): Promise<Msg[]> {
  const { settings, env, emit, signal } = input;
  const provider = createProvider(settings);
  const messages: Msg[] = [...input.history];

  const page = await env.pageInfo();
  const userParts: Part[] = [];
  const contextLines = [`[Current page: ${page.title} — ${page.url}]`];
  if (input.picked) {
    contextLines.push(`[User selected element: ${input.picked.selector}]`, input.picked.html);
  }
  userParts.push({ type: 'text', text: `${contextLines.join('\n')}\n\n${input.text}` });
  messages.push({ role: 'user', content: userParts });

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (signal.aborted) break;
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
      const r = await executeTool(call.name, call.input, env, emit);
      emit({ type: 'tool_result', id: call.id, summary: summarize(r.content), isError: !!r.isError });
      results.push({ type: 'tool_result', toolCallId: call.id, content: r.content, isError: r.isError });
      if (call.name === 'propose_mod' && !r.isError) proposed = true;
    }
    messages.push({ role: 'user', content: results });
    // A proposal ends the turn: the user decides what happens next.
    if (proposed) break;
  }
  return messages;
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
  emit: (e: AgentEvent) => void,
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
