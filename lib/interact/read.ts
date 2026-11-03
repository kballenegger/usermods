// A skill's `read` step: what its selector matches, taken as the text, the link or an attribute. See
// docs/specs/skills.md, section 1.3.
//
// It reads what the page shows and never what a field holds: `take: value` is refused when the file is
// parsed and again here, for a record forced into storage, and a field on the never list gives nothing.
//
// DOM only, so node tests drive it (test/interact.test.ts).

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { sensitiveField } from './describe.ts';
import { queryEverywhere } from './target.ts';

/** A `read` stops at this many: lib/skills.ts MAX_READ_ITEMS, which a test holds it to. */
export const READ_LIMIT = 500;

export interface ReadStep {
  from: string;
  take: string;
  each?: boolean;
}

export type ReadResult = { ok: true; values: string[] } | { ok: false; message: string };

const spaced = (s: string) => s.replace(/\s+/g, ' ').trim();

function takeFrom(el: Element, take: string): string | null {
  if (take === 'text') return spaced((el as HTMLElement).innerText ?? el.textContent ?? '');
  if (take === 'href' || take === 'src') {
    // The property is the resolved address; an element without one (an SVG link) has the attribute.
    const prop = (el as unknown as Record<string, unknown>)[take];
    return typeof prop === 'string' && prop ? prop : el.getAttribute(take);
  }
  return el.getAttribute(take);
}

export function readOutput(step: ReadStep, doc: Document = document): ReadResult {
  if (/^(value|defaultvalue)$/i.test(step.take)) return { ok: false, message: 'a skill does not read what a field holds' };
  let found: Element[];
  try {
    found = queryEverywhere(step.from, doc);
  } catch {
    return { ok: false, message: `${step.from} is not a selector this browser reads` };
  }
  const readable = found.filter((el) => !sensitiveField(el));
  if (!readable.length) return { ok: false, message: `could not find ${step.from} (0 matches)` };
  const values: string[] = [];
  for (const el of step.each ? readable : readable.slice(0, 1)) {
    const v = takeFrom(el, step.take);
    if (v) values.push(v);
    if (values.length >= READ_LIMIT) break;
  }
  return { ok: true, values };
}
