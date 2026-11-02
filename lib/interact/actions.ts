// Carrying out one step on the page: click, fill, select, check, press, hover, scroll_to, go.
//
// Everything here is synthetic input, so `event.isTrusted` is false and what a page's handler checks
// for that cannot be helped (docs/specs/browser-use.md, section 3.1). What can be helped is done: the
// full pointer sequence with coordinates, because menu libraries listen on pointerdown; the check that
// the element under the point is the target, so a cookie wall is reported and not clicked through; the
// text ladder of lib/sharefill.ts, generalised; a read-back after filling.
//
// The step runs here only after it has been described and gated. This file still re-reads the live
// element first, for two refusals that do not depend on the background having been right:
//   - the never list (lib/agent/gate.ts), checked again on every click of a repeat;
//   - the signature: `describe` handed one out, `act` must give it back, and a control that no longer
//     reads the same is refused, because the question may have been up for minutes.
//
// What a field was filled with is never in a result. It goes to the model, and it goes to the
// record a skill is made from.
//
// DOM only, with what needs layout or frames behind ActionDeps, so node tests drive it.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { CHECKABLE_ROLES, neverReason, type Verb } from '../agent/gate.ts';
import { describeNode, liveProbe, parentOf, type Probe } from '../inspect.ts';
import { paste, selectAll, setFieldValue, settle } from '../sharefill.ts';
import { normalizeText } from '../waitdom.ts';
import { renderDelta, watchDelta, type Delta, type DeltaWatch } from './delta.ts';
import { describeGo, describeTarget, formOf, signatureOf, type Described } from './describe.ts';
import { formatRoleName, isDisabled, isEditable, nameOf, roleOf, sameName } from './name.ts';
import type { Registry } from './registry.ts';
import { operableElements, type BrokenTarget, type Closest, type TargetSpec } from './target.ts';

/** A step as the content script receives it. `target` is absent only for `go` and `press`. */
export interface ActStep {
  target?: TargetSpec;
  do: Verb;
  text?: string;
  /** Click only: how many times, at most MAX_REPEAT. */
  repeat?: number;
}

/** The most clicks one step may make. */
export const MAX_REPEAT = 50;

/** How long a repeat waits for the next element, or for an answer, before it ends. */
const REPEAT_WAIT_MS = 2500;
/** How long the page must have been still, after it answered, before the same control is pressed again. */
const REPEAT_QUIET_MS = 300;
const REPEAT_POLL_MS = 50;
/** How long a moving element gets to come to rest. */
const STABLE_TIMEOUT_MS = 800;
/** After a step, a moment for the page's synchronous answer to land before the delta is read. */
const SETTLE_MS = 120;

export type ActFailure =
  /** On the never list; hand it to the user. */
  | 'never'
  /** The live element no longer reads as what was gated. */
  | 'changed'
  /** The target did not resolve to one element. */
  | 'broken'
  | 'hidden'
  | 'disabled'
  | 'covered'
  | 'unstable'
  /** This verb cannot be done to this element. */
  | 'unsupported'
  /** The value did not take; a synthetic route does not work here. */
  | 'readback'
  | 'cancelled';

export type ActResult =
  | {
      ok: true;
      /** The step in words for the model: what was done, what changed. */
      text: string;
      /** The element as read just before it was acted on. */
      described: Described;
      /** How many clicks a repeat made. */
      clicks?: number;
      delta: Delta;
      /** A ref's element was re-rendered and the ref now names its replacement. */
      rebound?: boolean;
      /** The page began to leave; the rest of the story belongs to the next document. */
      navigating?: boolean;
    }
  | { ok: false; code: ActFailure; message: string; described?: Described; closest?: Closest[]; broken?: BrokenTarget['reason'] };

/** What the action code needs from the page, injectable for tests. */
export interface ActionDeps {
  registry: Registry;
  probe?: Probe;
  doc?: Document;
  pageUrl?: string;
  isCancelled?: () => boolean;
  /** The element at a point, through open shadow roots. */
  hit?: (x: number, y: number) => Element | null;
  /** Resolves on the next frame; never hangs on a tab that paints nothing. */
  nextFrame?: () => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Point at the target before acting; lib/pageui.ts's flash. */
  flash?: (el: Element) => void;
  /** Leave this document, after the answer has gone. */
  navigate?: (go: { kind: 'url'; href: string } | { kind: 'back' | 'forward' | 'reload' }) => void;
  /** Resolves if the page starts to unload. */
  leaving?: Promise<void>;
  /** Start counting what changes. Tests hand in a fake; the page has a MutationObserver. */
  watch?: () => DeltaWatch;
}

const liveSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** requestAnimationFrame, raced with a timer: a hidden tab paints nothing and a step must not hang. */
function liveFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    requestAnimationFrame(finish);
    setTimeout(finish, 100);
  });
}

/** elementFromPoint, descending through open shadow roots. */
function liveHit(doc: Document): (x: number, y: number) => Element | null {
  return (x, y) => {
    let el = doc.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  };
}

// ---------------------------------------------------------------------------
// Whether the element can be acted on
// ---------------------------------------------------------------------------

/** Is the hit the target, part of it, around it through a slot, or the target's own label? */
export function hitIsTarget(el: Element, hit: Element): boolean {
  if (hit.hasAttribute('data-usermods')) return true; // our own bar over the point; events go direct
  for (let cur: Element | null = hit; cur; cur = parentOf(cur).el) {
    if (cur === el) return true;
    if (cur.tagName === 'LABEL') {
      const id = cur.getAttribute('for');
      if (id ? el.getAttribute('id') === id : cur.contains(el)) return true;
    }
  }
  return false;
}

type Point = { x: number; y: number };

/** The page-facing half of ActionDeps, with its defaults filled in. */
interface Ready {
  probe: Probe;
  nextFrame: () => Promise<void>;
  hit: (x: number, y: number) => Element | null;
  sleep: (ms: number) => Promise<void>;
  isCancelled: () => boolean;
  now: () => number;
}

/**
 * Connected, shown, enabled, at rest across two frames, and the element under its centre is the
 * target. Each failure says which, in words the model can act on.
 */
async function actionable(el: Element, label: string, deps: Ready): Promise<{ ok: true; point: Point } | { ok: false; code: ActFailure; message: string }> {
  if (!el.isConnected) return { ok: false, code: 'hidden', message: `${label} is no longer on the page` };
  if (!deps.probe.visible(el)) return { ok: false, code: 'hidden', message: `${label} is hidden` };
  if (isDisabled(el)) return { ok: false, code: 'disabled', message: `${label} is disabled` };
  try {
    el.scrollIntoView?.({ block: 'center', behavior: 'instant' as ScrollBehavior });
  } catch {
    /* an element that cannot scroll is still acted on where it is */
  }
  let box = deps.probe.box(el);
  const end = deps.now() + STABLE_TIMEOUT_MS;
  for (;;) {
    await deps.nextFrame();
    await deps.nextFrame();
    const next = deps.probe.box(el);
    const still = Math.abs(next.x - box.x) < 1 && Math.abs(next.y - box.y) < 1 && Math.abs(next.w - box.w) < 1 && Math.abs(next.h - box.h) < 1;
    box = next;
    if (still) break;
    if (deps.now() > end) return { ok: false, code: 'unstable', message: `${label} kept moving` };
    if (deps.isCancelled()) return { ok: false, code: 'cancelled', message: 'Stopped.' };
  }
  if (box.w <= 0 || box.h <= 0) return { ok: false, code: 'hidden', message: `${label} has no size on the page` };
  const point = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
  const hit = deps.hit(point.x, point.y);
  if (hit && !hitIsTarget(el, hit)) return { ok: false, code: 'covered', message: `${label} is covered by ${describeNode(hit)}` };
  return { ok: true, point };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

type EventCtorName = 'PointerEvent' | 'MouseEvent' | 'KeyboardEvent';

/** Build and dispatch one event; a page without the constructor (a parsed page in a test) gets a plain one. */
function fire(el: Element, ctor: EventCtorName, type: string, init: Record<string, unknown>): boolean {
  const g = globalThis as unknown as Record<string, typeof Event | undefined>;
  const Ctor = g[ctor] ?? g.Event!;
  const ev = new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init } as EventInit);
  return el.dispatchEvent(ev);
}

/**
 * The full sequence a real press makes. Activation comes from the `click` event itself: a dispatched
 * click runs a link's, a checkbox's and a submit button's activation behaviour. A link or form that
 * would open a new tab is retargeted for the moment, since a run cannot follow one.
 */
function pressWithPointer(el: Element, p: Point): void {
  const init = { clientX: p.x, clientY: p.y, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true };
  const up = { ...init, buttons: 0 };
  fire(el, 'PointerEvent', 'pointerover', init);
  fire(el, 'MouseEvent', 'mouseover', init);
  fire(el, 'PointerEvent', 'pointerdown', init);
  fire(el, 'MouseEvent', 'mousedown', init);
  (el as HTMLElement).focus?.();
  fire(el, 'PointerEvent', 'pointerup', up);
  fire(el, 'MouseEvent', 'mouseup', up);
  const restore = retarget(el);
  fire(el, 'MouseEvent', 'click', up);
  restore();
}

/** `target=_blank` to `_self` around one click, on the link or the form the click would use. */
function retarget(el: Element): () => void {
  const opener = el.closest('a[href], area[href]') ?? (el.closest('button, input') ? formOf(el) : null);
  const was = opener?.getAttribute('target');
  if (!opener || !was || was.toLowerCase() === '_self') return () => {};
  opener.setAttribute('target', '_self');
  return () => opener.setAttribute('target', was);
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

const TEXT_INPUT_REFUSED = new Set(['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file', 'hidden', 'color', 'range']);

/** Select an editor's whole content, whatever has focus: execCommand needs a real selection. */
function selectContents(el: HTMLElement): void {
  const doc = el.ownerDocument;
  const sel = doc.getSelection?.();
  if (!sel || !doc.createRange) return;
  const range = doc.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** The rich-editor half of the ladder: a synthetic paste, then insertText. Each is checked. */
async function fillEditable(el: HTMLElement, text: string): Promise<boolean> {
  const took = () => normalizeText(el.textContent ?? '') === normalizeText(text);
  el.focus?.();
  selectContents(el);
  selectAll(el);
  paste(el, text);
  if (await settle(took, 250)) return true;
  selectContents(el);
  try {
    el.ownerDocument.execCommand?.('insertText', false, text);
  } catch {
    /* not supported here */
  }
  return settle(took, 250);
}

async function doFill(el: Element, label: string, text: string): Promise<{ ok: true } | { ok: false; code: ActFailure; message: string }> {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') {
    const field = el as HTMLInputElement;
    if (tag === 'INPUT' && TEXT_INPUT_REFUSED.has((el.getAttribute('type') ?? '').toLowerCase())) return { ok: false, code: 'unsupported', message: `${label} is not a text field` };
    if (field.readOnly) return { ok: false, code: 'unsupported', message: `${label} is read-only` };
    field.focus?.();
    setFieldValue(field, text);
    if (field.value !== text) return { ok: false, code: 'readback', message: `${label} did not keep what was typed: the page may build its value from key presses. Hand this to the user` };
    field.blur?.();
    return { ok: true };
  }
  if (isEditable(el) || roleOf(el) === 'textbox') {
    if (await fillEditable(el as HTMLElement, text)) return { ok: true };
    return { ok: false, code: 'readback', message: `${label} ignored synthetic typing. Hand this to the user` };
  }
  return { ok: false, code: 'unsupported', message: `${label} cannot be typed into` };
}

function doSelect(el: Element, label: string, text: string): { ok: true; chose: string } | { ok: false; code: ActFailure; message: string } {
  if (el.tagName !== 'SELECT') return { ok: false, code: 'unsupported', message: `${label} is not a native list. Click it, then click the option` };
  const select = el as HTMLSelectElement;
  const options = [...el.querySelectorAll('option')];
  const want = normalizeText(text);
  const hits = options.filter((o) => normalizeText(o.textContent ?? '') === want);
  const picked = hits.length ? hits : options.filter((o) => o.getAttribute('value') === text);
  if (picked.length !== 1) return { ok: false, code: 'unsupported', message: `${label} has ${picked.length ? 'several options' : 'no option'} reading what was asked for` };
  const option = picked[0]!;
  if (option.hasAttribute('disabled')) return { ok: false, code: 'disabled', message: `That option in ${label} is disabled` };
  (option as HTMLOptionElement).selected = true;
  if (select.value !== (option as HTMLOptionElement).value) return { ok: false, code: 'readback', message: `${label} did not keep the choice` };
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true, chose: (option.textContent ?? '').trim() };
}

const WANTS_OFF = /^(false|off|no|uncheck|unticked?|0)$/i;

function isChecked(el: Element): boolean {
  if (el.tagName === 'INPUT') return (el as HTMLInputElement).checked === true;
  return el.getAttribute('aria-checked') === 'true';
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEY_CODES: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', ' ': 'Space', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Backspace: 'Backspace', Delete: 'Delete' };

function canonicalKey(key: string): string {
  const k = key.trim();
  const lower = k.toLowerCase();
  if (key === ' ' || lower === 'space') return ' ';
  if (lower === 'esc') return 'Escape';
  for (const name of Object.keys(KEY_CODES)) if (name.toLowerCase() === lower) return name;
  return k;
}

const TABBABLE = 'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable]';

/** Untrusted key events do nothing by themselves. Two defaults are worth doing: Tab, and Enter in a form. */
function pressKey(el: Element, key: string, probe: Probe): void {
  const init = { key, code: KEY_CODES[key] ?? (key.length === 1 ? `Key${key.toUpperCase()}` : key) };
  (el as HTMLElement).focus?.();
  const carriedOn = fire(el, 'KeyboardEvent', 'keydown', init);
  if (key.length === 1 || key === 'Enter') fire(el, 'KeyboardEvent', 'keypress', init);
  fire(el, 'KeyboardEvent', 'keyup', init);
  if (!carriedOn) return;
  const tag = el.tagName;
  if (key === 'Enter') {
    if (tag === 'BUTTON' || tag === 'A' || tag === 'SUMMARY') {
      fire(el, 'MouseEvent', 'click', {});
      return;
    }
    const form = tag === 'INPUT' || tag === 'SELECT' ? formOf(el) : null;
    if (form) requestSubmit(form);
  } else if (key === ' ') {
    if (tag === 'BUTTON' || tag === 'SUMMARY' || (tag === 'INPUT' && ['checkbox', 'radio'].includes(el.getAttribute('type') ?? ''))) fire(el, 'MouseEvent', 'click', {});
  } else if (key === 'Tab') {
    const doc = el.ownerDocument;
    const all = [...doc.querySelectorAll(TABBABLE)].filter((e) => e.getAttribute('tabindex') !== '-1' && probe.visible(e) && !isDisabled(e));
    const next = all[all.indexOf(el) + 1];
    (next as HTMLElement | undefined)?.focus?.();
  }
}

/** Through the prototype: `<input name="requestSubmit">` shadows the form's own method. */
function requestSubmit(form: Element): void {
  const proto = Object.getPrototypeOf(form) as { requestSubmit?: (this: Element) => void };
  proto.requestSubmit?.call(form);
}

// ---------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------

const refused = (d: Described, reason: string): ActResult => ({
  ok: false,
  code: 'never',
  described: d,
  message: `Refused: ${reason}. usermods does not do this; call wait_for with ask_user and say what the user should do.`,
});

type StepRead =
  | { ok: true; described: Described; signature: string; el?: Element; rebound?: boolean }
  | { ok: false; code: 'broken'; message: string; closest: Closest[]; broken: BrokenTarget['reason'] };

function readStep(step: ActStep, deps: ActionDeps): StepRead {
  const pageUrl = deps.pageUrl ?? location.href;
  if (step.do === 'go') {
    const described = describeGo(step.text ?? '', pageUrl);
    return { ok: true, described, signature: signatureOf(described) };
  }
  const doc = deps.doc ?? document;
  const active = step.do === 'press' && !step.target ? (doc.activeElement ?? doc.body) : null;
  if (!step.target && !active) return { ok: false, code: 'broken', message: `${step.do} needs a target`, closest: [], broken: 'none' };
  const found = step.target ? deps.registry.resolve(step.target) : { kind: 'found' as const, el: active!, rebound: false };
  if (found.kind === 'broken') return { ok: false, code: 'broken', message: found.message, closest: found.closest, broken: found.reason };
  const described = describeTarget(found.el, { probe: deps.probe ?? liveProbe, pageUrl, ...(deps.doc ? { doc: deps.doc } : {}) });
  return { ok: true, described, signature: signatureOf(described), el: found.el, ...(found.rebound ? { rebound: true } : {}) };
}

/**
 * What the gate is given: the step's target as read from the live page, with the signature `act`
 * must hand back. Plain data, since this crosses to the background.
 */
export function describeStep(step: ActStep, deps: ActionDeps): { ok: true; described: Described; signature: string; rebound?: boolean } | Extract<StepRead, { ok: false }> {
  const read = readStep(step, deps);
  if (!read.ok) return read;
  return { ok: true, described: read.described, signature: read.signature, ...(read.rebound ? { rebound: true } : {}) };
}

/**
 * Carry out a step that has been described and gated. `expect` is the signature `describe` returned;
 * a step that has none, or the wrong one, does not run.
 */
export async function runStep(step: ActStep, expect: string, deps: ActionDeps): Promise<ActResult> {
  const probe = deps.probe ?? liveProbe;
  const doc = deps.doc ?? document;
  const nextFrame = deps.nextFrame ?? liveFrame;
  const hit = deps.hit ?? liveHit(doc);
  const sleep = deps.sleep ?? liveSleep;
  const isCancelled = deps.isCancelled ?? (() => false);
  const ready: Ready = { probe, nextFrame, hit, sleep, isCancelled, now: deps.now ?? Date.now };

  if (isCancelled()) return { ok: false, code: 'cancelled', message: 'Stopped before this step.' };
  const read = readStep(step, deps);
  if (!read.ok) return read;
  const described = read.described;
  const never = neverReason(described, step.do, step.text);
  if (never) return refused(described, never);
  if (read.signature !== expect) return { ok: false, code: 'changed', described, message: `The target changed after it was checked: it now reads ${formatRoleName(described.role, described.name)}. Nothing was done.` };

  if (step.do === 'go') return runGo(described, deps);

  const el = read.el!;
  const label = formatRoleName(described.role, described.name);
  const refNote = step.target && 'ref' in step.target ? ` (${step.target.ref})` : '';
  const watch = (deps.watch ?? (() => watchDelta({ doc, probe, ...(deps.pageUrl ? { url: () => deps.pageUrl! } : {}) })))();
  const finish = async (result: { words: string; clicks?: number }): Promise<ActResult> => {
    const leaving = deps.leaving ? await Promise.race([deps.leaving.then(() => true), sleep(SETTLE_MS).then(() => false)]) : (await sleep(SETTLE_MS), false);
    const delta = watch.finish();
    return {
      ok: true,
      text: `${result.words}\n${renderDelta(delta)}`,
      described,
      delta,
      ...(result.clicks !== undefined ? { clicks: result.clicks } : {}),
      ...(read.rebound ? { rebound: true } : {}),
      ...(leaving ? { navigating: true } : {}),
    };
  };
  const fail = (f: { code: ActFailure; message: string }): ActResult => {
    watch.finish();
    return { ok: false, code: f.code, message: f.message, described };
  };

  if (step.do === 'scroll_to') {
    try {
      el.scrollIntoView?.({ block: 'center', behavior: 'instant' as ScrollBehavior });
    } catch {
      /* said to have scrolled only if it did not throw */
    }
    return finish({ words: `Scrolled to ${label}${refNote}.` });
  }

  deps.flash?.(el);
  if (step.do === 'press') {
    const key = canonicalKey(step.text ?? '');
    if (!key) return fail({ code: 'unsupported', message: 'press needs a key' });
    pressKey(el, key, probe);
    return finish({ words: `Pressed ${key === ' ' ? 'Space' : key} in ${label}${refNote}.` });
  }

  const can = await actionable(el, label, ready);
  if (!can.ok) return fail(can);
  if (isCancelled()) return fail({ code: 'cancelled', message: 'Stopped before this step.' });

  switch (step.do) {
    case 'click': {
      const times = Math.min(Math.max(1, Math.floor(step.repeat ?? 1)), MAX_REPEAT);
      const before = watch.changes();
      pressWithPointer(el, can.point);
      if (times === 1) return finish({ words: `Clicked ${label}${refNote}.`, clicks: 1 });
      return finish(await repeatClicks(el, before, described, label, refNote, times, { ...ready, doc, pageUrl: deps.pageUrl ?? location.href, flash: deps.flash, changes: () => watch.changes() }));
    }
    case 'hover': {
      const init = { clientX: can.point.x, clientY: can.point.y };
      for (const [ctor, type] of [['PointerEvent', 'pointerover'], ['MouseEvent', 'mouseover'], ['PointerEvent', 'pointerenter'], ['MouseEvent', 'mouseenter'], ['MouseEvent', 'mousemove']] as const) fire(el, ctor, type, init);
      return finish({ words: `Hovered ${label}${refNote}. A menu that opens on pure CSS :hover does not respond to this.` });
    }
    case 'fill': {
      const r = await doFill(el, label, step.text ?? '');
      if (!r.ok) return fail(r);
      return finish({ words: `Filled ${label}${refNote}.` });
    }
    case 'select': {
      const r = doSelect(el, label, step.text ?? '');
      if (!r.ok) return fail(r);
      // Not which: during a skill's repair it is the user's input, and the model is not told that.
      return finish({ words: `Chose an option in ${label}${refNote}.` });
    }
    case 'check': {
      // It presses the element, so anywhere else it is a click nothing asked about as one.
      if (!CHECKABLE_ROLES.has(described.role)) return fail({ code: 'unsupported', message: `${label} is not something that can be ticked` });
      const want = !WANTS_OFF.test(step.text ?? '');
      if (isChecked(el) !== want) pressWithPointer(el, can.point);
      if (isChecked(el) !== want) return fail({ code: 'readback', message: `${label} did not change` });
      return finish({ words: `Set ${label}${refNote} ${want ? 'on' : 'off'}.` });
    }
  }
}

function runGo(described: Described, deps: ActionDeps): ActResult {
  const go = described.go!;
  const url = deps.pageUrl ?? location.href;
  const delta: Delta = { dom: { added: 0, removed: 0, attributes: 0 }, urlBefore: url, urlAfter: url, newOperable: [] };
  // After the answer has gone: the navigation takes this document, and the message channel with it.
  const navigate =
    deps.navigate ??
    ((g) => {
      setTimeout(() => {
        if (g.kind === 'back') history.back();
        else if (g.kind === 'forward') history.forward();
        else if (g.kind === 'url') location.assign(g.href);
        else location.reload();
      }, 0);
    });
  if (go.kind === 'url') {
    navigate({ kind: 'url', href: go.href });
    return { ok: true, text: `Went to ${go.href}.`, described, delta, navigating: true };
  }
  navigate({ kind: go.kind });
  const words = go.kind === 'reload' ? 'Reloaded the page.' : `Went ${go.kind}.`;
  return { ok: true, text: words, described, delta, navigating: true };
}

/**
 * The rest of a `repeat`, after the first click: find the element with the same role and name again,
 * and stop when none is left. An element clicked once is not clicked again while another is there, or
 * while nothing has answered: a row that takes two seconds to vanish must not get a second Unsubscribe.
 * So the one case that re-presses is a single control that stays ("Show more"), after the page has
 * visibly answered the last press and then gone still. Stop is honoured between clicks, and the never
 * list and the submit fact are read again for each new element, since it was asked about once.
 */
async function repeatClicks(first: Element, firstPressedAt: number, described: Described, label: string, refNote: string, times: number, deps: Ready & { doc: Document; pageUrl: string; flash?: ((el: Element) => void) | undefined; changes: () => number }): Promise<{ words: string; clicks: number }> {
  const clicked = new Set<Element>([first]);
  let clicks = 1;
  let last = first;
  // The change count just before the latest press: a handler that answers synchronously still counts.
  let pressedAt = firstPressedAt;
  let ending = 'none left';
  const same = (el: Element) => roleOf(el) === described.role && sameName(nameOf(el), described.name) && !isDisabled(el);
  while (clicks < times) {
    if (deps.isCancelled()) {
      ending = 'stopped';
      break;
    }
    const startedWaiting = deps.now();
    let seen = pressedAt;
    let stillSince = startedWaiting;
    let next: Element | null = null;
    while (!next && deps.now() - startedWaiting < REPEAT_WAIT_MS) {
      await deps.sleep(REPEAT_POLL_MS);
      if (deps.isCancelled()) break;
      const now = deps.changes();
      if (now !== seen) {
        seen = now;
        stillSince = deps.now();
      }
      const candidates = operableElements(deps.probe, undefined, deps.doc).found.filter(same);
      next = candidates.find((el) => !clicked.has(el)) ?? null;
      const answered = seen !== pressedAt && deps.now() - stillSince >= REPEAT_QUIET_MS;
      if (!next && answered && clicked.size === 1 && candidates.includes(last)) next = last;
    }
    if (deps.isCancelled()) {
      ending = 'stopped';
      break;
    }
    if (!next) {
      if (last.isConnected && clicked.size === 1 && seen === pressedAt) ending = 'it did not change the page';
      break;
    }
    const live = describeTarget(next, { probe: deps.probe, pageUrl: deps.pageUrl, doc: deps.doc });
    const never = neverReason(live, 'click');
    if (never) {
      ending = `stopped: ${never}`;
      break;
    }
    if (!!live.submits !== !!described.submits) {
      ending = 'stopped: the next one does something different';
      break;
    }
    deps.flash?.(next);
    const can = await actionable(next, label, deps);
    if (!can.ok) {
      ending = `stopped: ${can.message}`;
      break;
    }
    pressedAt = deps.changes();
    pressWithPointer(next, can.point);
    clicked.add(next);
    last = next;
    clicks++;
    if (clicks === times) ending = '';
  }
  return { words: `Clicked ${label}${refNote}, ${clicks} time${clicks === 1 ? '' : 's'}${ending ? `; ${ending}` : ''}.`, clicks };
}
