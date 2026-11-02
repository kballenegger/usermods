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
import { bumpPatch } from './share.ts';
import type { AtMap } from './interact/target';
import { atStart, isInputRef, serialiseSkill, skillMatchesUrl, type ParsedSkill, type SkillInput, type SkillOutput, type SkillStep, type SkillWait } from './skills.ts';
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
  /** A repair did this, instead of the skill's step at this index. */
  repairOf?: number;
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
      /** A repair typed the broken step's own value, so this is how the file already writes it. */
      typedAs?: string;
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
  /** These steps go into an existing file, which has its own start. */
  noStart?: boolean;
}

export type CompileResult = { ok: true; source: string; skill: ParsedSkill; steps: number } | { ok: false; errors: string[] };

const sameWait = (a: SkillWait, b: SkillWait) => JSON.stringify(a) === JSON.stringify(b);

/** An address on the site as the file writes it. */
function onSitePath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

/** A step that types nothing, as its file writes it. */
function plainStep(e: Extract<JournalEntry, { kind: 'act' }>, why: { why?: string }): SkillStep {
  const target = formatRoleName(e.role, e.name);
  const at = e.at;
  switch (e.verb) {
    case 'check':
      return { verb: 'check', target, at, ...(e.unchecked ? { checked: false } : {}), ...why };
    case 'press':
      return { verb: 'press', key: e.key ?? '', ...(e.role ? { target, at } : {}), ...why };
    case 'hover':
    case 'scroll_to':
      return { verb: e.verb, target, at, ...why };
    default:
      return { verb: 'click', target, at, ...(e.repeat && e.repeat > 1 ? { repeat: e.repeat } : {}), ...why };
  }
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
  if (!startsWithGo && !widened && !opts.noStart) steps.push({ verb: 'go', to: onSitePath(start), why: 'start where the recording started' });

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
      default:
        steps.push(plainStep(e, why));
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

// ---------------------------------------------------------------------------
// propose_skill: the model names what to keep
// ---------------------------------------------------------------------------

/** What propose_skill says. It names journal entries: it has no way to write a step. */
export interface SkillProposal {
  name: string;
  description: string;
  fromStep?: number;
  toStep?: number;
  /** Where in the draft these steps go. 0 is before its first step. */
  afterStep?: number;
  inputs: { journalStep: number; name: string; label: string; optional?: boolean }[];
  outputs: { name: string; label: string; fromStep: number; take: string; list?: boolean }[];
  constants: number[];
  /** Rename an input the draft already has. */
  renames: { from: string; to: string; label?: string }[];
}

const asStep = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) ? v : undefined);
const asText = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const asList = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);

/** The tool's input, checked before anything is read. */
export function parseProposeSkill(raw: Record<string, unknown>): { ok: true; proposal: SkillProposal } | { ok: false; error: string } {
  const name = asText(raw.name);
  const description = asText(raw.description);
  if (!name || !description) return { ok: false, error: 'propose_skill needs a name and a description.' };
  const inputs: SkillProposal['inputs'] = [];
  for (const i of asList(raw.inputs)) {
    const journalStep = asStep(i.journal_step);
    if (journalStep === undefined || !asText(i.name) || !asText(i.label)) return { ok: false, error: 'Each input needs journal_step, name and label.' };
    inputs.push({ journalStep, name: asText(i.name), label: asText(i.label), ...(i.optional === true ? { optional: true } : {}) });
  }
  const outputs: SkillProposal['outputs'] = [];
  for (const o of asList(raw.outputs)) {
    const fromStep = asStep(o.from_step);
    if (fromStep === undefined || !asText(o.name) || !asText(o.label) || !asText(o.take)) return { ok: false, error: 'Each output needs name, label, from_step and take.' };
    outputs.push({ name: asText(o.name), label: asText(o.label), fromStep, take: asText(o.take), ...(o.list === true ? { list: true } : {}) });
  }
  const renames: SkillProposal['renames'] = [];
  for (const r of asList(raw.rename_inputs)) {
    if (!asText(r.from) || !asText(r.to)) return { ok: false, error: 'Each rename needs from and to.' };
    renames.push({ from: asText(r.from), to: asText(r.to), ...(asText(r.label) ? { label: asText(r.label) } : {}) });
  }
  const fromStep = asStep(raw.from_step);
  const toStep = asStep(raw.to_step);
  const afterStep = asStep(raw.after_step);
  const constants = Array.isArray(raw.constants) ? raw.constants.flatMap((c) => asStep(c) ?? []) : [];
  return { ok: true, proposal: { name, description, ...(fromStep !== undefined ? { fromStep } : {}), ...(toStep !== undefined ? { toStep } : {}), ...(afterStep !== undefined ? { afterStep } : {}), inputs, outputs, constants, renames } };
}

/** The draft a proposal revises. `floor` is the last journal entry a proposal has used. */
export interface ProposalBase {
  skill: ParsedSkill;
  floor: number;
  /** The entries it was compiled from, when it was one recording. */
  recording?: { from: number; to: number };
  /** It is a saved skill being edited, whose steps a recording does not replace by default. */
  linked: boolean;
}

export type ProposalResult =
  | { ok: true; source: string; skill: ParsedSkill; recording?: { from: number; to: number }; floor: number; wordsOnly: boolean; note?: string }
  | { ok: false; error: string };

const refuse = (error: string): ProposalResult => ({ ok: false, error });

/** The latest run with a step in it, from its first act to its last call. */
function latestRecording(entries: readonly JournalEntry[]): JournalEntry[] {
  const last = [...entries].reverse().find((e) => e.kind === 'act');
  return last ? recordingOf(entries, last.run) : [];
}

const typesValue = (e: JournalEntry): e is Extract<JournalEntry, { kind: 'act' }> => e.kind === 'act' && (e.verb === 'fill' || e.verb === 'select');

/** What the proposal says about each typed value and each look in a recording, with its refusals. */
function decisionsOf(recording: readonly JournalEntry[], all: readonly JournalEntry[], p: SkillProposal): { ok: true; decisions: SaveDecisions } | { ok: false; error: string } {
  const entry = (n: number) => all.find((e) => e.n === n);
  const inRecording = (n: number) => recording.some((e) => e.n === n);
  const fields: SaveDecisions['fields'] = {};
  const outputs: SaveDecisions['outputs'] = {};
  const typedStep = (n: number): string | null => {
    const e = entry(n);
    if (!e) return `Journal step ${n} does not exist.`;
    if (!typesValue(e)) return `Journal step ${n} did not type anything.`;
    return inRecording(n) ? null : `Journal step ${n} is outside the steps this proposal covers.`;
  };
  for (const i of p.inputs) {
    const problem = typedStep(i.journalStep);
    if (problem) return { ok: false, error: problem };
    fields[i.journalStep] = { as: 'input', name: i.name, label: i.label, ...(i.optional ? { optional: true } : {}) };
  }
  for (const n of p.constants) {
    const problem = typedStep(n);
    if (problem) return { ok: false, error: problem };
    if (fields[n]) return { ok: false, error: `Journal step ${n} cannot be both an input and a constant.` };
    fields[n] = { as: 'constant' };
  }
  for (const e of recording) {
    if (!typesValue(e) || fields[e.n]) continue;
    // A choice from the page's own list can stay as it was. Something typed has to be accounted for.
    if (e.verb === 'select') fields[e.n] = { as: 'constant' };
    else return { ok: false, error: `Journal step ${e.n} typed into ${formatRoleName(e.role, e.name)}, and you named it neither as an input nor as a constant. Name it in inputs, or in constants if the user asked to keep that value.` };
  }
  for (const o of p.outputs) {
    const e = entry(o.fromStep);
    if (!e) return { ok: false, error: `Journal step ${o.fromStep} does not exist.` };
    if (e.kind !== 'look') return { ok: false, error: `Journal step ${o.fromStep} is not a find_elements call, so an output cannot be read from it.` };
    if (e.matched < 1) return { ok: false, error: `Journal step ${o.fromStep} matched nothing, so there is nothing to read.` };
    if (!inRecording(o.fromStep)) return { ok: false, error: `Journal step ${o.fromStep} is outside the steps this proposal covers.` };
    outputs[o.fromStep] = { name: o.name, label: o.label, take: o.take, list: o.list === true };
  }
  return { ok: true, decisions: { name: p.name, description: p.description, fields, outputs } };
}

/** A word the model wrote that holds a value typed for an input. The one way a value could reach the file. */
function quotesInput(recording: readonly JournalEntry[], d: SaveDecisions, valueOf: CompileOptions['valueOf'], p: SkillProposal): string | null {
  const typed = recording.flatMap((e) => {
    if (e.kind !== 'act' || e.toolId === undefined || e.stepIndex === undefined || d.fields[e.n]?.as !== 'input') return [];
    const v = valueOf(e.toolId, e.stepIndex)?.trim().toLowerCase();
    return v && v.length >= MIN_QUOTED ? [v] : [];
  });
  const words = [p.name, p.description, ...p.inputs.flatMap((i) => [i.name, i.label]), ...p.outputs.flatMap((o) => [o.name, o.label]), ...p.renames.flatMap((r) => [r.to, r.label ?? ''])];
  const bad = words.find((w) => typed.some((v) => w.toLowerCase().includes(v)));
  return bad ? `"${bad}" holds what was typed for an input, and a value never goes in a skill. Word it without the value.` : null;
}

/** New words on a file, in its front matter and in the heading a recording wrote. */
function withWords(skill: ParsedSkill, name: string, description: string): ParsedSkill {
  const before = skill.before.replace(`# ${skill.name}`, `# ${name}`).replace(skill.description, description);
  return { ...skill, name, description, before };
}

function withRenames(skill: ParsedSkill, renames: SkillProposal['renames']): { ok: true; skill: ParsedSkill } | { ok: false; error: string } {
  let out = skill;
  for (const r of renames) {
    if (!out.inputs[r.from]) return { ok: false, error: `This draft has no input called ${r.from}.` };
    if (r.to !== r.from && out.inputs[r.to]) return { ok: false, error: `This draft already has an input called ${r.to}.` };
    const inputs = Object.fromEntries(Object.entries(out.inputs).map(([k, v]) => (k === r.from ? [r.to, { ...v, ...(r.label ? { label: r.label } : {}) }] : [k, v])));
    const steps = out.steps.map((s) => {
      const value = (s.verb === 'fill' || s.verb === 'select') && s.value === `$${r.from}` ? { value: `$${r.to}` } : {};
      const when = s.when === `$${r.from}` ? { when: `$${r.to}` } : {};
      return { ...s, ...value, ...when } as SkillStep;
    });
    out = { ...out, inputs, steps };
  }
  return { ok: true, skill: out };
}

/**
 * propose_skill's refusals and what comes of it. Every step in the result is one the extension recorded
 * (or was already in the file): this function has nowhere to take a target from but the journal.
 *
 * With no new step since the last proposal, there must be a draft, and only its words, inputs and outputs
 * change. With new ones, they become the file, or with `after_step` go into it at that point.
 */
export function compileProposal(entries: readonly JournalEntry[], p: SkillProposal, base: ProposalBase | null, opts: CompileOptions): ProposalResult {
  const floor = base?.floor ?? 0;
  const since = entries.filter((e) => e.n > floor);
  const highest = entries.at(-1)?.n ?? floor;
  const stepsNamed = p.fromStep !== undefined || p.toStep !== undefined || p.afterStep !== undefined;

  if (!since.some((e) => e.kind === 'act') && !stepsNamed) {
    if (!base) return refuse('Nothing has been done on the page since the last proposal. Do it once with act, then propose it: usermods records the steps, and you cannot write one.');
    const named = p.inputs.length || p.outputs.length || p.constants.length;
    let next: ParsedSkill = base.skill;
    let recording = base.recording;
    if (named) {
      if (!recording) return refuse('This draft did not come from one recording in this chat, so its typed values have no journal steps to name. Use rename_inputs to rename an input, or change it on the page and propose with after_step.');
      const rec = entries.filter((e) => e.n >= recording!.from && e.n <= recording!.to);
      const d = decisionsOf(rec, entries, p);
      if (!d.ok) return refuse(d.error);
      const quoted = quotesInput(rec, d.decisions, opts.valueOf, p);
      if (quoted) return refuse(quoted);
      const compiled = compileRecording(rec, { ...d.decisions, start: base.skill.start }, opts);
      if (!compiled.ok) return refuse(compiled.errors.join('. '));
      next = { ...compiled.skill };
    } else {
      const quoted = quotesInput(entries, { name: '', description: '', fields: {}, outputs: {} }, opts.valueOf, p);
      if (quoted) return refuse(quoted);
    }
    const renamed = withRenames(withWords(next, p.name, p.description), p.renames);
    if (!renamed.ok) return refuse(renamed.error);
    const skill = { ...renamed.skill, version: bumpPatch(base.skill.version) };
    return { ok: true, source: serialiseSkill(skill), skill, ...(recording ? { recording } : {}), floor: Math.max(floor, highest), wordsOnly: true };
  }

  if (p.afterStep !== undefined && !base) return refuse('after_step says where new steps go in a draft, and this chat has no draft skill.');
  if (base?.linked && p.afterStep === undefined) return refuse('This draft is a saved skill. Say where the new steps go with after_step: the number of the step they follow, or 0 for the start.');
  if (p.afterStep !== undefined && (p.afterStep < 0 || p.afterStep > base!.skill.steps.length)) return refuse(`after_step must be from 0 to ${base!.skill.steps.length}: this draft has ${base!.skill.steps.length} steps.`);
  for (const n of [p.fromStep, p.toStep]) if (n !== undefined && !entries.some((e) => e.n === n)) return refuse(`Journal step ${n} does not exist.`);

  const from = p.fromStep ?? null;
  const to = p.toStep ?? highest;
  const recording = from !== null || p.toStep !== undefined ? entries.filter((e) => e.n >= (from ?? floor + 1) && e.n <= to) : latestRecording(since);
  if (!recording.some((e) => e.kind === 'act')) return refuse('Nothing was done with act in those steps. Do it once with act, then propose it: usermods records the steps, and you cannot write one.');

  const d = decisionsOf(recording, entries, p);
  if (!d.ok) return refuse(d.error);
  const quoted = quotesInput(recording, d.decisions, opts.valueOf, p);
  if (quoted) return refuse(quoted);
  const scripts = recording.filter((e) => e.kind === 'script').length;
  const acts = recording.filter((e) => e.kind === 'act').length;
  const note = scripts ? `this run used scripts; only its ${acts} act step${acts === 1 ? '' : 's'} can be saved` : undefined;
  const range = { from: recording[0]!.n, to: recording.at(-1)!.n };

  if (p.afterStep === undefined) {
    const compiled = compileRecording(recording, d.decisions, opts);
    if (!compiled.ok) return refuse(compiled.errors.join('. '));
    return { ok: true, source: compiled.source, skill: compiled.skill, recording: range, floor: Math.max(floor, range.to), wordsOnly: false, ...(note ? { note } : {}) };
  }

  const b = base!.skill;
  const stray = recording.find((e) => e.kind === 'act' && !skillMatchesUrl(b, e.url));
  if (stray) return refuse(`Journal step ${stray.n} happened on ${stray.url}, which is off this skill's site.`);
  const compiled = compileRecording(recording, { ...d.decisions, name: b.name, description: b.description, start: b.start }, { ...opts, noStart: true });
  if (!compiled.ok) return refuse(compiled.errors.join('. '));
  const spliced: ParsedSkill = {
    ...b,
    inputs: { ...b.inputs, ...compiled.skill.inputs },
    outputs: { ...b.outputs, ...compiled.skill.outputs },
    steps: [...b.steps.slice(0, p.afterStep), ...compiled.skill.steps, ...b.steps.slice(p.afterStep)],
  };
  const renamed = withRenames(withWords(spliced, p.name, p.description), p.renames);
  if (!renamed.ok) return refuse(renamed.error);
  const skill = { ...renamed.skill, version: bumpPatch(b.version) };
  // Spliced into a file, it is no longer one recording.
  return { ok: true, source: serialiseSkill(skill), skill, floor: Math.max(floor, range.to), wordsOnly: false, ...(note ? { note } : {}) };
}

// ---------------------------------------------------------------------------
// UPDATE SKILL WITH THE REPAIR
// ---------------------------------------------------------------------------

/**
 * The file with each repaired step replaced by what the repair did, and its patch version bumped. What
 * replaces a step is what the extension read when the step ran. A typed value is the step's own, as the
 * file already wrote it, so nothing typed can come in through here.
 */
export function repairedSkill(base: ParsedSkill, entries: readonly JournalEntry[], run: string, repaired: readonly number[]): { ok: true; source: string; skill: ParsedSkill } | { ok: false; error: string } {
  let steps = base.steps;
  for (const index of [...repaired].sort((a, b) => b - a)) {
    if (index < 0 || index >= steps.length) return { ok: false, error: `This file has no step ${index + 1}.` };
    const did = entries.filter((e) => e.run === run && e.repairOf === index);
    const fresh: SkillStep[] = [];
    for (const e of did) {
      if (e.kind === 'wait') fresh.push({ verb: 'wait', condition: e.condition, ...(e.timeoutMs ? { timeoutMs: e.timeoutMs } : {}) });
      if (e.kind !== 'act') continue;
      const why = e.why ? { why: e.why } : {};
      if (e.verb === 'go') return { ok: false, error: 'A repair cannot go anywhere.' };
      if (e.verb === 'fill' || e.verb === 'select') {
        if (e.typedAs === undefined) return { ok: false, error: 'This repair typed something that is not the step’s own value.' };
        fresh.push({ verb: e.verb, value: e.typedAs, target: formatRoleName(e.role, e.name), at: e.at, ...why });
      } else fresh.push(plainStep(e, why));
    }
    if (!fresh.some((s) => s.verb !== 'wait')) return { ok: false, error: `The journal holds nothing the repair of step ${index + 1} did.` };
    steps = [...steps.slice(0, index), ...fresh, ...steps.slice(index + 1)];
  }
  // A repair can leave an input with nothing typing it, and a file may not declare one it does not use.
  const used = new Set(steps.flatMap((s) => [(s.verb === 'fill' || s.verb === 'select') && isInputRef(s.value) ? s.value.slice(1) : '', s.when && isInputRef(s.when) ? s.when.slice(1) : '']));
  const inputs = Object.fromEntries(Object.entries(base.inputs).filter(([k]) => used.has(k)));
  const skill: ParsedSkill = { ...base, steps, inputs, version: bumpPatch(base.version) };
  return { ok: true, source: serialiseSkill(skill), skill };
}
