// What the gate is given about a target. Read here, from the live element, every time: a decision is
// never made from a model's description or from what a skill file claims the element is.
//
// The form facts come from attributes rather than from properties, because a form's properties can
// be clobbered by its own fields: `<input name="method">` makes `form.method` an element.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { liveProbe, type Probe } from '../inspect.ts';
import { trunc } from '../snapshot.ts';
import { fingerprintOf, type Fingerprint } from './registry.ts';
import { isDisabled, isEditable, landmarkOf, nameOf, roleOf, sameName } from './name.ts';

/** The kinds of field usermods never types into. */
export type SensitiveField = 'password' | 'one-time code' | 'card';

export interface FormFacts {
  /** Lowercased; a form with no method is 'get'. */
  method: string;
  /** Where it posts, as a path, when it says. */
  action?: string;
  /** A field this form holds that usermods will not submit: the never list's second clause. */
  holds?: SensitiveField;
  name?: string;
}

export interface Described {
  role: string;
  name: string;
  tag: string;
  /** The rendered text, when a label says something else: `aria-label="Details"` on a Delete. */
  text?: string;
  inputType?: string;
  disabled?: boolean;
  /** This element is a field usermods never types into. */
  field?: SensitiveField;
  form?: FormFacts;
  /** Pressing this submits `form`. */
  submits?: boolean;
  /** A link's target, or the place a submit button posts to. */
  link?: { href: string; path: string };
  /** The `go` verb's own target; such a step has no element. */
  go?: { kind: 'url'; href: string; path: string; host: string } | { kind: 'back' | 'forward' | 'reload' };
  landmark?: string;
  fingerprint: Fingerprint;
  /** The page the step would happen on. */
  pageUrl: string;
}

const CARD_AUTOCOMPLETE = /^cc-/;
const PASSWORD_WORDS = /\b(pass ?word|passwd|pwd|pass ?phrase|pass ?code|pin ?code)\b/i;
const OTP_WORDS = /\b(otp|totp|mfa|2fa|one[- ]?time|verification code|security code|auth(entication)? code|sms code|login code)\b/i;
const CARD_WORDS = /\b(card ?(number|no|num)|cc ?(num|number|no)|credit ?card|debit ?card|cvv|cvc|csc|cardholder|expiry|exp ?date)\b/i;

/** An attribute value as words: `card_number` and `cardNumber` both read "card number". */
const asWords = (s: string) => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_.[\]]+/g, ' ');

/**
 * Which never-list field this is, or nothing. Asks everything a field says about itself, because
 * the type alone is not enough: a one-time code is usually `type="text"`, and a show-password
 * button turns a password into one too. A false positive is a handoff; the other kind is not.
 */
export function sensitiveField(el: Element): SensitiveField | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag !== 'input' && tag !== 'textarea' && tag !== 'select' && !isEditable(el) && roleOf(el) !== 'textbox') return undefined;
  const type = (el.getAttribute('type') ?? '').trim().toLowerCase();
  if (type === 'hidden' || type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') return undefined;
  if (type === 'password') return 'password';
  const autocomplete = (el.getAttribute('autocomplete') ?? '').trim().toLowerCase().split(/\s+/);
  if (autocomplete.includes('current-password') || autocomplete.includes('new-password')) return 'password';
  if (autocomplete.includes('one-time-code')) return 'one-time code';
  if (autocomplete.some((a) => CARD_AUTOCOMPLETE.test(a))) return 'card';
  return sensitiveWords([el.getAttribute('name'), el.getAttribute('id'), el.getAttribute('placeholder'), el.getAttribute('aria-label'), nameOf(el)].filter(Boolean).join(' '));
}

/** Which never-list field these words describe, or nothing. A skill file's recorded name is read the same way. */
export function sensitiveWords(text: string): SensitiveField | undefined {
  const said = asWords(text);
  if (PASSWORD_WORDS.test(said)) return 'password';
  if (OTP_WORDS.test(said)) return 'one-time code';
  if (CARD_WORDS.test(said)) return 'card';
  return undefined;
}

/** The form an element belongs to: by its `form` attribute, or the one around it. */
export function formOf(el: Element): Element | null {
  const id = el.getAttribute('form');
  if (id) {
    const owner = el.ownerDocument?.querySelector?.(`form[id="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (owner) return owner;
  }
  return el.closest('form');
}

function fieldsOf(form: Element): Element[] {
  const inside = [...form.querySelectorAll('input, textarea, select, [contenteditable], [role="textbox"]')];
  const id = form.getAttribute('id');
  const outside = id ? [...(form.ownerDocument?.querySelectorAll(`[form="${id.replace(/["\\]/g, '\\$&')}"]`) ?? [])] : [];
  return [...inside, ...outside];
}

function absolute(href: string, base: string): URL | null {
  try {
    return new URL(href, base);
  } catch {
    return null;
  }
}

const baseOf = (el: Element, pageUrl: string) => el.baseURI || pageUrl;

function formFacts(form: Element, pageUrl: string, submitter?: Element): FormFacts {
  const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').trim().toLowerCase() || 'get';
  const action = submitter?.getAttribute('formaction') ?? form.getAttribute('action');
  const url = action ? absolute(action, baseOf(form, pageUrl)) : null;
  let holds: SensitiveField | undefined;
  for (const f of fieldsOf(form)) {
    holds = sensitiveField(f);
    if (holds) break;
  }
  const name = nameOf(form);
  return { method, ...(url ? { action: url.pathname } : {}), ...(holds ? { holds } : {}), ...(name ? { name } : {}) };
}

/**
 * What pressing this really activates: a click lands on the icon inside a button as often as on the
 * button. A label stands for its control.
 */
function activatorOf(el: Element): Element {
  const hit = el.closest('button, input, select, textarea, a[href], area[href], summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"]');
  if (hit) return hit;
  const label = el.closest('label');
  if (label) {
    const id = label.getAttribute('for');
    const control = id ? label.ownerDocument?.querySelector?.(`[id="${id.replace(/["\\]/g, '\\$&')}"]`) : label.querySelector('input, select, textarea, button');
    if (control) return control;
  }
  return el;
}

/** Does pressing this control submit its form? A scripted button in a form cannot be told apart, so it counts. */
function submitsForm(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (tag === 'button') return (el.getAttribute('type') ?? 'submit').trim().toLowerCase() === 'submit';
  if (tag === 'input') return ['submit', 'image'].includes((el.getAttribute('type') ?? '').trim().toLowerCase());
  return el.getAttribute('role') === 'button';
}

/**
 * Everything the gate may read about an element, taken now. The target's own text is kept alongside
 * the name when the two differ, so a control labelled one thing and showing another is judged on both.
 */
export function describeTarget(el: Element, opts: { probe?: Probe; pageUrl?: string; doc?: Document } = {}): Described {
  const probe = opts.probe ?? liveProbe;
  const pageUrl = opts.pageUrl ?? (typeof location !== 'undefined' ? location.href : '');
  const target = activatorOf(el);
  const role = roleOf(target);
  const name = nameOf(target);
  const tag = target.tagName.toLowerCase();
  const out: Described = { role, name, tag, pageUrl, fingerprint: fingerprintOf(target, { probe, withNth: true, ...(opts.doc ? { doc: opts.doc } : {}) }) };
  const field = sensitiveField(target);
  if (field) out.field = field;
  else if (!isEditable(target) && tag !== 'select' && tag !== 'textarea' && role !== 'textbox') {
    const text = trunc((target as HTMLElement).innerText ?? target.textContent ?? '', 200);
    if (text && !sameName(text, name)) out.text = text;
  }
  if (tag === 'input') out.inputType = (target.getAttribute('type') ?? 'text').trim().toLowerCase();
  if (isDisabled(target)) out.disabled = true;
  const form = formOf(target);
  if (form) {
    const submits = submitsForm(target);
    out.form = formFacts(form, pageUrl, submits ? target : undefined);
    if (submits) out.submits = true;
  }
  const href = target.getAttribute('href');
  if (href !== null) {
    const url = absolute(href, baseOf(target, pageUrl));
    out.link = url ? { href: url.href, path: url.pathname } : { href, path: '' };
  }
  const landmark = landmarkOf(target);
  if (landmark) out.landmark = landmark;
  return out;
}

/** The stand-in for a `go` step, which has no element: where it goes, and from where. */
export function describeGo(text: string, pageUrl: string): Described {
  const t = text.trim();
  const fingerprint: Fingerprint = { role: 'page', name: t, tag: '' };
  const base = { role: 'page', name: t, tag: '', fingerprint, pageUrl };
  if (t === 'back' || t === 'forward' || t === 'reload') return { ...base, go: { kind: t } };
  const url = absolute(t, pageUrl);
  return { ...base, go: { kind: 'url', href: url?.href ?? t, path: url?.pathname ?? '', host: url?.hostname ?? '' } };
}

/**
 * The facts a gate decision rested on, as one string. `describe` returns it and `act` must hand it
 * back: between the two a question can have been up for minutes, and a page can have renamed or
 * rebuilt the control, so the step is refused unless the live element still reads the same.
 */
export function signatureOf(d: Described): string {
  return JSON.stringify([d.role, d.name.toLowerCase(), d.tag, d.text ?? '', d.field ?? '', d.submits ?? false, d.form?.method ?? '', d.form?.action ?? '', d.form?.holds ?? '', d.link?.href ?? '', d.go ?? '']);
}
