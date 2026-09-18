import type { ToolDef } from '../types';

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
      },
      required: ['code', 'description'],
      additionalProperties: false,
    },
  },
  {
    name: 'screenshot',
    description: 'Capture the visible part of the current tab as an image. Useful to check visual results.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
