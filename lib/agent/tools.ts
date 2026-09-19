import type { ToolDef } from '../types';
// The .ts extension is needed because this is a VALUE import and `npm test` loads these files
// under node --experimental-strip-types, whose resolver does not guess extensions. tsconfig sets
// allowImportingTsExtensions, so tsc and vite take it as written.
import { MAX_QUIET_MS, MAX_SLEEP_MS, MAX_TIMEOUT_MS, MIN_QUIET_MS } from './wait.ts';

/**
 * The condition half of wait_for, shared verbatim with run_script's `then_wait` so the model
 * learns one shape and can move it between the two tools without re-reading a schema.
 *
 * `additionalProperties: false` matters more here than usual: the whole point of the tool is that
 * the model states ONE thing to wait for, and a provider that silently accepts a stray key would
 * let `{selector: '.a', url: '/b'}` through to a validator that then refuses it — a wasted step
 * for a mistake the schema can prevent.
 */
const WAIT_CONDITION_PROPERTIES = {
  selector: { type: 'string', description: 'CSS selector to wait for. Combine with state/count/text.' },
  state: {
    type: 'string',
    enum: ['attached', 'visible', 'hidden', 'detached'],
    description: 'With selector. Default "visible". "visible" = in the DOM, non-zero box, not display:none/visibility:hidden/opacity:0. Scrolling into view is not required.',
  },
  count: { type: 'integer', description: 'With selector: wait until at least this many elements match. Default 1.' },
  text: {
    type: 'string',
    description: 'With selector: only count elements whose text contains this (case-insensitive). On its own: wait for this visible text to appear anywhere on the page.',
  },
  gone: { type: 'boolean', description: 'With text on its own: wait for that text to DISAPPEAR instead of appear.' },
  url: { type: 'string', description: 'Wait until the tab URL contains this substring, or matches this /regex/. Covers SPA route changes and real navigations.' },
  load: { type: 'string', enum: ['domcontentloaded', 'complete'], description: 'Wait until the tab finishes a navigation to this readiness.' },
  idle: { type: 'boolean', description: 'Wait until the DOM has had no mutations for quiet_ms. Use for "wait until it stops changing".' },
  quiet_ms: { type: 'integer', description: `With idle: the quiet window. Default 500, ${MIN_QUIET_MS}..${MAX_QUIET_MS}.` },
  ms: { type: 'integer', description: `A plain delay, capped at ${MAX_SLEEP_MS}. Last resort: prefer a selector or text condition, which returns as soon as it is true.` },
} as const;

/** What `screenshot` says when the model can actually see what it returns. */
export const SCREENSHOT_DESCRIPTION = 'Capture the visible part of the current tab as an image. Useful to check visual results.';

/**
 * What `screenshot` says when the configured model has turned out not to accept images.
 *
 * The tool is still offered rather than removed. Removing a tool mid-conversation would leave
 * earlier `screenshot` calls in the history referring to a function the model is no longer shown,
 * which several backends reject outright — and a model that simply loses a tool tends to keep
 * trying anyway. Telling it the truth in the description is both valid and more effective: the
 * result would be a sentence, and the useful move is a structural check.
 */
export const SCREENSHOT_DESCRIPTION_BLIND =
  'Unavailable: the model configured in this chat does not accept images, so this returns a note instead of a picture and tells you nothing. Do not call it. Check visual results structurally instead — get_styles for what a rule computed to, find_elements for whether something is present and what box it has, get_page for the surrounding markup.';

/**
 * The tool list, with `screenshot` described according to whether this backend can show one.
 *
 * `canSeeImages` is false only for an OpenAI-compatible endpoint already known to refuse images
 * (lib/providers/vision.ts) or one the user has set to Never. Every other backend gets the normal
 * description, so nothing here discourages a screenshot from a model that can read it — which was
 * the other half of the requirement, and the easier half to get wrong.
 */
export function toolsFor(canSeeImages: boolean): ToolDef[] {
  if (canSeeImages) return TOOLS;
  return TOOLS.map((t) => (t.name === 'screenshot' ? { ...t, description: SCREENSHOT_DESCRIPTION_BLIND } : t));
}

export const TOOLS: ToolDef[] = [
  {
    name: 'get_page',
    description:
      'Return a pruned HTML view of the current page (or of one element and its subtree). Scripts, styles and hidden elements are removed; long text is truncated. Start here. Use a selector to zoom in when the page is large.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'Optional CSS selector for the root element to serialize.' },
        max_chars: { type: 'integer', description: 'Character budget for the output. Default 20000, max 60000.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'find_elements',
    description: 'List elements matching a CSS selector with their position, size, visibility and text preview. Use it to verify a selector before relying on it.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        limit: { type: 'integer', description: 'Max elements to list. Default 20.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_styles',
    description: 'Return computed CSS properties for the first element matching a selector.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        properties: { type: 'array', items: { type: 'string' }, description: 'CSS property names. Omit for a useful default set.' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_script',
    description:
      'Run JavaScript once on the current page, right now, in the same isolated world a saved mod would use. Returns the value of the last expression (or of an explicit return, or the resolved value of a promise), a count of what the DOM did while it ran, console output, and any thrown error. Code whose last statement is a bare expression returns that expression; code that only mutates the page reports "Completed. No return value." with the DOM counts, which is a successful run, not a failure. Use it to test a draft mod or to perform a one-off task. Code may use await at top level.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        description: { type: 'string', description: 'One line saying what this run does, shown to the user.' },
        then_wait: {
          type: 'object',
          description:
            'Optional. After the code runs, wait for this condition before returning — so "click it, then wait for the result" is one step instead of two. Same shape as wait_for: exactly one condition, plus an optional timeout_ms. If the code navigates the page, a url or load condition here is the expected outcome rather than a lost result.',
          properties: { ...WAIT_CONDITION_PROPERTIES, timeout_ms: { type: 'integer', description: `Default 5000, max ${MAX_TIMEOUT_MS}.` } },
          additionalProperties: false,
        },
      },
      required: ['code', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'wait_for',
    description:
      'Wait until something on the page becomes true, then return. Use it after anything that triggers loading, navigation or animation: a click whose result arrives later, a scroll that lazy-loads content, a script that starts a route change, a modal that animates in. Never poll with run_script and never re-read the page in a loop — that burns your step budget and tells you nothing this does not. Give exactly one condition. It returns the moment the condition is true (immediately if it already is), so a generous timeout costs nothing. A timeout is NOT an error: it is a normal, informative outcome that reports what the page actually looks like now, which usually tells you whether to wait again or change approach.',
    inputSchema: {
      type: 'object',
      properties: {
        ...WAIT_CONDITION_PROPERTIES,
        timeout_ms: { type: 'integer', description: `How long to give it. Default 5000, max ${MAX_TIMEOUT_MS}.` },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: SCREENSHOT_DESCRIPTION,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'open_mod',
    description:
      'Adopt an installed mod as this chat\'s draft, so the next propose_mod revises that mod instead of creating a second one. Take the id from the "[Mods already installed on this page]" list in the user\'s turn. Use it whenever the user asks for a change that belongs with a mod already on this page — the same site and the same purpose, or wording like "also", "too" or "as well". It returns the mod\'s current script, which you should read before changing anything. If the chat already has a draft with unsaved changes it is refused, and you decide with the user whether to save that first or pass replace: true.',
    inputSchema: {
      type: 'object',
      properties: {
        mod_id: { type: 'string', description: 'The id of an installed mod, exactly as the list gives it.' },
        replace: {
          type: 'boolean',
          description:
            'Only after a refusal: take over a draft that has unsaved changes. Nothing is lost — the earlier versions stay in the user\'s version strip — but the draft they were working on stops being what a Save writes, so ask them first.',
        },
      },
      required: ['mod_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'propose_mod',
    description:
      'Present a finished userscript to the user, who can try it, save it, and enable it. Call this once the script has been tested with run_script. It is refused if nothing has been run since your last proposal, if the code does not parse, if it uses eval, new Function, document.write or an inline handler attribute, or if a match pattern covers every site the user visits without them having asked for that. Do not include a ==UserScript== header; it is generated from the other fields.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human name, e.g. "Hide YouTube Shorts".' },
        description: { type: 'string', description: 'One sentence.' },
        matches: { type: 'array', items: { type: 'string' }, description: 'Chrome match patterns, e.g. ["*://*.youtube.com/*"].' },
        code: { type: 'string', description: 'The script body.' },
        untested_reason: {
          type: 'string',
          description:
            'Only when you genuinely could not run the script here. One sentence saying why; it is shown to the user on the proposal card. This bypasses the "test it first" check and nothing else.',
        },
      },
      required: ['name', 'description', 'matches', 'code'],
      additionalProperties: false,
    },
  },
];
