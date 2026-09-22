// How much the model thinks before it answers, per chat, mapped onto each provider's own knob.
//
// Every backend usermods can reach has a reasoning control and no two of them spell it the same
// way. Anthropic has a thinking MODE (`thinking.type`) and, separately, a depth control that is not
// inside it (`output_config.effort`). The Responses API has `reasoning.effort`. chat/completions
// has `reasoning_effort` on OpenAI's own reasoning models, `chat_template_kwargs.enable_thinking`
// on some local servers, and nothing at all on the rest. The values do not line up either: one
// provider's floor is "none", another's is "low", and a third refuses to stop thinking at all.
//
// So the panel holds ONE neutral scale — ThinkingLevel — and this module is the only place that
// knows what each provider does with it. Two pure functions:
//
//   thinkingCapability(kind, model, ...)  which levels this model accepts, and what to call them
//   applyThinking(level, capability)      the request fields, ready to spread into a body
//
// Nothing here does I/O, touches the DOM or imports an adapter, so the whole mapping is unit
// tested under node (test/thinking.test.ts) against the documented request shapes.
//
// ---------------------------------------------------------------------------------------------
// Verified against current provider documentation (fetched 2026-09-22). Do not "fix" any of this
// from memory — every one of these rules is a 400 waiting to happen if it drifts.
//
//   Anthropic thinking modes and per-model support, with the exact rejection messages:
//     https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting#supported-models
//   Anthropic effort (top-level `output_config.effort`, values low|medium|high|xhigh|max):
//     https://platform.claude.com/docs/en/build-with-claude/effort
//   Anthropic extended thinking (legacy `thinking.type: "enabled"` + `budget_tokens`):
//     https://platform.claude.com/docs/en/build-with-claude/extended-thinking
//   Anthropic thinking + prompt caching (what invalidates a cached prefix):
//     https://platform.claude.com/docs/en/build-with-claude/thinking#thinking-and-prompt-caching
//   OpenAI reasoning (`reasoning.effort` / `reasoning_effort`, none|minimal|low|medium|high|xhigh|max):
//     https://developers.openai.com/api/docs/guides/reasoning
//   xAI reasoning (`reasoning_effort` low|medium|high|xhigh; reasoning cannot be disabled):
//     https://docs.x.ai/docs/guides/reasoning
//   llama.cpp server (`reasoning_effort`: "none" disables; also `chat_template_kwargs`):
//     https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
//   vLLM reasoning outputs (`chat_template_kwargs: {enable_thinking}`, and `reasoning_effort`):
//     https://docs.vllm.ai/en/latest/features/reasoning_outputs.html
//   Ollama OpenAI compatibility (`reasoning_effort` high|medium|low|max|none):
//     https://docs.ollama.com/api/openai-compatibility
// ---------------------------------------------------------------------------------------------
import type { ProviderKind } from './types';

/**
 * The neutral scale, as stored on a chat.
 *
 * 'default' is not a level: it means "send nothing, whatever the adapter did before". That is what
 * makes this feature invisible until the user touches it — an existing chat, and every new one,
 * behaves exactly as it did before this module existed.
 */
export type ThinkingLevel = 'default' | 'off' | 'low' | 'medium' | 'high' | 'max';

/** Every level in the order the picker shows them. 'default' first, then least to most thinking. */
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['default', 'off', 'low', 'medium', 'high', 'max'];

/** A stored value from an older build, or a corrupt one, reads as the default. */
export function resolveThinkingLevel(value: unknown): ThinkingLevel {
  return typeof value === 'string' && (THINKING_LEVELS as readonly string[]).includes(value) ? (value as ThinkingLevel) : 'default';
}

/** What the picker calls each level. */
export function thinkingLabel(level: ThinkingLevel): string {
  switch (level) {
    case 'default':
      return 'Default';
    case 'off':
      return 'Off';
    case 'low':
      return 'Low';
    case 'medium':
      return 'Medium';
    case 'high':
      return 'High';
    case 'max':
      return 'Max';
  }
}

/**
 * How a backend takes the level, once a model has been matched to a rule.
 *
 *   'anthropic-effort'  adaptive thinking + top-level output_config.effort (Claude 4.6 and later)
 *   'anthropic-budget'  legacy extended thinking, thinking.type "enabled" + budget_tokens
 *   'responses-effort'  Responses API reasoning.effort
 *   'chat-effort'       chat/completions reasoning_effort
 *   'chat-template'     chat/completions chat_template_kwargs.enable_thinking (local servers)
 *   'none'              this model takes no reasoning field at all; the row is hidden
 */
export type ThinkingStyle = 'anthropic-effort' | 'anthropic-budget' | 'responses-effort' | 'chat-effort' | 'chat-template' | 'none';

export interface ThinkingCapability {
  style: ThinkingStyle;
  /** The levels the picker offers, always including 'default' first. Length 1 means "hide the row". */
  levels: ThinkingLevel[];
}

/** A capability that offers nothing: the row is not drawn at all. */
const NO_THINKING: ThinkingCapability = { style: 'none', levels: ['default'] };

/** Whether a model supports any level beyond 'default' — i.e. whether to draw the row. */
export function supportsThinking(cap: ThinkingCapability): boolean {
  return cap.levels.length > 1;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

/**
 * Models that take adaptive thinking, and with it `output_config.effort`.
 *
 * Kept identical to ADAPTIVE_THINKING in lib/providers/anthropic.ts, which decides whether to send
 * `thinking: {type: 'adaptive'}` at all. The two must agree: sending effort to a model that only
 * understands budget_tokens is a different request shape, not a stronger one.
 *
 * Per the support table, adaptive thinking is on Claude 4.6 and later (Opus/Sonnet 4.6, Opus 4.7,
 * Opus 4.8, Opus 5, Sonnet 5, Fable 5/5.1, Mythos 5/5.1). Claude 4.5 and earlier — Opus 4.5,
 * Sonnet 4.5, Haiku 4.5 — reject `"adaptive"` with a 400 and use budget_tokens instead.
 */
const ANTHROPIC_ADAPTIVE = /(opus-5|sonnet-5|fable-5|mythos-5|mythos-preview|opus-4-[678]|sonnet-4-6)/;

/**
 * Models where thinking cannot be turned off, so 'off' is not offered.
 *
 * The support table marks these "Always on": `thinking: {type: "disabled"}` is a 400 on Fable 5,
 * Fable 5.1, Mythos 5, Mythos 5.1 and Mythos Preview. Opus 5 and Sonnet 5 accept "disabled" (Opus 5
 * only at effort high or below, which is why 'off' never rides along with a raised effort — see
 * applyThinking).
 */
const ANTHROPIC_ALWAYS_THINKS = /(fable-5|mythos-5|mythos-preview)/;

/**
 * Anthropic's effort ladder as the neutral scale maps onto it.
 *
 * 'high' is the API default, so our 'high' sends nothing new and 'max' is the real step up. 'medium'
 * and 'low' are token-saving steps down. We deliberately do not expose 'xhigh': it sits between
 * high and max, and a six-value scale that has to mean something on five other backends is worse
 * than one that reads the same everywhere.
 */
const ANTHROPIC_EFFORT: Partial<Record<ThinkingLevel, string>> = { low: 'low', medium: 'medium', high: 'high', max: 'max' };

// ---------------------------------------------------------------------------
// OpenAI-compatible: which field, if any
// ---------------------------------------------------------------------------

/**
 * What a connection says its chat/completions endpoint takes. 'auto' guesses from the model id,
 * which is all an endpoint typed into a box can be asked; the explicit choices are for the servers
 * the guess gets wrong.
 */
export type ReasoningField = 'auto' | 'reasoning_effort' | 'enable_thinking' | 'none';

/** A stored value from an older build, or a corrupt one, reads as the default. */
export function resolveReasoningField(value: unknown): ReasoningField {
  return value === 'reasoning_effort' || value === 'enable_thinking' || value === 'none' ? value : 'auto';
}

/**
 * OpenAI's own reasoning models on chat/completions: the o-series and the GPT-5 family and later,
 * which take `reasoning_effort`. A plain gpt-4o takes no reasoning field and answers 400 to one.
 */
const OPENAI_REASONING_MODEL = /(^|[/:-])(o[1-4]|gpt-[5-9])(\b|[.-])/i;

/**
 * Models whose thinking is switched through the chat template rather than an effort value: the
 * Qwen 3 family, served by llama.cpp, vLLM or an OpenAI-compatible wrapper, where the documented
 * control is `chat_template_kwargs: {enable_thinking: bool}`. It is a boolean, so the scale
 * collapses to off/on rather than a ladder.
 */
const TEMPLATE_THINKING_MODEL = /qwen-?3/i;

/**
 * Which reasoning field an OpenAI-compatible model takes, when the connection says 'auto'.
 *
 * Deliberately conservative: an id nothing recognises gets NO field. The cost of guessing wrong in
 * the other direction is a 400 on every request to a server the user configured by hand, and the
 * whole point of the explicit setting beside this is that a guess is not always possible.
 */
export function guessReasoningField(model: string): ReasoningField {
  const m = (model || '').trim();
  if (!m) return 'none';
  if (TEMPLATE_THINKING_MODEL.test(m)) return 'enable_thinking';
  if (OPENAI_REASONING_MODEL.test(m)) return 'reasoning_effort';
  return 'none';
}

// ---------------------------------------------------------------------------
// xAI
// ---------------------------------------------------------------------------

/**
 * Effort-capable xAI models. Mirrors xaiSupportsReasoning in lib/providers/index.ts, which already
 * knows that the "non-reasoning" and "-fast" variants reject the field outright.
 *
 * xAI's guide is explicit that on the models that DO take it, "reasoning cannot be disabled", so
 * 'off' is never offered for xAI even though every other effort backend has some way to stop.
 */
export function xaiSupportsReasoning(model: string): boolean {
  return !/non-reasoning|fast$/.test(model);
}

// ---------------------------------------------------------------------------
// The capability table
// ---------------------------------------------------------------------------

export interface CapabilityInput {
  kind: ProviderKind;
  model: string;
  /** The connection's Reasoning field setting. Only consulted for 'openai-compatible'. */
  reasoningField?: ReasoningField;
}

/**
 * Which levels this model accepts, and how they are spelled on the wire.
 *
 * Pure, and the single source of truth for both halves of the feature: the picker draws exactly the
 * levels this returns, and applyThinking maps exactly those levels onto fields. A level that is not
 * in `levels` can never reach a request, which is what keeps a model from being sent a field it
 * rejects even if a stale chat still holds the old value.
 */
export function thinkingCapability({ kind, model, reasoningField = 'auto' }: CapabilityInput): ThinkingCapability {
  const m = (model || '').trim();
  switch (kind) {
    case 'anthropic': {
      if (ANTHROPIC_ADAPTIVE.test(m)) {
        // Adaptive thinking plus output_config.effort. 'off' only where "disabled" is accepted.
        const canDisable = !ANTHROPIC_ALWAYS_THINKS.test(m);
        return {
          style: 'anthropic-effort',
          levels: ['default', ...(canDisable ? (['off'] as ThinkingLevel[]) : []), 'low', 'medium', 'high', 'max'],
        };
      }
      if (!m) return NO_THINKING;
      // Everything else Anthropic serves is an extended-thinking model: budget_tokens, and no
      // effort parameter it would accept. Off is simply not sending a thinking block.
      return {
        style: 'anthropic-budget',
        levels: ['default', 'off', 'low', 'medium', 'high'],
      };
    }
    case 'chatgpt':
      return {
        style: 'responses-effort',
        levels: ['default', 'off', 'low', 'medium', 'high'],
      };
    case 'xai':
      // The -fast and non-reasoning variants reject the field entirely; the rest cannot stop.
      return xaiSupportsReasoning(m)
        ? { style: 'responses-effort', levels: ['default', 'low', 'medium', 'high'] }
        : NO_THINKING;
    case 'openai-compatible': {
      const field = reasoningField === 'auto' ? guessReasoningField(m) : reasoningField;
      if (field === 'reasoning_effort') {
        return {
          style: 'chat-effort',
          levels: ['default', 'off', 'low', 'medium', 'high'],
        };
      }
      if (field === 'enable_thinking') {
        // A boolean in the chat template: there is no ladder to climb, only on and off.
        return {
          style: 'chat-template',
          levels: ['default', 'off', 'high'],
        };
      }
      return NO_THINKING;
    }
  }
}

// ---------------------------------------------------------------------------
// The request fields
// ---------------------------------------------------------------------------

/**
 * What applyThinking produces. Split by where it goes, because the two Anthropic fields are
 * top-level siblings and the chat/completions ones are too — a caller spreads whichever it needs
 * and never has to know which provider it is talking to.
 */
export interface ThinkingRequest {
  /** Top-level fields to merge into the request body. */
  body: Record<string, unknown>;
  /**
   * Anthropic only: the `thinking` field, when this level changes it from what the adapter would
   * send anyway. Kept apart from `body` so the adapter can decide the default mode itself.
   */
  thinking?: Record<string, unknown>;
}

const EMPTY: ThinkingRequest = { body: {} };

/**
 * Thinking token budgets for the legacy extended-thinking models.
 *
 * The documented floor is 1024 ("Minimum of 1,024 tokens. The API rejects smaller values") and the
 * budget must stay below max_tokens, which this adapter sets to 16000 — so 'high' is 12000 rather
 * than something that would leave no room for the answer.
 */
const ANTHROPIC_BUDGET: Partial<Record<ThinkingLevel, number>> = { low: 1024, medium: 4000, high: 12000 };

/**
 * Effort values for the Responses API and for chat/completions `reasoning_effort`.
 *
 * 'off' is 'none', which OpenAI documents as the way to answer without a reasoning pass. It is
 * offered only where the capability table already allows 'off', so a backend that rejects 'none'
 * (xAI, GPT-6 Astra) never sees it.
 */
const EFFORT: Partial<Record<ThinkingLevel, string>> = { off: 'none', low: 'low', medium: 'medium', high: 'high', max: 'high' };

/**
 * The request fields for one level on one model.
 *
 * 'default' always produces nothing at all, which is the property that makes this feature additive:
 * a chat nobody has touched sends byte-for-byte the request it sent before. A level the capability
 * does not list produces nothing either — the belt to the picker's braces, so a stale stored level
 * cannot put a rejected field on the wire.
 */
export function applyThinking(level: ThinkingLevel, cap: ThinkingCapability): ThinkingRequest {
  if (level === 'default' || !cap.levels.includes(level)) return EMPTY;
  switch (cap.style) {
    case 'anthropic-effort': {
      // The two controls are separate parameters, not one nested object: the mode is `thinking`,
      // the depth is top-level `output_config.effort`. Opus 5 rejects thinking "disabled" combined
      // with effort xhigh/max, which cannot arise here because 'off' sends no effort at all.
      if (level === 'off') return { body: {}, thinking: { type: 'disabled' } };
      const effort = ANTHROPIC_EFFORT[level];
      return effort ? { body: { output_config: { effort } } } : EMPTY;
    }
    case 'anthropic-budget': {
      // No effort parameter on these models; the depth IS the budget. 'off' means send no thinking.
      if (level === 'off') return { body: {}, thinking: { type: 'disabled' } };
      const budget = ANTHROPIC_BUDGET[level];
      return budget ? { body: {}, thinking: { type: 'enabled', budget_tokens: budget } } : EMPTY;
    }
    case 'responses-effort': {
      const effort = EFFORT[level];
      return effort ? { body: { reasoning: { effort } } } : EMPTY;
    }
    case 'chat-effort': {
      const effort = EFFORT[level];
      return effort ? { body: { reasoning_effort: effort } } : EMPTY;
    }
    case 'chat-template':
      // A boolean switch, so only the ends of the scale mean anything here.
      return { body: { chat_template_kwargs: { enable_thinking: level !== 'off' } } };
    case 'none':
      return EMPTY;
  }
}

/**
 * The cheapest level a model will accept, for the calls the user did not ask for: chat titles and
 * compaction summaries. Both are short, mechanical, one-shot calls whose quality does not improve
 * with reasoning, and both are billed to the user, so they always run at the floor regardless of
 * what the chat is set to.
 *
 * 'off' where the model allows it, otherwise the lowest level it does allow, otherwise 'default'
 * (a model with no reasoning knob has nothing to turn down).
 */
export function lowestThinkingLevel(cap: ThinkingCapability): ThinkingLevel {
  for (const level of ['off', 'low', 'medium', 'high'] as ThinkingLevel[]) {
    if (cap.levels.includes(level)) return level;
  }
  return 'default';
}

// ---------------------------------------------------------------------------
// Custom request fields
// ---------------------------------------------------------------------------

/** The most a "Custom request fields" box may hold. Long enough for a few knobs, short enough that
 *  a pasted transcript is rejected rather than sent to a server on every request. */
export const CUSTOM_FIELDS_MAX = 2000;

export interface CustomFieldsResult {
  ok: boolean;
  /** The parsed object when ok; an empty object otherwise. */
  fields: Record<string, unknown>;
  /** What the settings field says under the box when it is not ok. */
  error: string;
}

/**
 * Validate the per-connection "Custom request fields" JSON.
 *
 * It is merged into the request body, so it has to be a JSON OBJECT — an array or a bare number
 * cannot be spread into one — and it is rejected rather than silently dropped, because a server
 * that needed a field and did not get it fails in a way nobody can read.
 */
export function parseCustomFields(raw: string): CustomFieldsResult {
  const text = (raw ?? '').trim();
  if (!text) return { ok: true, fields: {}, error: '' };
  if (text.length > CUSTOM_FIELDS_MAX) return { ok: false, fields: {}, error: `Too long (limit ${CUSTOM_FIELDS_MAX} characters).` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, fields: {}, error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, fields: {}, error: 'Must be a JSON object, e.g. {"reasoning_effort": "low"}.' };
  }
  return { ok: true, fields: parsed as Record<string, unknown>, error: '' };
}

// ---------------------------------------------------------------------------
// When a server refuses the field
// ---------------------------------------------------------------------------

/**
 * Phrases a chat/completions server uses when the thing it objected to was the REASONING FIELD.
 *
 * Same shape of problem as lib/providers/vision.ts, and the same conservative rule: a phrase earns
 * a place here only if it names the reasoning parameter itself. A context-length error, a bad tool
 * schema or a bare "invalid request" is NOT a reasoning rejection, even though all three arrive as
 * a 400 on a request that happened to carry one — treating them as one would silently drop the
 * user's chosen level and never put it back.
 */
const REASONING_REJECTION = [
  // "Unrecognized request argument supplied: reasoning_effort" — OpenAI's wording for a field a
  // non-reasoning model does not take.
  /\b(?:unrecognized|unknown|unsupported|unexpected|invalid|extra)\b[^.?!]{0,60}?\b(?:reasoning_effort|reasoning|chat_template_kwargs|enable_thinking)\b/i,
  /\b(?:reasoning_effort|reasoning|chat_template_kwargs|enable_thinking)\b[^.?!]{0,80}?\b(?:is not|isn't|not)\b[^.?!]{0,40}?\b(?:supported|permitted|allowed|recognized|recognised|valid|expected)\b/i,
  // "does not support reasoning_effort"
  /\b(?:not|no|doesn't|does not|cannot|can't|unable to)\b[^.?!]{0,60}?\bsupport[a-z]*\b[^.?!]{0,40}?\b(?:reasoning_effort|reasoning|thinking|enable_thinking)\b/i,
  // vLLM / llama.cpp rejecting a template kwarg the model's template has no slot for.
  /\bchat_template_kwargs\b[^.?!]{0,80}?\b(?:error|invalid|unknown|failed)\b/i,
  // Pydantic-style "extra fields not permitted", named.
  /\bextra\s+(?:fields?|inputs?)\b[^.?!]{0,40}?\bnot\s+permitted\b/i,
] as const;

/**
 * Did this 400 mean "I do not take a reasoning field", as opposed to anything else that can fail?
 *
 * Same two conditions as isVisionRejection: the request must actually have carried the field (the
 * caller knows; the message does not), and the status must be a 4xx the server chose — not a 5xx,
 * not a rate limit — whose body names the reasoning parameter.
 */
export function isReasoningRejection(status: number | undefined, body: string | undefined): boolean {
  if (typeof status !== 'number' || status < 400 || status >= 500 || status === 413 || status === 429) return false;
  const text = (body ?? '').slice(0, 4000);
  if (!text) return false;
  return REASONING_REJECTION.some((re) => re.test(text));
}

/** Where the set of endpoints known to refuse a reasoning field lives in chrome.storage.local. */
export const THINKING_STORAGE_KEY = 'thinking:unsupported';

/**
 * The key one endpoint+model is remembered under. Same construction as visionKey — both halves
 * matter, because one server hosts a reasoning model and a plain one at the same base URL.
 */
export function thinkingKey(baseUrl: string, model: string): string {
  return `${(baseUrl || '').replace(/\/+$/, '').toLowerCase()}|${(model || '').trim()}`;
}

/** The one-line note the panel shows the first time a server refuses the reasoning field. */
export const THINKING_FALLBACK_PANEL_NOTE =
  'This endpoint does not accept a reasoning setting, so the request was sent again without it. usermods will leave it out for this model from now on; set Reasoning field under the provider in Settings to choose explicitly.';

/**
 * The store, as the adapter needs it. An object rather than chrome.storage directly, so the policy
 * is testable in node and a storage failure is the store's problem. Mirrors VisionMemory.
 */
export interface ThinkingMemory {
  /** Has this endpoint+model already refused the field? Never throws; unknown reads as false. */
  isUnsupported(key: string): Promise<boolean>;
  /** Remember that it did. Never throws. */
  markUnsupported(key: string): Promise<void>;
}

/** A memory that remembers nothing. The default for a provider created without one (tests). */
export const NO_THINKING_MEMORY: ThinkingMemory = {
  isUnsupported: async () => false,
  markUnsupported: async () => {},
};

/**
 * The real store, over chrome.storage.local. A read that fails reads as "not known to be
 * unsupported", so we try and find out; a write that fails costs one more fallback next time.
 * Neither is worth failing a chat over. See createVisionMemory, which this mirrors.
 */
export function createThinkingMemory(): ThinkingMemory {
  let cache: Set<string> | null = null;

  const load = async (): Promise<Set<string>> => {
    if (cache) return cache;
    try {
      const r = await chrome.storage.local.get(THINKING_STORAGE_KEY);
      const raw = r[THINKING_STORAGE_KEY];
      cache = new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
    } catch {
      cache = new Set();
    }
    return cache;
  };

  return {
    async isUnsupported(key) {
      return (await load()).has(key);
    },
    async markUnsupported(key) {
      const set = await load();
      if (set.has(key)) return;
      set.add(key);
      try {
        await chrome.storage.local.set({ [THINKING_STORAGE_KEY]: [...set] });
      } catch {
        /* remembered for this worker's lifetime at least */
      }
    },
  };
}
