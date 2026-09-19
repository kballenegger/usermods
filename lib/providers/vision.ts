// Whether an OpenAI-compatible backend will take a picture, and what to do when it will not.
//
// The Anthropic Messages API and the Responses API both accept images from every model the panel
// can reach, so this file is about ONE adapter: lib/providers/openai.ts, which is pointed at
// whatever the user typed into Base URL. That endpoint might be GPT-5, might be a 4B text-only
// model on a laptop, and the wire protocol has no way to ask. There is no capabilities endpoint,
// `/v1/models` returns bare ids, and the only honest signal any of them give is a 400 on the first
// request that carries an `image_url` part.
//
// So the policy is: try, read the refusal, remember it, and never pay for it twice.
//
//   Send  — always attach images. For a backend you know is vision-capable.
//   Never — never attach; the model is told in words what it would have seen.
//   Auto  — attach, and if the endpoint refuses IMAGES SPECIFICALLY, re-send that same request
//           once with the images replaced by text, and remember this endpoint+model for next time.
//
// Nothing here touches the DOM or fetch. The storage half is behind an injectable interface so
// `npm test` exercises the whole policy under node.

/** What the Images setting can be. `auto` is the default, and the one that learns. */
export type ImagesSetting = 'auto' | 'send' | 'never';

/** A stored value that predates the setting, or a corrupt one, reads as the default. */
export function resolveImagesSetting(value: unknown): ImagesSetting {
  return value === 'send' || value === 'never' ? value : 'auto';
}

// ---------------------------------------------------------------------------
// What the model is told in place of a picture
// ---------------------------------------------------------------------------
//
// These three strings go into a `tool` message's text or a user message's text, so they are read
// by the model, not by the user. Each says something different and the difference matters: a model
// told "the image is in the next message" will look for it, and a model told "this model cannot
// see images" should stop taking screenshots rather than take another one hoping for better luck.

/** Tool-result text when the image IS being sent, in the user message that follows. */
export const IMAGE_FORWARDED_NOTE = '[screenshot attached in the next message]';

/**
 * Tool-result text when the configured model cannot accept images at all.
 *
 * It is deliberately a whole sentence of steering rather than a bare "[image omitted]". A model
 * that is only told the picture is missing will take another screenshot; a model that is told the
 * backend cannot show it one, and what to use instead, goes and reads the DOM. That is the
 * difference between a wasted step budget and a run that finishes.
 */
export const IMAGE_UNSUPPORTED_NOTE =
  '[screenshot not sent: the configured model does not accept images. Do not take more screenshots in this chat — check the result with get_styles, find_elements or get_page instead.]';

/** User-message text when an image the USER attached could not be sent. */
export const ATTACHMENT_UNSUPPORTED_NOTE =
  '[attached image not sent: the configured model does not accept images. Ask the user to describe it, or work from the page itself.]';

/** What the panel says, in the transcript, when a user attachment was not sent. */
export const ATTACHMENT_DROPPED_PANEL_NOTE =
  'The model at this endpoint does not accept images, so your attachment was not sent — only your text was. Switch to a vision model, or set Images to Send in Settings to try anyway.';

/** The one-line note the panel shows the first time Auto discovers a text-only backend. */
export const VISION_FALLBACK_PANEL_NOTE =
  'This model does not accept images, so the request was sent again without them. usermods will leave images out for this endpoint from now on; change that under Images in Settings.';

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

/**
 * Phrases a backend uses when the thing it objected to was the PICTURE.
 *
 * Every one of these was taken from a real refusal: llama.cpp and Ollama say "does not support
 * images"; vLLM raises on "multimodal"; LM Studio says "vision"; OpenAI itself answers an
 * image_url part sent to a text-only model with "Invalid content type. image_url is only supported
 * by certain models."; OpenRouter passes the upstream words through and adds "no endpoints found
 * that support image input".
 *
 * Conservative on purpose. The cost of a false positive is silently degrading a vision model to
 * text — the exact bug this file exists to fix, wearing a different hat — so a phrase only earns a
 * place here if it names an image, a vision capability or a multimodal input. A bare "invalid
 * request", a context-length error or a refused tool schema is NOT a vision rejection, even though
 * all three arrive as a 400 on a request that happened to carry an image.
 */
const VISION_REJECTION = [
  // "…does not support images", "image input is not supported", "unsupported image input"
  /\b(?:image|images|image[_ -]?url|image[_ -]?input|vision|multi[_ -]?modal|multimodal)\b[^.?!]{0,80}?\b(?:not|isn't|cannot|can't|un)[a-z]*\s*support/i,
  /\b(?:not|no|doesn't|does not|cannot|can't|unable to)\b[^.?!]{0,80}?\bsupport[a-z]*\b[^.?!]{0,40}?\b(?:image|images|image[_ -]?url|image[_ -]?input|vision|multi[_ -]?modal|multimodal)\b/i,
  // OpenAI's own wording for an image part sent to a text-only model.
  /image[_ -]?url\b[^.?!]{0,80}?\bonly supported by certain models/i,
  // OpenRouter, routing a request no upstream can take.
  /no endpoints found that support image input/i,
  // llama.cpp / older Ollama builds, which answer with the model's own limitation.
  /\b(?:model|this model|the model)\b[^.?!]{0,60}?\b(?:is not|isn't)\b[^.?!]{0,30}?\b(?:multi[_ -]?modal|multimodal|vision)\b/i,
  // A content-part type the server does not know at all, named explicitly.
  /\b(?:invalid|unknown|unsupported|unrecognized|unrecognised)\b[^.?!]{0,40}?\b(?:content|part|type)\b[^.?!]{0,40}?\bimage[_ -]?url\b/i,
  /\bimage[_ -]?url\b[^.?!]{0,40}?\b(?:invalid|unknown|unsupported|unrecognized|unrecognised|not a valid)\b/i,
] as const;

/**
 * Did this failure mean "I will not take a picture", as opposed to anything else that can go wrong?
 *
 * Two conditions, both required:
 *   1. the request carried at least one image (the caller knows; the message does not say), and
 *   2. the status is a 4xx the server chose — not a 5xx, not a timeout, not a rate limit — whose
 *      body names images, vision or multimodal input as the problem.
 *
 * 413 is deliberately excluded even though it is a 4xx an image can cause: "payload too large" is
 * about the size of this particular picture, not about whether the model has eyes, and remembering
 * the endpoint as blind because one screenshot was too big would be wrong.
 */
export function isVisionRejection(status: number | undefined, body: string | undefined): boolean {
  if (typeof status !== 'number' || status < 400 || status >= 500 || status === 413 || status === 429) return false;
  const text = (body ?? '').slice(0, 4000);
  if (!text) return false;
  return VISION_REJECTION.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Remembering
// ---------------------------------------------------------------------------

/**
 * The key one endpoint+model is remembered under.
 *
 * Both halves matter: the same Ollama server hosts a vision model and a text-only one at the same
 * base URL, and the same model id behind two proxies can be two different deployments. The base
 * URL is normalised the way the adapter normalises it (trailing slashes stripped, lower-cased) so
 * "http://localhost:1234/v1/" and "http://localhost:1234/v1" are one endpoint and not two.
 */
export function visionKey(baseUrl: string, model: string): string {
  return `${(baseUrl || '').replace(/\/+$/, '').toLowerCase()}|${(model || '').trim()}`;
}

/**
 * The default an empty Base URL means for the OpenAI-compatible adapter. Exported so the key the
 * adapter writes and the key the background reads are computed from the same value: two spellings
 * of "the default endpoint" would be two entries, and the second one would never be found.
 */
export const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

/** The key for a settings profile, as both the adapter and the background compute it. */
export function visionKeyFor(settings: { baseUrl?: string; model?: string }): string {
  return visionKey(settings.baseUrl || DEFAULT_OPENAI_BASE, settings.model ?? '');
}

/** Where the set of known-blind endpoints lives in chrome.storage.local. */
export const VISION_STORAGE_KEY = 'vision:unsupported';

/**
 * The store, as the adapter needs it. An object rather than chrome.storage directly so the policy
 * is testable in node and so a storage failure is the store's problem, not the adapter's.
 */
export interface VisionMemory {
  /** Has this endpoint+model already refused an image? Never throws; unknown reads as false. */
  isUnsupported(key: string): Promise<boolean>;
  /** Remember that it did. Never throws. */
  markUnsupported(key: string): Promise<void>;
  /**
   * The same answer without awaiting, for callers that cannot: the agent loop builds its tool list
   * synchronously between steps. It reads only what has already been loaded, so it is false until
   * the first `isUnsupported` has resolved — which is exactly the right bias, because the tool list
   * it feeds should describe `screenshot` as working until something proves otherwise.
   */
  isUnsupportedNow(key: string): boolean;
}

/** A memory that remembers nothing. The default for a provider created without one (tests). */
export const NO_VISION_MEMORY: VisionMemory = {
  isUnsupported: async () => false,
  markUnsupported: async () => {},
  isUnsupportedNow: () => false,
};

/**
 * The real store, over chrome.storage.local.
 *
 * A read that fails reads as "not known to be unsupported", i.e. we try and find out, which is the
 * behaviour that recovers on its own. A write that fails is dropped: the worst case is that the
 * next request pays for one more fallback, which is exactly what happened before it was remembered
 * at all. Neither is worth failing a chat over.
 *
 * The in-memory cache is not an optimisation, it is what makes the decision stable within one
 * service-worker lifetime: two runs in flight at once must not each conclude separately.
 */
export function createVisionMemory(): VisionMemory {
  let cache: Set<string> | null = null;

  const load = async (): Promise<Set<string>> => {
    if (cache) return cache;
    try {
      const r = await chrome.storage.local.get(VISION_STORAGE_KEY);
      const raw = r[VISION_STORAGE_KEY];
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
    isUnsupportedNow(key) {
      // Deliberately does not trigger a load: a synchronous caller cannot wait for one, and a
      // background load started here would race with the awaited path for no benefit.
      return cache?.has(key) ?? false;
    },
    async markUnsupported(key) {
      const set = await load();
      if (set.has(key)) return;
      set.add(key);
      try {
        await chrome.storage.local.set({ [VISION_STORAGE_KEY]: [...set] });
      } catch {
        /* remembered for this worker's lifetime at least */
      }
    },
  };
}

/**
 * Whether THIS request should carry images, given the setting and what we have learned.
 *
 * Split out from the adapter so the decision is one testable function rather than a condition
 * buried in a fetch. `never` short-circuits before the store is even consulted.
 */
export async function shouldSendImages(setting: ImagesSetting, key: string, memory: VisionMemory): Promise<boolean> {
  if (setting === 'never') return false;
  if (setting === 'send') return true;
  return !(await memory.isUnsupported(key));
}
