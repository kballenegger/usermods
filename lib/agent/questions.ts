// What a run asks the user, what the user can answer, and how a step reads in the transcript. See
// docs/specs/browser-use.md, sections 5.4 and 5.5.
//
// Every question is answered in an extension page. A page, a script or a skill file cannot answer
// one: the answer travels over a message the background takes only from an extension page
// (lib/agent/senders.ts), and `answerFits` holds it to what this question offered.
//
// The headline of a question and the sentence of a step are built from what the extension read from
// the live element (lib/interact/describe.ts). What the model said is a separate field, shown labelled
// as the model's, and nothing decides anything from it.
//
// Pure, tested under node (test/questions.test.ts).

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { formatDomEffect } from '../domeffect.ts';
import type { ActResult, ActStep } from '../interact/actions';
import type { Delta } from '../interact/delta';
import type { Described } from '../interact/describe';
import { formatRoleName } from '../interact/name.ts';
import type { Skill } from '../skills';

export type Question =
  /** Let usermods operate this site? The first `act` in a chat, unless the site has a standing allowance. */
  | { kind: 'operate'; id: string; host: string }
  /** Allow this? A consequential step, or every step with "Ask before every step" on. */
  | {
      kind: 'allow';
      id: string;
      host: string;
      /** From the extension's read: `click button "Unsubscribe" · up to 12 times`. */
      headline: string;
      /** `in table "Your subscriptions"`, from the same read. */
      where?: string;
      /** The model's reason, labelled as the model's on the card. */
      modelSays?: string;
      /** The first act on this site is also part of this card. */
      firstOnSite: boolean;
      /** "Allow every one of these in this chat", when that is on offer. */
      every?: { label: string };
      /** `step 9 of 9 of File an expense`, for a skill's step. */
      stepOf?: string;
      /** The skill's `why`, labelled as the skill's. Nothing decides anything from it. */
      skillSays?: string;
      /** Why it asks, from the extension's read: `it submits a form`. */
      because?: string;
    }
  /** With "Ask before every step" on, a script asks too, shown as code. */
  | { kind: 'script'; id: string; description: string; code: string }
  /** Your turn: wait_for with ask_user. `text` is the model's words, the rest is the extension's. */
  | { kind: 'handoff'; id: string; text: string; until?: string }
  /** The page left the site. `canContinue` only when the two hosts are siblings (lib/agent/boundary.ts). */
  | { kind: 'left-site'; id: string; from: string; to: string; canContinue: boolean }
  /** The page removed usermods' bar and it would not come back. */
  | { kind: 'bar-removed'; id: string }
  /** A skill's first run: every step shown before it happens. The headline is the live read. */
  | { kind: 'walk'; id: string; skill: string; n: number; total: number; headline: string; where?: string; skillSays?: string }
  /** A skill's step whose target did not resolve. The run stops here until the user says. */
  | { kind: 'skill-broken'; id: string; skill: string; n: number; total: number; message: string }
  /**
   * A resumed skill run with a step in flight when the worker died. Nothing replays it. `n` is the last
   * step that answer settles: the one in flight, or for what was not a step of the file (the go to
   * `start`, a repair's action) the one before it, so "continue from" names what comes next.
   */
  | { kind: 'did-happen'; id: string; skill: string; n: number; total: number; label: string }
  /** The run has done its 500 actions. */
  | { kind: 'skill-ceiling'; id: string; skill: string; actions: number }
  /**
   * A step wants an input the run card left empty. `lost`: the browser closed, so what was typed for this
   * run is gone. `optional`: the step says `when`, and leaving it empty is an answer.
   */
  | { kind: 'skill-input'; id: string; skill: string; n: number; label: string; optional?: boolean; lost?: boolean }
  /**
   * The model called run_skill. This is the run card, and nothing starts until it is answered here:
   * no tool can answer a question. `values` are what the model suggested, for the user to change.
   */
  | { kind: 'run-skill'; id: string; skill: Skill; values: Record<string, string>; siteAllowed: boolean; host: string };

export type Answer =
  | { kind: 'allow'; every?: boolean; standing?: boolean }
  | { kind: 'decline' }
  | { kind: 'done' }
  | { kind: 'back' }
  | { kind: 'continue' }
  /** A walked step: this one. `rest` is RUN THE REST WITHOUT ASKING. */
  | { kind: 'next' }
  | { kind: 'rest' }
  /** A broken step: you did it by hand, or look again. */
  | { kind: 'continue-from' }
  | { kind: 'try-again' }
  /** A pending step: it happened, or do it again, through the gate. */
  | { kind: 'it-did' }
  | { kind: 'do-again' }
  /** Past a skill's ceiling. */
  | { kind: 'carry-on' }
  | { kind: 'input'; value: string }
  /** RUN on a run card the model asked for, with what the user left in its fields. */
  | { kind: 'run'; inputs: Record<string, string>; standing?: boolean };

/** Whether this answer is one this question offered. Anything else is not an answer. */
export function answerFits(q: Question, a: Answer): boolean {
  switch (q.kind) {
    case 'operate':
      return (a.kind === 'allow' && !a.every) || a.kind === 'decline';
    case 'allow':
      return (a.kind === 'allow' && (!a.every || !!q.every) && (!a.standing || q.firstOnSite)) || a.kind === 'decline';
    case 'script':
      return (a.kind === 'allow' && !a.every && !a.standing) || a.kind === 'decline';
    case 'handoff':
      return a.kind === 'done';
    case 'left-site':
      return a.kind === 'back' || (a.kind === 'continue' && q.canContinue);
    case 'bar-removed':
      return a.kind === 'allow' && !a.every && !a.standing;
    case 'walk':
      return a.kind === 'next' || a.kind === 'rest';
    case 'skill-broken':
      return a.kind === 'continue-from' || a.kind === 'try-again';
    case 'did-happen':
      return a.kind === 'it-did' || a.kind === 'do-again';
    case 'skill-ceiling':
      return a.kind === 'carry-on';
    case 'skill-input':
      return a.kind === 'input' && typeof a.value === 'string' && (q.optional === true || !!a.value.trim());
    case 'run-skill':
      return a.kind === 'decline' || (a.kind === 'run' && !!a.inputs && typeof a.inputs === 'object' && Object.values(a.inputs).every((v) => typeof v === 'string') && (!a.standing || !q.siteAllowed));
  }
}

/** The activity line while this question is up. */
export function questionActivity(q: Question): string {
  switch (q.kind) {
    case 'operate':
      return `waiting for you · let usermods operate ${q.host}?`;
    case 'allow':
      return `waiting for you · allow ${q.headline}?`;
    case 'script':
      return `waiting for you · run this script?`;
    case 'handoff':
      return `your turn · ${q.text}`;
    case 'left-site':
      return `waiting for you · the page left ${q.from}`;
    case 'bar-removed':
      return 'waiting for you · the page removed usermods’ bar';
    case 'walk':
      return `walking through ${q.skill} · step ${q.n} of ${q.total}`;
    case 'skill-broken':
      return `stopped at ${q.n} of ${q.total} · ${q.skill}`;
    case 'did-happen':
      return `waiting for you · did this happen? ${q.label}`;
    case 'skill-ceiling':
      return `waiting for you · ${q.skill} has done ${q.actions} actions`;
    case 'skill-input':
      return `waiting for you · ${q.label}`;
    case 'run-skill':
      return `waiting for you · run ${q.skill.name}?`;
  }
}

// ---------------------------------------------------------------------------
// A step in words
// ---------------------------------------------------------------------------

const clip = (s: string, max = 200) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** What a verb is called in a question and in the journal. */
const VERB_LABEL: Record<ActStep['do'], string> = { click: 'click', fill: 'fill', select: 'choose in', check: 'tick', press: 'press', hover: 'hover', scroll_to: 'scroll to', go: 'go to' };

function goWords(d: Described): string {
  const go = d.go;
  if (go?.kind === 'url') return `go to ${go.href}`;
  if (go?.kind === 'reload') return 'reload the page';
  if (go?.kind === 'back') return 'go back';
  return 'go forward';
}

/**
 * The step as read from the element: `click button "Place order"`. It is what the journal stores and
 * what a question leads with, so it never holds what a field would be filled with.
 */
export function stepLabel(step: Pick<ActStep, 'do' | 'text'>, d: Described): string {
  if (step.do === 'go') return goWords(d);
  const target = formatRoleName(d.role, d.name);
  if (step.do === 'press') return `press ${clip((step.text ?? '').trim() || 'a key', 20)} in ${target}`;
  return `${VERB_LABEL[step.do]} ${target}`;
}

/** Where the element sits, as the extension read it. */
export function whereWords(d: Described): string | undefined {
  if (d.form?.name) return `in form "${clip(d.form.name, 60)}"`;
  if (d.landmark) return d.landmark.includes('"') ? `in ${clip(d.landmark, 60)}` : `in the ${d.landmark}`;
  return undefined;
}

/** A name in quotes, or a role for an element that has none. */
const named = (d: Described) => (d.name ? `"${clip(d.name, 80)}"` : d.role);

/** What the arrow says: what the extension observed. Empty when it observed nothing. */
export function deltaWords(delta: Delta | undefined): string {
  if (!delta) return '';
  const parts: string[] = [];
  if (delta.dom.removed) parts.push(`${delta.dom.removed} removed`);
  if (delta.dom.added) parts.push(`${delta.dom.added} added`);
  if (delta.urlAfter !== delta.urlBefore) parts.push('the page moved on');
  return parts.join(', ');
}

/** A step in flight: `clicking "Unsubscribe"`, for the activity line and the row. */
export function stepInFlight(step: Pick<ActStep, 'do'>, d: Described): string {
  switch (step.do) {
    case 'click':
      return `clicking ${named(d)}`;
    case 'fill':
      return `filling ${named(d)}`;
    case 'select':
      return `choosing in ${named(d)}`;
    case 'check':
      return `ticking ${named(d)}`;
    case 'press':
      return `pressing a key in ${named(d)}`;
    case 'hover':
      return `hovering ${named(d)}`;
    case 'scroll_to':
      return `scrolling to ${named(d)}`;
    case 'go':
      return d.go?.kind === 'url' ? `going to ${d.go.path || d.go.href}` : 'moving the page';
  }
}

/** A step that happened, in the past tense: the click was dispatched, and that is all this claims. */
export function stepDone(step: Pick<ActStep, 'do' | 'text'>, d: Described, result: Extract<ActResult, { ok: true }>): string {
  const after = deltaWords(result.delta);
  const arrow = after ? ` → ${after}` : '';
  switch (step.do) {
    case 'click':
      return `clicked ${named(d)}${(result.clicks ?? 1) > 1 ? ` ×${result.clicks}` : ''}${arrow}`;
    case 'fill':
      return `filled ${named(d)}`;
    case 'select':
      return `chose "${clip((step.text ?? '').trim(), 60)}" in ${named(d)}${arrow}`;
    case 'check':
      return `${/^(false|off|no|uncheck|unticked?|0)$/i.test(step.text ?? '') ? 'unticked' : 'ticked'} ${named(d)}${arrow}`;
    case 'press':
      return `pressed ${clip((step.text ?? '').trim(), 20)} in ${named(d)}${arrow}`;
    case 'hover':
      return `hovered ${named(d)}${arrow}`;
    case 'scroll_to':
      return `scrolled to ${named(d)}`;
    case 'go': {
      const go = d.go;
      if (go?.kind === 'url') return `went to ${go.path || go.href}`;
      if (go?.kind === 'reload') return 'reloaded the page';
      return go?.kind === 'back' ? 'went back' : 'went forward';
    }
  }
}

/** How one step of an `act` call stands. `failed` also covers what was refused. */
export interface StepRow {
  state: 'running' | 'done' | 'declined' | 'failed' | 'stopped';
  /** The sentence on the row. */
  text: string;
  /** A step that touched nothing: a skill's wait or read. It takes the dot, not the pointer. */
  looked?: boolean;
  /** What it opens to. */
  detail?: {
    /** The model's description of the call, labelled as the model's. */
    modelSays?: string;
    /** The skill's `why`, labelled as the skill's. */
    skillSays?: string;
    /** The element as read: `button "Delete" · in form "Account" · submits a form`. */
    read?: string;
    /** The result in full: the same lines the model was told. */
    result?: string;
  };
}

/** The element as read, for a row's details. */
export function readWords(d: Described): string {
  const parts = [d.go ? goWords(d) : formatRoleName(d.role, d.name)];
  const where = whereWords(d);
  if (where) parts.push(where);
  if (d.submits) parts.push(d.form?.method && d.form.method !== 'get' ? `submits a ${d.form.method.toUpperCase()} form` : 'submits a form');
  if (d.link?.path) parts.push(`goes to ${d.link.path}`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// A script, as a row
// ---------------------------------------------------------------------------

/** What the extension observed a script or a test do to the page. `text` is the row's sentence. */
export interface ToolEffect {
  text: string;
}

/** The DOM half of a script's row, as `2 removed (div.modal-backdrop, div#login)`. */
function domWords(dom: Parameters<typeof formatDomEffect>[0]): string | null {
  const full = formatDomEffect(dom);
  if (!full || (!dom?.added && !dom?.removed)) return null;
  // formatDomEffect always spells out all three; a row names only the ones that happened.
  return full
    .split(/, (?=\d+ (?:added|attribute))/)
    .filter((part) => !/^0 /.test(part) && !/^\d+ attribute/.test(part))
    .join(', ');
}

/**
 * Whether a script touched the page, and how that reads. Decided from what it did, not from which
 * tool ran it: a script that changed nothing is a look, and keeps its ordinary row.
 */
export function scriptEffect(lead: string, dom: Parameters<typeof formatDomEffect>[0], navigatedTo?: string): ToolEffect | null {
  const said = domWords(dom);
  const parts = [...(said ? [said] : []), ...(navigatedTo ? ['the page moved on'] : [])];
  return parts.length ? { text: `${clip(lead, 120)} → ${parts.join(', ')}` } : null;
}

// ---------------------------------------------------------------------------
// The card: what the extension recorded of a run
// ---------------------------------------------------------------------------

/** One line of the card's list, in the words of the transcript's rows. */
export interface PageCard {
  /** `on the page · 14 actions`, `stopped by you · 9 actions`, `paused at 30 steps · 12 actions`. */
  label: string;
  /** `shop.example.com · 1 page · 48s`. */
  where: string;
  /** `12 clicks · 2 fields · you allowed 2 · you did 1 yourself · 1 script ran`. */
  counts: string;
  actions: string[];
  /** A script ran, so the card adds that it cannot see into one. */
  scripted: boolean;
  /** How many things were done on the page, for the chat index. */
  total: number;
  /** A model run that can become a skill: SAVE AS SKILL names this run in the chat's journal. */
  save?: { run: string; note?: string };
  /** What a skill's `read` steps collected. It stays on the device, on this card and in the chat's note. */
  outputs?: CardOutput[];
  /** The skill this card is the record of. */
  skill?: string;
  /** A model repaired steps of this run: UPDATE SKILL WITH THE REPAIR. */
  repair?: RepairOffer;
}

/** Which steps of which skill a repair replaced, and the run whose journal holds what it did instead. */
export interface RepairOffer {
  run: string;
  /** From 0, in the file the run ran. */
  steps: number[];
  skillId: string;
  /** The file's steps when the run started: an update does not land on a file that has changed since. */
  key: string;
  /** The run was of the chat's draft, which gets a new version. */
  draft?: boolean;
}

/** PROPOSED SKILL: the hero card. Every fact on it is the extension's, from what it recorded. */
export interface SkillProposalCard {
  name: string;
  description: string;
  version: number;
  /** How many steps the file has. */
  steps: number;
  host: string;
  /** The inputs' labels, in the order the steps use them. */
  inputs: string[];
  /** What a re-proposal changed nothing of: no step ran, so `tested` does not apply. */
  wordsOnly: boolean;
  /** The steps a run saved cannot include, when it used scripts. */
  note?: string;
}

export interface CardOutput {
  name: string;
  label: string;
  list: boolean;
  values: string[];
}

export type RunEnding = 'model' | 'stopped' | 'ceiling';

/** The facts a driving run gathers. Nothing in here comes from the model. */
export interface PageRecord {
  startedAt: number;
  hosts: string[];
  pages: string[];
  clicks: number;
  fields: number;
  others: number;
  allowed: number;
  yourself: number;
  scripts: number;
  actions: string[];
  /** A step ran through `act`, so there is something to save. */
  acted?: boolean;
}

export const emptyRecord = (now: number): PageRecord => ({ startedAt: now, hosts: [], pages: [], clicks: 0, fields: 0, others: 0, allowed: 0, yourself: 0, scripts: 0, actions: [] });

/** The most lines the card's list keeps; a long repeat is one line, a very long run keeps its last. */
const CARD_LIST_MAX = 100;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One finished step, into the record. */
export function recordStep(rec: PageRecord, step: Pick<ActStep, 'do'>, words: string, clicks: number | undefined): PageRecord {
  const counts = { clicks: rec.clicks, fields: rec.fields, others: rec.others };
  if (step.do === 'click') counts.clicks += clicks ?? 1;
  else if (step.do === 'fill' || step.do === 'select' || step.do === 'check') counts.fields += 1;
  else counts.others += 1;
  return { ...rec, ...counts, acted: true, actions: [...rec.actions, words].slice(-CARD_LIST_MAX) };
}

/** A page visited, by address and host, once each. */
export function recordPage(rec: PageRecord, url: string, host: string): PageRecord {
  const next = { ...rec };
  if (url && !rec.pages.includes(url)) next.pages = [...rec.pages, url];
  if (host && !rec.hosts.includes(host)) next.hosts = [...rec.hosts, host];
  return next;
}

/** The card, or null when the run did nothing on the page. A skill's run always has one. */
export function pageCard(rec: PageRecord, ending: RunEnding, now: number, skill?: { name: string; label: string }): PageCard | null {
  const total = rec.clicks + rec.fields + rec.others;
  if (!total && !skill) return null;
  const seconds = Math.max(1, Math.round((now - rec.startedAt) / 1000));
  const took = seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
  const count = plural(total, 'action');
  const label = skill ? skill.label : ending === 'stopped' ? `stopped by you · ${count}` : ending === 'ceiling' ? `paused at 30 steps · ${count}` : `on the page · ${count}`;
  const parts = [
    ...(rec.clicks ? [plural(rec.clicks, 'click')] : []),
    ...(rec.fields ? [plural(rec.fields, 'field')] : []),
    ...(rec.others ? [plural(rec.others, 'other step')] : []),
    ...(rec.allowed ? [`you allowed ${rec.allowed}`] : []),
    ...(rec.yourself ? [`you did ${rec.yourself} yourself`] : []),
    ...(rec.scripts ? [`${plural(rec.scripts, 'script')} ran`] : []),
  ];
  return {
    label,
    where: [rec.hosts.join(', ') || 'this page', plural(Math.max(1, rec.pages.length), 'page'), took].join(' · '),
    counts: parts.join(' · '),
    actions: rec.actions,
    scripted: rec.scripts > 0,
    total,
    ...(skill ? { skill: skill.name } : {}),
  };
}
