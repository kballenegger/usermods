// Carrying out a run's steps on the page: the gate, the journal, the questions, the pauses, Stop.
// See docs/specs/browser-use.md, sections 4.4 and 4.5.
//
// The order around one step is the whole design:
//
//   describe   the content script reads the live element
//   gate       lib/agent/gate.ts decides from that read and from what the user has answered
//   ask        a question, if the gate says so, answered only in the panel
//   journal    written down BEFORE the step runs, with what the extension read
//   act        the content script re-reads the element and refuses if it no longer matches
//   journal    cleared with the result
//
// The model's description is carried to the card, labelled as the model's. Nothing here decides
// anything from it, and `decide` has no parameter for it.
//
// `perform` is one message, sent once. It is never retried, not by the driver and not by the
// plumbing under it: a step whose answer was lost has probably happened, and a retry is a double
// submit. A resume does not replay it either. It tells the model the step may have happened
// (pendingResumeNote), and the model looks first.
//
// No chrome.* and no DOM, with everything behind DriverDeps, so the whole of this runs under node
// (test/driver.test.ts). lib/drive.ts is the other half.

// The .ts extensions: see lib/agent/tools.ts. node's test runner loads this file directly.
import { MAX_REPEAT, type ActResult, type ActStep } from '../interact/actions.ts';
import type { BrokenTarget, Closest, TargetSpec } from '../interact/target';
import type { Described } from '../interact/describe';
import { isRef } from '../interact/registry.ts';
import type { PendingStep } from '../runstate';
import type { AgentEventBody, Msg } from '../types';
import { hostOf, placeName, sharesSite, siteHosts } from './boundary.ts';
import { decide, isWebPage, type GateAllowances, type GateDecision, type Verb } from './gate.ts';
import { emptyRecord, pageCard, questionActivity, readWords, recordPage, recordStep, stepDone, stepInFlight, stepLabel, whereWords, type Answer, type PageCard, type PageRecord, type Question, type RunEnding, type StepRow } from './questions.ts';
import { describeCondition, parseWaitInput, renderWaitResult, type WaitOutcome, type WaitSpec } from './wait.ts';

/** How many steps one `act` call may hold. */
export const MAX_STEPS = 20;

/** How long a step gets to answer after Stop, before the run stops waiting for it. */
const STOP_GRACE_MS = 300;

const VERBS: readonly Verb[] = ['click', 'fill', 'select', 'check', 'press', 'hover', 'scroll_to', 'go'];
const NEEDS_TEXT: ReadonlySet<Verb> = new Set(['fill', 'select', 'press', 'go']);

export interface ActCall {
  steps: ActStep[];
  description: string;
  thenWait?: WaitSpec;
}

/** A ref, or a selector that has to match one element. */
export function targetFrom(raw: string): TargetSpec {
  const t = raw.trim();
  return isRef(t) ? { ref: t } : { selector: t };
}

/** The tool's input, checked before anything happens: a malformed step should cost nothing. */
export function parseActInput(raw: Record<string, unknown>): { ok: true; call: ActCall } | { ok: false; error: string } {
  const steps = raw.steps;
  if (!Array.isArray(steps) || !steps.length) return { ok: false, error: `act needs steps: 1 to ${MAX_STEPS} of them.` };
  if (steps.length > MAX_STEPS) return { ok: false, error: `act takes at most ${MAX_STEPS} steps in one call; this had ${steps.length}.` };
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (!description) return { ok: false, error: 'act needs a description: one line saying what these steps are for, shown to the user.' };
  const out: ActStep[] = [];
  for (const [i, s] of steps.entries()) {
    const at = `Step ${i + 1}`;
    if (!s || typeof s !== 'object') return { ok: false, error: `${at} is not an object.` };
    const step = s as { do?: unknown; target?: unknown; text?: unknown; repeat?: unknown };
    if (typeof step.do !== 'string' || !VERBS.includes(step.do as Verb)) return { ok: false, error: `${at}: do must be one of ${VERBS.join(', ')}.` };
    const verb = step.do as Verb;
    const target = typeof step.target === 'string' && step.target.trim() ? step.target : undefined;
    if (!target && verb !== 'go' && verb !== 'press') return { ok: false, error: `${at}: ${verb} needs a target, a ref from find_elements or a selector matching one element.` };
    const text = typeof step.text === 'string' ? step.text : undefined;
    if (NEEDS_TEXT.has(verb) && text === undefined) return { ok: false, error: `${at}: ${verb} needs text.` };
    let repeat: number | undefined;
    if (step.repeat !== undefined && step.repeat !== null) {
      if (verb !== 'click') return { ok: false, error: `${at}: repeat works only with click.` };
      const n = Number(step.repeat);
      if (!Number.isInteger(n) || n < 1 || n > MAX_REPEAT) return { ok: false, error: `${at}: repeat must be a whole number from 1 to ${MAX_REPEAT}.` };
      repeat = n;
    }
    out.push({ do: verb, ...(target && verb !== 'go' ? { target: targetFrom(target) } : {}), ...(text !== undefined ? { text } : {}), ...(repeat ? { repeat } : {}) });
  }
  let thenWait: WaitSpec | undefined;
  if (raw.then_wait !== undefined && raw.then_wait !== null) {
    const parsed = parseWaitInput(raw.then_wait);
    if (!parsed.ok) return { ok: false, error: `then_wait: ${parsed.error}` };
    thenWait = parsed.spec;
  }
  return { ok: true, call: { steps: out, description, ...(thenWait ? { thenWait } : {}) } };
}

/** The addresses a `go` needs no question for: what the user typed, and what was shown as a link. */
export function knownUrls(messages: readonly Msg[], pageUrl: string): string[] {
  const seen = new Set<string>();
  const add = (raw: string) => {
    try {
      seen.add(new URL(raw, pageUrl).href);
    } catch {
      /* not an address */
    }
  };
  const fromText = (text: string, isTool: boolean) => {
    for (const m of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) add(m[0]);
    if (!isTool) return;
    // find_elements' inventory prints a link's target after an arrow; get_page prints the markup.
    for (const m of text.matchAll(/→ (\S+)/g)) add(m[1]!);
    for (const m of text.matchAll(/href="([^"]+)"/g)) add(m[1]!);
  };
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    for (const part of msg.content) {
      if (part.type === 'text') fromText(part.text, false);
      else if (part.type === 'tool_result') for (const inner of part.content) if (inner.type === 'text') fromText(inner.text, true);
    }
  }
  return [...seen];
}

/** What the model reads, and what the panel's Resume block says, about a step that may have happened. */
export function pendingResumeNote(step: Pick<PendingStep, 'label'>): string {
  return `[The previous run was cut off during this step: ${step.label}. It may or may not have happened. Look at the page before doing anything else, and do not repeat it until you know.]`;
}

export type DescribeReply = { ok: true; described: Described; signature: string; rebound?: boolean } | { ok: false; code: string; message: string; closest?: Closest[]; broken?: BrokenTarget['reason'] };

/** Everything the driver needs from the browser. lib/drive.ts is the real one. */
export interface DriverDeps {
  describe(step: ActStep): Promise<DescribeReply>;
  /** One message, one step. Rejects if the page goes away before it answers. Never retried. */
  perform(id: string, step: ActStep, expect: string): Promise<ActResult>;
  cancel(id: string): void;
  outline(target: TargetSpec | null): Promise<void>;
  /** Raise or change the bar. `up` false means the page removed it for good. */
  bar(state: { status: string; handoff?: boolean } | null): Promise<{ up: boolean }>;
  /** Up again after a page removed it: it gets a fresh chance. */
  raiseAgain(state: { status: string; handoff?: boolean }): Promise<{ up: boolean }>;
  ask(q: Question, signal: AbortSignal): Promise<Answer | null>;
  pageUrl(): Promise<string>;
  tabActive(): Promise<boolean>;
  whenActive(signal: AbortSignal): Promise<void>;
  /** Back to where the run was, after the page left the site. */
  goBackTo(url: string, signal: AbortSignal): Promise<void>;
  /** A navigation a step started: back when the tab has loaded, or after a limit. */
  settled(signal: AbortSignal): Promise<void>;
  wait(spec: WaitSpec, signal: AbortSignal): Promise<WaitOutcome>;
  journalWrite(step: Omit<PendingStep, 'at'>): Promise<void>;
  journalClear(): Promise<void>;
  loadAllowances(host: string): Promise<GateAllowances>;
  allowSite(host: string, standing: boolean): Promise<void>;
  allowAction(host: string, key: string): Promise<void>;
  /** The hosts this chat holds an allowance for: what a sibling continued onto is remembered in. */
  chatSites(): Promise<string[]>;
  askEveryStep(): Promise<boolean>;
  emit(e: AgentEventBody): void;
  newId(): string;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export interface ActContext {
  toolId: string;
  history: readonly Msg[];
  iteration?: number;
}

export interface StepOptions {
  /** This step asks whatever else is true. Nothing can take a question away. */
  forceConfirm?: boolean;
  /** The reason shown on the card, labelled as the model's. */
  modelSays?: string;
  knownUrls?: readonly string[];
  /** The journal entry's kind: a skill's own steps are written down as a skill's. */
  journalKind?: PendingStep['kind'];
  /** Told of every state the step passes through, for the transcript. */
  onRow?: (row: StepRow) => void;
  iteration?: number;
}

export type StepOutcome =
  | { kind: 'done'; result: Extract<ActResult, { ok: true }>; described: Described; words: string; asked: boolean }
  /** The user said no. */
  | { kind: 'declined'; label: string }
  /** On the never list, or off the site. */
  | { kind: 'refused'; message: string; described?: Described }
  /** It could not be done. `broken` is set when the target did not resolve to one element. */
  | { kind: 'failed'; message: string; code: string; described?: Described; closest?: Closest[]; broken?: BrokenTarget['reason'] }
  | { kind: 'stopped' };

const STOPPED: StepOutcome = { kind: 'stopped' };

/** One run's operating of the page. Dropped with the run. */
export class Driver {
  /** From the run's first step on the page until it ends. */
  private driving = false;
  private hosts: string[] | null = null;
  /** The last address on the site, where Go back goes. */
  private lastOnSite = '';
  private steps = 0;
  private record: PageRecord;
  /** The bar's words, kept for a new document that has lost it. */
  private barStatus: { status: string; handoff?: boolean } | null = null;
  /** The bar has been put up, so the end of the run has something to take down. */
  private barRaised = false;
  private readonly deps: DriverDeps;

  constructor(deps: DriverDeps) {
    this.deps = deps;
    this.record = emptyRecord(deps.now());
  }

  get isDriving(): boolean {
    return this.driving;
  }

  // ---------------------------------------------------------------------------
  // Before anything happens
  // ---------------------------------------------------------------------------

  /**
   * The pauses, for a run that is driving: the tab has to be the active one, and the page has to be
   * on the site. Called before each tool call and each step, so no tool runs on another host without
   * the user choosing. It notices rather than prevents: the page has already gone by then.
   */
  async guard(signal: AbortSignal, iteration?: number): Promise<void> {
    if (!this.driving) return;
    await this.holdForTab(signal, iteration);
    if (!signal.aborted) await this.holdForSite(signal, iteration);
  }

  private async holdForTab(signal: AbortSignal, iteration?: number): Promise<void> {
    if (await this.deps.tabActive()) return;
    this.status('waiting-user', 'paused · you left the tab. It continues when you come back.', iteration);
    await this.deps.whenActive(signal);
  }

  private async holdForSite(signal: AbortSignal, iteration?: number): Promise<void> {
    if (!this.hosts) return;
    while (!signal.aborted) {
      // No answer means the tab went, which ends the run by its own route.
      const url = await this.deps.pageUrl().catch(() => null);
      if (url === null) return;
      const host = hostOf(url);
      if (this.onSite(host)) {
        this.lastOnSite = url;
        this.record = recordPage(this.record, url, host);
        return;
      }
      const from = this.hosts[0]!;
      const q: Question = { kind: 'left-site', id: this.deps.newId(), from, to: placeName(url), canContinue: isWebPage(url) && !!host && sharesSite(host, from) };
      const answer = await this.askUser(q, signal, iteration);
      if (!answer) return;
      if (answer.kind === 'continue') {
        // Remembered in the chat's allowance: "lasts for the chat", and the first-act question has
        // been answered by this one.
        await this.deps.allowSite(host, false);
        this.hosts = [...this.hosts, host];
        this.deps.emit({ type: 'note', text: `you continued on ${host}` });
        continue;
      }
      await this.deps.goBackTo(this.lastOnSite, signal);
    }
  }

  private onSite(host: string): boolean {
    return (this.hosts ?? []).includes(host);
  }

  /** Which site this run is on, fixed by where its first step is. */
  private async pinSite(pageUrl: string): Promise<void> {
    if (this.hosts) return;
    const host = hostOf(pageUrl);
    this.hosts = siteHosts(host, await this.deps.chatSites().catch(() => []));
    this.lastOnSite = pageUrl;
  }

  // ---------------------------------------------------------------------------
  // Words on the page and the line
  // ---------------------------------------------------------------------------

  private status(phase: 'tool' | 'waiting-user', detail: string, iteration?: number): void {
    this.deps.emit({ type: 'status', phase, ...(phase === 'tool' ? { tool: 'act' } : {}), detail, ...(iteration ? { iteration } : {}), ...(this.driving ? { driving: true } : {}) });
  }

  /**
   * Put the bar up, or change what it says, and read whether the page left it there. A page that
   * removed it for good pauses the run: the user has lost the Stop on the page and should know.
   */
  private async showBar(state: { status: string; handoff?: boolean }, signal: AbortSignal, iteration?: number): Promise<void> {
    this.barStatus = state;
    const { up } = await this.setBar(state);
    if (up || signal.aborted) return;
    const answer = await this.askUser({ kind: 'bar-removed', id: this.deps.newId() }, signal, iteration);
    if (answer) await this.deps.raiseAgain(state).catch(() => ({ up: true }));
  }

  /** A page the bar cannot reach (a browser page, one closing) says nothing about it being removed. */
  private setBar(state: { status: string; handoff?: boolean } | null): Promise<{ up: boolean }> {
    if (state) this.barRaised = true;
    return this.deps.bar(state).catch(() => ({ up: true }));
  }

  /** Put the bar back after a navigation took it. The new document's first message is a new bar. */
  async restoreBar(): Promise<void> {
    if (this.barStatus) await this.setBar(this.barStatus);
  }

  /** Off for the instant of a screenshot, so the model does not see usermods' own mark. */
  get barIsShowing(): boolean {
    return this.barStatus !== null;
  }

  /** A question, with the line and the bar saying so. Null when the run stopped under it. */
  private async askUser(q: Question, signal: AbortSignal, iteration?: number): Promise<Answer | null> {
    const before = this.barStatus;
    if (q.kind !== 'bar-removed') {
      this.barStatus = { status: 'usermods is waiting for you in the side panel' };
      await this.setBar(this.barStatus);
    }
    this.status('waiting-user', questionActivity(q), iteration);
    const answer = await this.deps.ask(q, signal);
    this.barStatus = before;
    if (answer) await this.restoreBar();
    return answer;
  }

  // ---------------------------------------------------------------------------
  // One step
  // ---------------------------------------------------------------------------

  /** Everything around one step, in the order at the top of this file. Skills drive steps through this too. */
  async runStep(step: ActStep, opts: StepOptions, signal: AbortSignal): Promise<StepOutcome> {
    if (signal.aborted) return STOPPED;
    await this.guard(signal, opts.iteration);
    if (signal.aborted) return STOPPED;

    const read = await this.deps.describe(step).catch((e: unknown): DescribeReply => ({ ok: false, code: 'unreachable', message: `The page could not be reached: ${e instanceof Error ? e.message : String(e)}` }));
    if (signal.aborted) return STOPPED;
    if (!read.ok) return { kind: 'failed', code: read.code, message: read.message, ...(read.closest ? { closest: read.closest } : {}), ...(read.broken ? { broken: read.broken } : {}) };
    const d = read.described;
    const host = hostOf(d.pageUrl);
    await this.pinSite(d.pageUrl);

    const askEveryStep = await this.deps.askEveryStep().catch(() => false);
    const allowances = await this.deps.loadAllowances(host);
    const decision = decide(d, allowances, {
      verb: step.do,
      ...(step.do === 'press' && step.text ? { key: step.text } : {}),
      siteHosts: this.hosts!,
      knownUrls: opts.knownUrls ?? [],
      askEveryStep,
      ...(opts.forceConfirm ? { forceConfirm: true } : {}),
    });
    const label = stepLabel(step, d);
    if (decision.kind === 'deny') {
      return { kind: 'refused', described: d, message: `Refused: ${decision.reason}. usermods does not do this; call wait_for with ask_user and say what the user should do.` };
    }

    let asked = false;
    if (decision.kind === 'confirm') {
      const answer = await this.confirm(step, d, label, host, decision, opts, askEveryStep, signal);
      if (!answer) return STOPPED;
      if (answer.kind === 'decline') return { kind: 'declined', label };
      asked = true;
    }
    if (signal.aborted) return STOPPED;

    if (!this.driving) {
      this.driving = true;
      this.record = recordPage({ ...this.record, startedAt: this.deps.now() }, d.pageUrl, host);
    }
    this.steps++;
    const inFlight = stepInFlight(step, d);
    opts.onRow?.({ state: 'running', text: inFlight });
    this.status('tool', `driving · ${inFlight}`, opts.iteration);
    await this.showBar({ status: `usermods is driving this page · step ${this.steps} · ${label}` }, signal, opts.iteration);
    if (signal.aborted) return STOPPED;

    await this.deps.journalWrite({ kind: opts.journalKind ?? 'act', label }).catch(() => {});
    const result = await this.perform(step, read.signature, d, signal);
    await this.deps.journalClear().catch(() => {});

    if (!result.ok) {
      if (result.code === 'cancelled') return STOPPED;
      if (result.code === 'never') return { kind: 'refused', described: result.described ?? d, message: result.message };
      return { kind: 'failed', code: result.code, message: result.message, described: result.described ?? d };
    }
    const words = stepDone(step, d, result);
    this.record = recordStep(this.record, step, words, result.clicks);
    if (result.navigating) {
      await this.deps.settled(signal).catch(() => {});
      await this.restoreBar();
    }
    return { kind: 'done', result, described: d, words, asked };
  }

  /** Ask, hold the outline up for as long as the question is, and write down what was allowed. */
  private async confirm(step: ActStep, d: Described, label: string, host: string, decision: Extract<GateDecision, { kind: 'confirm' }>, opts: StepOptions, askEveryStep: boolean, signal: AbortSignal): Promise<Answer | null> {
    const onlySite = decision.asksSite && !decision.reasons.length && !opts.forceConfirm && !askEveryStep;
    const times = step.repeat && step.repeat > 1 ? ` · up to ${step.repeat} times` : '';
    const where = whereWords(d);
    const q: Question = onlySite
      ? { kind: 'operate', id: this.deps.newId(), host }
      : {
          kind: 'allow',
          id: this.deps.newId(),
          host,
          headline: `${label}${times}`,
          ...(where ? { where } : {}),
          ...(opts.modelSays ? { modelSays: opts.modelSays } : {}),
          firstOnSite: decision.asksSite,
          ...(decision.actionKey ? { every: { label: `allow every "${d.name || d.role}" in this chat` } } : {}),
        };
    if (step.target) await this.deps.outline(step.target).catch(() => {});
    const answer = await this.askUser(q, signal, opts.iteration);
    await this.deps.outline(null).catch(() => {});
    if (!answer) return null;
    if (answer.kind !== 'allow') {
      // A first question declined leaves the page as it found it: nothing has operated it yet.
      if (!this.driving) await this.clearBar();
      return answer;
    }
    if (decision.asksSite) {
      await this.deps.allowSite(host, answer.standing === true);
      this.deps.emit({ type: 'note', text: `you allowed usermods to operate ${host}` });
    }
    if (q.kind === 'allow') {
      this.record = { ...this.record, allowed: this.record.allowed + 1 };
      if (answer.every && decision.actionKey) {
        await this.deps.allowAction(host, decision.actionKey);
        this.deps.emit({ type: 'note', text: `you ${q.every!.label}` });
      }
    }
    return answer;
  }

  private async clearBar(): Promise<void> {
    this.barStatus = null;
    this.barRaised = false;
    await this.setBar(null);
  }

  /** The step itself. Stop reaches it through `cancel`, and the run does not wait long for its answer. */
  private async perform(step: ActStep, signature: string, d: Described, signal: AbortSignal): Promise<ActResult> {
    const id = this.deps.newId();
    const onAbort = () => this.deps.cancel(id);
    signal.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = new Promise<ActResult>((resolve) => {
      const after = () => {
        timer = setTimeout(() => resolve({ ok: false, code: 'cancelled', message: 'Stopped.' }), STOP_GRACE_MS);
      };
      if (signal.aborted) after();
      else signal.addEventListener('abort', after, { once: true });
    });
    try {
      return await Promise.race([this.deps.perform(id, step, signature), stopped]);
    } catch {
      // The page went away with the answer, which for a click is the usual sign that it worked. It
      // is told as that, and not sent again.
      return {
        ok: true,
        text: 'The page navigated while this step ran, so its own result was lost with it. It has probably happened: look at the page before repeating anything.',
        described: d,
        delta: { dom: { added: 0, removed: 0, attributes: 0 }, urlBefore: d.pageUrl, urlAfter: d.pageUrl, newOperable: [] },
        navigating: true,
      };
    } finally {
      signal.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // The act tool
  // ---------------------------------------------------------------------------

  /** Steps in order, stopping at the first that does not happen. What comes back goes to the model. */
  async act(call: ActCall, ctx: ActContext, signal: AbortSignal): Promise<{ text: string; isError: boolean; waitedMs?: number }> {
    const lines: string[] = [];
    let known: string[] | undefined;
    const row = (index: number, step: StepRow) => this.deps.emit({ type: 'act_step', id: ctx.toolId, index, step });
    for (const [i, step] of call.steps.entries()) {
      if (step.do === 'go') known ??= knownUrls(ctx.history, await this.deps.pageUrl().catch(() => ''));
      const modelSays = call.description;
      const outcome = await this.runStep(step, { modelSays, ...(known ? { knownUrls: known } : {}), ...(ctx.iteration ? { iteration: ctx.iteration } : {}), onRow: (r) => row(i, { ...r, detail: { modelSays } }) }, signal);
      const left = call.steps.length - i - 1;
      const rest = left ? ` The ${left === 1 ? 'step' : `${left} steps`} after it did not run.` : '';
      switch (outcome.kind) {
        case 'done':
          row(i, { state: 'done', text: outcome.words, detail: { modelSays, read: readWords(outcome.described), result: outcome.result.text } });
          lines.push(outcome.result.text);
          continue;
        case 'declined':
          row(i, { state: 'declined', text: `not done · you declined: ${outcome.label}`, detail: { modelSays } });
          lines.push(`The user declined this step: ${outcome.label}. It did not happen.${rest} Do not try it another way, by script or otherwise, unless they ask. You may carry on with anything else, or tell them what is left.`);
          return { text: lines.join('\n'), isError: false };
        case 'refused':
          row(i, { state: 'failed', text: `refused · ${outcome.message.replace(/^Refused: /, '').split('.')[0]}`, detail: { modelSays, ...(outcome.described ? { read: readWords(outcome.described) } : {}), result: outcome.message } });
          lines.push(`${outcome.message}${rest}`);
          return { text: lines.join('\n'), isError: true };
        case 'failed': {
          const verb = step.do === 'scroll_to' ? 'scroll to' : step.do;
          const what = outcome.described ? (outcome.described.name ? `"${outcome.described.name}"` : outcome.described.role) : 'that';
          row(i, { state: 'failed', text: `could not ${verb} ${what} · ${outcome.message}`, detail: { modelSays, ...(outcome.described ? { read: readWords(outcome.described) } : {}), result: outcome.message } });
          lines.push(`Step ${i + 1} failed: ${outcome.message}${rest}`);
          return { text: lines.join('\n'), isError: true };
        }
        case 'stopped':
          row(i, { state: 'stopped', text: 'stopped', detail: { modelSays } });
          lines.push(`Stopped by the user.${rest}`);
          return { text: lines.join('\n'), isError: false };
      }
    }
    if (!call.thenWait) return { text: lines.join('\n'), isError: false };
    const startedAt = this.deps.now();
    const outcome = await this.deps.wait(call.thenWait, signal);
    const waited = renderWaitResult(call.thenWait, outcome);
    return { text: `${lines.join('\n')}\n\nthen_wait: ${waited.text}`, isError: !!outcome.failure, waitedMs: this.deps.now() - startedAt };
  }

  // ---------------------------------------------------------------------------
  // Your turn
  // ---------------------------------------------------------------------------

  /**
   * wait_for with ask_user. It ends when its condition holds or the user says so, and is not bound by
   * the 20 s a wait gets, because the time is the user's. During it the page may go anywhere: the
   * site rule is checked when the run takes the page back, at its next tool call.
   */
  async handoff(text: string, spec: WaitSpec | null, signal: AbortSignal, iteration?: number): Promise<{ by: 'user' | 'page' | 'stopped' | 'gone'; detail?: string }> {
    const words = text.trim().slice(0, 300);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    const q: Question = { kind: 'handoff', id: this.deps.newId(), text: words, ...(spec && spec.condition.kind !== 'ms' ? { until: describeCondition(spec.condition) } : {}) };
    const before = this.barStatus;
    this.barStatus = { status: `usermods · your turn: ${words}`, handoff: true };
    await this.setBar(this.barStatus);
    this.status('waiting-user', questionActivity(q), iteration);
    try {
      const user = this.deps.ask(q, controller.signal).then((a) => (a ? ({ by: 'user' } as const) : null));
      const page = spec && spec.condition.kind !== 'ms' ? this.watch(spec, controller.signal) : new Promise<null>(() => {});
      const first = await Promise.race([user.then((r) => r ?? ({ by: 'stopped' } as const)), page.then((r) => r ?? ({ by: 'stopped' } as const))]);
      if (first.by === 'user') {
        this.record = { ...this.record, yourself: this.record.yourself + 1 };
        this.deps.emit({ type: 'note', text: `you did this step: ${words}` });
      }
      return first;
    } finally {
      signal.removeEventListener('abort', onAbort);
      controller.abort();
      this.barStatus = before;
      if (!signal.aborted) await this.setBar(before);
    }
  }

  /** The condition, watched for as long as it takes, across the navigations signing in is made of. */
  private async watch(spec: WaitSpec, signal: AbortSignal): Promise<{ by: 'page' | 'gone'; detail?: string } | null> {
    while (!signal.aborted) {
      const outcome = await this.deps.wait(spec, signal);
      if (signal.aborted) return null;
      if (outcome.matched) return { by: 'page', ...(outcome.detail ? { detail: outcome.detail } : {}) };
      if (outcome.failure && /tab was closed/i.test(outcome.failure)) return { by: 'gone', detail: outcome.failure };
      // A timeout means only that the user is not done, and a failure that the page is changing.
      if (outcome.failure) await this.deps.sleep(500, signal);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Scripts, and the end
  // ---------------------------------------------------------------------------

  /** Before a script: "Ask before every step", then the journal. False when the user declined. */
  async beforeScript(description: string, code: string, signal: AbortSignal, iteration?: number): Promise<boolean> {
    if (await this.deps.askEveryStep().catch(() => false)) {
      const answer = await this.askUser({ kind: 'script', id: this.deps.newId(), description: description.slice(0, 300), code }, signal, iteration);
      if (!answer || answer.kind !== 'allow') return false;
    }
    await this.deps.journalWrite({ kind: 'script', label: `run a script: ${description.slice(0, 120) || 'no description'}` }).catch(() => {});
    return true;
  }

  async afterScript(): Promise<void> {
    await this.deps.journalClear().catch(() => {});
    if (this.driving) this.record = { ...this.record, scripts: this.record.scripts + 1 };
  }

  /** The run is over: the bar comes down, and what was recorded goes on a card if anything was. */
  async finish(ending: RunEnding): Promise<PageCard | null> {
    if (this.barRaised) await this.clearBar();
    return pageCard(this.record, ending, this.deps.now());
  }
}
