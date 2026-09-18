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
      'Run JavaScript once on the current page, right now, in the same isolated world a saved mod would use. Returns the value of the last expression (or the resolved value if you return a promise), console output, and any thrown error. Use it to test a draft mod or to perform a one-off task. Code may use await at top level.',
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
      'Present a finished userscript to the user, who can try it, save it, and enable it. Call this once the script has been tested with run_script. Do not include a ==UserScript== header; it is generated from the other fields.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human name, e.g. "Hide YouTube Shorts".' },
        description: { type: 'string', description: 'One sentence.' },
        matches: { type: 'array', items: { type: 'string' }, description: 'Chrome match patterns, e.g. ["*://*.youtube.com/*"].' },
        code: { type: 'string', description: 'The script body.' },
      },
      required: ['name', 'description', 'matches', 'code'],
      additionalProperties: false,
    },
  },
];
