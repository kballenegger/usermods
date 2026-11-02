// From what the extension saw to a skill file. See docs/specs/skills.md, sections 2.3 and 2.4.
//
// A step in a skill made here is a step the extension observed: every target below is what the
// content script read from the live element when the step ran, recorded by lib/agent/driver.ts, and
// nothing in this file can invent one. The model's words ride along as `why`, which has no power.
//
// A journal entry never holds what a field was filled with. It holds the tool call and the step that
// typed it, and the value is looked up in the saved conversation only for the two things that need it:
// the card asking "which of these change each time?", and a value the user chose to keep as a constant.
// An input's value is read once more, to look for it: the model's words and what it waited for can
// quote what it typed, and a why is written to the file. They are the one way a value could get in,
// so a why that holds one goes, an ask has it blanked, and a wait or an address that holds one is
// refused. It is never written anywhere from here.
//
// Pure, tested under node (test/skillcompile.test.ts).

// The .ts extensions: see lib/agent/tools.ts. node's test runner loads this file directly.
import type { Verb } from './agent/gate';
import { formatRoleName } from './interact/name.ts';
import type { AtMap } from './interact/target';
import { atStart, serialiseSkill, skillMatchesUrl, type ParsedSkill, type SkillInput, type SkillOutput, type SkillStep, type SkillWait } from './skills.ts';
import type { Msg } from './types';

/** How many entries one chat keeps. A run this long has outgrown a skill anyway. */
export const MAX_JOURNAL = 1000;

interface EntryBase {
  /** Rising within a chat: what a card, and later propose_skill, names an entry by. */
  n: number;
  /** The Driver that wrote it. One model run is one run. */
  run: string;
  /** The page it happened on. */
  url: string;
}

export type JournalEntry =
  | (EntryBase & {
      kind: 'act';
      verb: Verb;
      /** As read from the live element, not as the call named it. Empty for `go`. */
      role: string;
      name: string;
      at: AtMap;
      /** A `go`'s address, or back, forward or reload. */
      to?: string;
      /** A press's key. A key is not a value. */
      key?: string;
      /** A check that unticked. */
      unchecked?: boolean;
      repeat?: number;
      why?: string;
      /** Where the value is in the conversation, for a fill or a select. */
      toolId?: string;
      stepIndex?: number;
    })
  | (EntryBase & { kind: 'wait'; condition: SkillWait; timeoutMs?: number })
  | (EntryBase & { kind: 'ask'; text: string; until?: SkillWait })
  /** A find_elements with a selector that matched, which an output can be read from. */
  | (EntryBase & { kind: 'look'; selector: string; matched: number; links: boolean })
  | (EntryBase & { kind: 'script'; label: string })
  /** The user declined it or the gate refused it: not done, so not a step, and the body says so. */
  | (EntryBase & { kind: 'dropped'; label: string; consequential: boolean });

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

export interface CardField {
  n: number;
  /** `fill` or `select`. */
  verb: string;
  label: string;
  /** What was typed, for the user to recognise. Never written anywhere from here. */
  value: string;
  /** A name for the input, derived from the field's label. */
  name: string;
  /** A choice from the page's own list stays as it was unless asked; a typed value becomes an input. */
  suggest: 'input' | 'constant';
}

export interface CardLook {
  n: number;
  selector: string;
  matched: number;
  /** What to read from each match. */
  take: string;
  name: string;
  /** The look that came last, which is the list a run usually ended by reporting. */
  suggest: boolean;
}

/** What the SAVE AS SKILL card asks about. */
export interface SaveCard {
  run: string;
  name: string;
  description: string;
  start: string;
  host: string;
  steps: number;
  fields: CardField[];
  looks: CardLook[];
  /** A run that used scripts can save only the steps it did with act. */
  scriptNote?: string;
}

/** A value this short is found everywhere and proves nothing: `no`, `1`. */
const MIN_QUOTED = 3;

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

function uniqueName(wanted: string, fallback: string, taken: Set<string>): string {
  const clean = slug(wanted);
  const base = /^[a-z_]/.test(clean) ? clean : clean ? `${fallback}_${clean}` : fallback;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

/** A run's entries from its first act to its last call, which is what the spec says is the recording. */
export function recordingOf(entries: readonly JournalEntry[], run: string): JournalEntry[] {
  const mine = entries.filter((e) => e.run === run);
  const first = mine.findIndex((e) => e.kind === 'act');
  return first < 0 ? [] : mine.slice(first);
}

/** Where a fill typed: the call and the step of that call. Null once a compaction has dropped it. */
export function valueIn(messages: readonly Msg[], toolId: string, stepIndex: number): string | null {
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const part of msg.content) {
      if (part.type !== 'tool_call' || part.id !== toolId) continue;
      const steps = part.input.steps;
      if (!Array.isArray(steps)) return null;
      const text = (steps[stepIndex] as { text?: unknown } | undefined)?.text;
      return typeof text === 'string' ? text : null;
    }
  }
  return null;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
};

/** Where the skill starts by default: the first `go`, or the page the first step happened on. */
function startOf(rec: readonly JournalEntry[]): string {
  const first = rec[0];
  if (!first) return '';
  if (first.kind === 'act' && first.verb === 'go' && first.to && /^https?:/.test(first.to)) return first.to;
  return first.url;
}

/** The card's data. `valueOf` reads the conversation, and what it returns stays on the card. */
export function saveCardFor(recording: readonly JournalEntry[], run: string, valueOf: (toolId: string, stepIndex: number) => string | null, opts: { title?: string } = {}): SaveCard {
  const start = startOf(recording);
  const host = hostOf(start);
  const taken = new Set<string>();
  const fields: CardField[] = [];
  const looks: CardLook[] = [];
  let acts = 0;
  let scripts = 0;
  for (const e of recording) {
    if (e.kind === 'script') scripts++;
    if (e.kind === 'look') looks.push({ n: e.n, selector: e.selector, matched: e.matched, take: e.links ? 'href' : 'text', name: '', suggest: false });
    if (e.kind !== 'act') continue;
    acts++;
    if (e.verb !== 'fill' && e.verb !== 'select') continue;
    const value = e.toolId !== undefined && e.stepIndex !== undefined ? valueOf(e.toolId, e.stepIndex) : null;
    fields.push({ n: e.n, verb: e.verb, label: e.name || e.role, value: value ?? '', name: uniqueName(e.name || e.role, 'value', taken), suggest: e.verb === 'select' && value !== null ? 'constant' : 'input' });
  }
  // A chat is titled from its first message, which may be the very thing that was typed.
  const quoted = fields.some((f) => f.value.length >= MIN_QUOTED && opts.title?.toLowerCase().includes(f.value.toLowerCase()));
  for (const look of looks) look.name = uniqueName(look.selector.split(/[\s>]+/).at(-1)!.replace(/^[a-z]+(?=[.#])/, ''), 'output', taken);
  const lastAct = recording.reduce((last, e) => (e.kind === 'act' ? e.n : last), 0);
  const last = looks.at(-1);
  if (last && last.n > lastAct) last.suggest = true;
  const fallbackName = host ? `On ${host}` : 'Recorded steps';
  return {
    run,
    name: (!quoted && opts.title?.trim()) || fallbackName,
    description: `Recorded on ${host || 'this site'}.`,
    start,
    host,
    steps: acts,
    fields,
    looks,
    ...(scripts ? { scriptNote: `this run used scripts; only its ${acts} act step${acts === 1 ? '' : 's'} can be saved` } : {}),
  };
}

// ---------------------------------------------------------------------------
// The compiler
// ---------------------------------------------------------------------------

/** What the card answered. Values are not here: a constant's is read by `valueOf`, an input's by nobody. */
export interface SaveDecisions {
  name: string;
  description: string;
  /** Edited on the card. A prefix of the recording's page ends in `/`, and a run uses the page it is on. */
  start?: string;
  namespace?: string;
  fields: Record<number, { as: 'input'; name: string; label: string; optional?: boolean } | { as: 'constant' }>;
  outputs: Record<number, { name: string; label: string; take: string; list: boolean }>;
}

export interface CompileOptions {
  valueOf: (toolId: string, stepIndex: number) => string | null;
  /** YYYY-MM-DD, for the body's line about where it came from. */
  today: string;
}

export type CompileResult = { ok: true; source: string; skill: ParsedSkill; steps: number } | { ok: false; errors: string[] };

const sameWait = (a: SkillWait, b: SkillWait) => JSON.stringify(a) === JSON.stringify(b);

/** An address on the site as the file writes it. */
function onSitePath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** Journal entries to a file. Errors are the things a card should have prevented. */
export function compileRecording(recording: readonly JournalEntry[], d: SaveDecisions, opts: CompileOptions): CompileResult {
  const errors: string[] = [];
  const name = d.name.trim();
  if (!name) errors.push('a skill needs a name');
  const description = d.description.trim();
  if (!description) errors.push('a skill needs a description');
  const firstPage = recording[0]?.url ?? '';
  const start = d.start?.trim() || startOf(recording);
  if (!recording.some((e) => e.kind === 'act')) errors.push('this run did nothing on the page to save');
  const host = hostOf(start);
  if (!host || !/^https?:/.test(start)) errors.push(`${start || 'that'} is not an address a skill can start at`);
  else if (new URL(start).hostname !== new URL(firstPage || start).hostname) errors.push(`a skill starts on the site it was recorded on, ${hostOf(firstPage)}`);
  if (errors.length) return { ok: false, errors };

  const match = `*://${new URL(start).hostname}/*`;
  const on = { matches: [match] };
  const inputs: Record<string, SkillInput> = {};
  const outputs: Record<string, SkillOutput> = {};
  const steps: SkillStep[] = [];
  let dropped = 0;
  let previousWait: SkillWait | null = null;

  // What was typed for an input: looked for below, and written nowhere.
  const typed: string[] = [];
  for (const e of recording) {
    if (e.kind === 'act' && e.toolId !== undefined && e.stepIndex !== undefined && d.fields[e.n]?.as === 'input') {
      const value = opts.valueOf(e.toolId, e.stepIndex);
      if (value && value.trim().length >= MIN_QUOTED) typed.push(value.trim());
    }
  }
  const holdsTyped = (text: string | undefined) => !!text && typed.some((v) => text.toLowerCase().includes(v.toLowerCase()));
  const blanked = (text: string) => typed.reduce((t, v) => t.split(new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).join('…'), text);

  const first = recording[0];
  const startsWithGo = first?.kind === 'act' && first.verb === 'go';
  // A `start` the user widened to a prefix of the page means "wherever under here you are", so there
  // is no first navigation to write. Otherwise a run lands on the page the recording started on.
  const widened = firstPage !== start && atStart(start, firstPage);
  if (!startsWithGo && !widened) steps.push({ verb: 'go', to: onSitePath(start), why: 'start where the recording started' });

  for (const e of recording) {
    if (e.kind === 'dropped') {
      if (e.consequential) dropped++;
      continue;
    }
    if (e.kind === 'script') continue;
    if (e.kind === 'wait') {
      // then_wait and a wait_for straight after it for the same thing are one wait.
      if (previousWait && sameWait(previousWait, e.condition)) continue;
      if (holdsTyped(JSON.stringify(e.condition))) {
        errors.push(`a wait holds what was typed for an input (entry ${e.n})`);
        continue;
      }
      steps.push({ verb: 'wait', condition: e.condition, ...(e.timeoutMs ? { timeoutMs: e.timeoutMs } : {}) });
      previousWait = e.condition;
      continue;
    }
    previousWait = null;
    if (e.kind === 'ask') {
      if (e.until && holdsTyped(JSON.stringify(e.until))) errors.push(`the wait after "your turn" holds what was typed for an input (entry ${e.n})`);
      steps.push({ verb: 'ask', text: blanked(e.text), ...(e.until ? { until: e.until } : {}) });
      continue;
    }
    if (e.kind === 'look') {
      const out = d.outputs[e.n];
      if (!out) continue;
      outputs[out.name] = { label: out.label, ...(out.list ? { list: true } : {}) };
      steps.push({ verb: 'read', output: out.name, from: e.selector, take: out.take, ...(out.list ? { each: true } : {}) });
      continue;
    }
    const why = e.why && !holdsTyped(e.why) ? { why: e.why } : {};
    const target = formatRoleName(e.role, e.name);
    const at = e.at;
    switch (e.verb) {
      case 'go': {
        const to = e.to ?? '';
        if (to === 'back' || to === 'forward' || to === 'reload') {
          steps.push({ verb: 'go', to, ...why });
          break;
        }
        if (!skillMatchesUrl(on, to)) {
          errors.push(`step ${e.n} went off the site: ${to}`);
          break;
        }
        if (holdsTyped(decodeURIComponent(to)) || holdsTyped(to)) {
          errors.push(`step ${e.n}'s address holds what was typed for an input`);
          break;
        }
        steps.push({ verb: 'go', to: onSitePath(to), ...why });
        break;
      }
      case 'click':
        steps.push({ verb: 'click', target, at, ...(e.repeat && e.repeat > 1 ? { repeat: e.repeat } : {}), ...why });
        break;
      case 'fill':
      case 'select': {
        const decided = d.fields[e.n];
        if (!decided) {
          errors.push(`nothing was decided about the value typed into ${target}`);
          break;
        }
        if (decided.as === 'input') {
          inputs[decided.name] = { label: decided.label, ...(decided.optional ? { optional: true } : {}) };
          steps.push({ verb: e.verb, value: `$${decided.name}`, target, at, ...why, ...(decided.optional ? { when: `$${decided.name}` } : {}) });
          break;
        }
        const value = e.toolId !== undefined && e.stepIndex !== undefined ? opts.valueOf(e.toolId, e.stepIndex) : null;
        if (value === null) {
          errors.push(`the value typed into ${target} is gone from the conversation, so it can only be an input`);
          break;
        }
        steps.push({ verb: e.verb, value, target, at, ...why });
        break;
      }
      case 'check':
        steps.push({ verb: 'check', target, at, ...(e.unchecked ? { checked: false } : {}), ...why });
        break;
      case 'press':
        steps.push({ verb: 'press', key: e.key ?? '', ...(e.role ? { target, at } : {}), ...why });
        break;
      case 'hover':
      case 'scroll_to':
        steps.push({ verb: e.verb, target, at, ...why });
        break;
    }
  }
  if (errors.length) return { ok: false, errors };

  const declined = dropped ? `\n${dropped === 1 ? 'One step was' : `${dropped} steps were`} declined during recording and ${dropped === 1 ? 'is' : 'are'} not in this skill.` : '';
  const skill: ParsedSkill = {
    name,
    description,
    version: '1.0.0',
    ...(d.namespace?.trim() ? { namespace: d.namespace.trim() } : {}),
    matches: [match],
    start,
    inputs,
    outputs,
    extra: {},
    steps,
    before: `\n# ${name}\n\n${description}\nMade with usermods on ${opts.today} from a run on ${host}.${declined}\n\n`,
    after: '',
  };
  return { ok: true, source: serialiseSkill(skill), skill, steps: steps.length };
}

/** The decisions a card opens with, unedited: what its defaults would compile to. */
export function defaultDecisions(card: SaveCard): SaveDecisions {
  const fields: SaveDecisions['fields'] = {};
  for (const f of card.fields) fields[f.n] = f.suggest === 'input' ? { as: 'input', name: f.name, label: f.label } : { as: 'constant' };
  const outputs: SaveDecisions['outputs'] = {};
  for (const l of card.looks) if (l.suggest) outputs[l.n] = { name: l.name, label: l.name.replace(/_/g, ' '), take: l.take, list: l.matched !== 1 };
  return { name: card.name, description: card.description, start: card.start, fields, outputs };
}
