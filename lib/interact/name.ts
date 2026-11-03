// Role and accessible name, computed in the page. No accessibility tree reaches a content script,
// so this is a heuristic in the usual order: aria-label, aria-labelledby, <label>, alt, title,
// placeholder, text. It is what the inventory prints, what the gate reads and what a skill records,
// so one rule holds throughout: a name never carries what somebody typed. A field's value, a
// textarea's content and a contenteditable's text are the user's and stay out of it.
//
// DOM only, no chrome.* and no layout but what a Probe answers, so node tests run it on a parsed
// page (test/interact.test.ts).

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { parentOf, type Probe } from '../inspect.ts';
import { trunc } from '../snapshot.ts';

/** Longest name printed or compared. Cut the same way every time, so two reads compare equal. */
export const MAX_NAME = 80;

const INPUT_ROLES: Record<string, string> = {
  button: 'button',
  submit: 'button',
  reset: 'button',
  image: 'button',
  file: 'button',
  color: 'button',
  checkbox: 'checkbox',
  radio: 'radio',
  range: 'slider',
  number: 'spinbutton',
  search: 'searchbox',
};

const TAG_ROLES: Record<string, string> = {
  button: 'button',
  summary: 'button',
  textarea: 'textbox',
  nav: 'navigation',
  main: 'main',
  header: 'banner',
  footer: 'contentinfo',
  aside: 'complementary',
  form: 'form',
  table: 'table',
  tr: 'row',
  th: 'columnheader',
  td: 'cell',
  ul: 'list',
  ol: 'list',
  li: 'listitem',
  dialog: 'dialog',
  option: 'option',
  fieldset: 'group',
  article: 'article',
  img: 'img',
  h1: 'heading',
  h2: 'heading',
  h3: 'heading',
  h4: 'heading',
  h5: 'heading',
  h6: 'heading',
};

/** Roles whose name comes from their own labels and a heading, never from all the text inside. */
const CONTAINER_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region', 'dialog', 'alertdialog', 'table', 'group', 'article', 'list', 'menu', 'toolbar', 'tabpanel', 'tablist', 'grid', 'tree']);

/** The places a target is said to be `in`, for a fingerprint and for the inventory's nesting. */
export const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'search', 'form', 'region', 'dialog', 'alertdialog', 'table', 'tabpanel', 'toolbar', 'menu', 'article']);

/** ARIA roles a user operates. */
const INTERACTIVE_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'combobox', 'listbox', 'searchbox', 'textbox', 'slider', 'spinbutton', 'treeitem']);

const tagOf = (el: Element) => el.tagName.toLowerCase();

export function isEditable(el: Element): boolean {
  const ce = el.getAttribute('contenteditable');
  return ce !== null && ce.toLowerCase() !== 'false';
}

/** The role a page gives an element, or the one its tag implies. 'generic' when it has neither. */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute('role')?.trim().toLowerCase().split(/\s+/)[0];
  if (explicit && explicit !== 'none' && explicit !== 'presentation') return explicit;
  const tag = tagOf(el);
  if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : 'generic';
  if (tag === 'input') return INPUT_ROLES[(el.getAttribute('type') ?? 'text').trim().toLowerCase()] ?? 'textbox';
  if (tag === 'select') return el.hasAttribute('multiple') || Number(el.getAttribute('size')) > 1 ? 'listbox' : 'combobox';
  if (tag === 'section') return ownLabel(el) ? 'region' : 'generic';
  if (isEditable(el)) return 'textbox';
  return TAG_ROLES[tag] ?? 'generic';
}

const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

function rootOf(el: Element): ParentNode & { getElementById?: (id: string) => Element | null } {
  return (el.getRootNode?.() ?? el.ownerDocument) as ParentNode & { getElementById?: (id: string) => Element | null };
}

function byId(el: Element, id: string): Element | null {
  const root = rootOf(el);
  return root.getElementById?.(id) ?? root.querySelector?.(`[id="${id.replace(/["\\]/g, '\\$&')}"]`) ?? null;
}

function renderedText(el: Element): string {
  return clean((el as HTMLElement).innerText ?? el.textContent);
}

/** aria-label, then aria-labelledby: what a page says outright. */
function ownLabel(el: Element): string {
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const ids = clean(el.getAttribute('aria-labelledby'));
  if (!ids) return '';
  return clean(ids.split(' ').map((id) => (byId(el, id) ? renderedText(byId(el, id)!) : '')).join(' '));
}

/** The text of the <label> for a form control, by `for` or by wrapping. */
function labelOf(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    const root = rootOf(el);
    const label = root.querySelector?.(`label[for="${id.replace(/["\\]/g, '\\$&')}"]`);
    if (label) return controlLabelText(label);
  }
  for (let p = el.parentElement; p; p = p.parentElement) if (tagOf(p) === 'label') return controlLabelText(p);
  return '';
}

/** A wrapping label's text without its control's: a select inside it would list every option. */
function controlLabelText(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  for (const c of [...copy.querySelectorAll('input, select, textarea, button')]) c.remove();
  return clean(copy.textContent);
}

/** Text for a control with none of its own: an icon button's image or its svg title. */
function innerImageName(el: Element): string {
  const img = el.querySelector('img[alt], [aria-label], svg title');
  if (!img) return '';
  return clean(img.getAttribute('alt') ?? img.getAttribute('aria-label') ?? img.textContent);
}

function containerName(el: Element, role: string): string {
  const own = ownLabel(el) || clean(el.getAttribute('title'));
  if (own) return own;
  if (role === 'table') {
    const caption = el.querySelector('caption');
    if (caption) return clean(caption.textContent);
  }
  if (role === 'group') {
    const legend = el.querySelector('legend');
    if (legend) return clean(legend.textContent);
  }
  if (role === 'form' || role === 'dialog' || role === 'alertdialog' || role === 'region' || role === 'article') {
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6, legend');
    if (heading) return clean(heading.textContent);
  }
  return '';
}

/** The cells of a row, which is how a row is told apart from the next: `12 Sep · Headphones · €89.00`. */
function rowName(el: Element): string {
  const cells = [...el.children].filter((c) => !c.querySelector('a[href], button, input, select, textarea'));
  return cells.map(renderedText).filter(Boolean).join(' · ');
}

function fieldName(el: Element): string {
  return ownLabel(el) || labelOf(el) || clean(el.getAttribute('title')) || clean(el.getAttribute('placeholder'));
}

/**
 * The accessible name, cut at MAX_NAME. Text fields, selects and rich editors are named only from
 * what labels them: their content is the user's. An input button is the one input whose value is a
 * name, because it is the page's own label for the button.
 */
export function nameOf(el: Element): string {
  const tag = tagOf(el);
  const role = roleOf(el);
  let name: string;
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').trim().toLowerCase();
    if (type === 'submit' || type === 'button' || type === 'reset') name = ownLabel(el) || clean(el.getAttribute('value')) || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '');
    else if (type === 'image') name = ownLabel(el) || clean(el.getAttribute('alt')) || clean(el.getAttribute('title')) || 'Submit';
    else name = fieldName(el);
  } else if (tag === 'select' || tag === 'textarea' || isEditable(el) || role === 'textbox' || role === 'searchbox' || role === 'combobox') {
    name = fieldName(el);
  } else if (role === 'row') {
    name = ownLabel(el) || rowName(el);
  } else if (CONTAINER_ROLES.has(role)) {
    name = containerName(el, role);
  } else {
    name = ownLabel(el) || clean(el.getAttribute('alt')) || clean(el.getAttribute('title')) || renderedText(el) || innerImageName(el);
  }
  return trunc(name, MAX_NAME);
}

/** `button "Save"`, or the bare role when it has no name. A quote in a name is escaped. */
export function formatRoleName(role: string, name: string): string {
  return name ? `${role} "${name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : role;
}

/** The inverse of formatRoleName: what a skill file's verb line and `in` hold. */
export function parseRoleName(s: string): { role: string; name: string } {
  const m = /^\s*([^\s"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*$/.exec(s);
  if (!m) return { role: s.trim(), name: '' };
  return { role: m[1]!, name: (m[2] ?? '').replace(/\\(.)/g, '$1') };
}

/** Names compared as the matchers compare text: whitespace collapsed, case ignored. */
export function sameName(a: string, b: string): boolean {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

/** The nearest named place around an element, crossing out of open shadow roots: `form "New expense"`. */
export function landmarkOf(el: Element): string | undefined {
  let cur = parentOf(el).el;
  while (cur) {
    const role = roleOf(cur);
    if (LANDMARK_ROLES.has(role)) return formatRoleName(role, nameOf(cur));
    cur = parentOf(cur).el;
  }
  return undefined;
}

/** Disabled natively, by a disabled fieldset around it, or by aria-disabled. */
export function isDisabled(el: Element): boolean {
  if (el.getAttribute('aria-disabled') === 'true') return true;
  const tag = tagOf(el);
  if (tag !== 'button' && tag !== 'input' && tag !== 'select' && tag !== 'textarea') return false;
  if (el.hasAttribute('disabled')) return true;
  for (let p = el.parentElement; p; p = p.parentElement) if (tagOf(p) === 'fieldset' && p.hasAttribute('disabled')) return true;
  return false;
}

/** What the inventory says after a control's name: `[disabled] [checked]`. */
export function stateOf(el: Element): string[] {
  const out: string[] = [];
  if (isDisabled(el)) out.push('disabled');
  const native = (el as HTMLInputElement).checked;
  if (tagOf(el) === 'input' && (native === true || (native === undefined && el.hasAttribute('checked')))) out.push('checked');
  for (const [attr, word] of [['aria-checked', 'checked'], ['aria-expanded', 'expanded'], ['aria-pressed', 'pressed'], ['aria-selected', 'selected']] as const) {
    if (el.getAttribute(attr) === 'true' && !out.includes(word)) out.push(word);
  }
  const current = el.getAttribute('aria-current');
  if (current && current !== 'false') out.push('current');
  return out;
}

/** Can a user operate this, leaving aside whether it shows? `cursor: pointer` is the last resort. */
export function isOperable(el: Element, probe: Pick<Probe, 'style'>): boolean {
  if (el.hasAttribute('data-usermods')) return false;
  const tag = tagOf(el);
  if (tag === 'a' || tag === 'area') {
    if (el.hasAttribute('href')) return true;
  } else if (tag === 'input') {
    return (el.getAttribute('type') ?? '').trim().toLowerCase() !== 'hidden';
  } else if (tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'summary') {
    return true;
  }
  if (INTERACTIVE_ROLES.has(roleOf(el)) || isEditable(el)) return true;
  const tabindex = el.getAttribute('tabindex');
  if (tabindex !== null && Number(tabindex) >= 0) return true;
  return pointerOnly(el, probe);
}

const HAS_CONTROL = 'a[href], button, input, select, textarea, [role="button"], [role="link"]';

/**
 * A div with a click handler: `cursor: pointer` that starts here, not inherited, with no real
 * control inside it. The inherited case is every descendant of a clickable card; the wrapped one is
 * a card around a link, where the link is the thing to name.
 */
function pointerOnly(el: Element, probe: Pick<Probe, 'style'>): boolean {
  const tag = tagOf(el);
  if (tag === 'label' || tag === 'html' || tag === 'body') return false;
  if (probe.style(el)('cursor') !== 'pointer') return false;
  const parent = parentOf(el).el;
  if (parent && probe.style(parent)('cursor') === 'pointer') return false;
  return !el.querySelector(HAS_CONTROL);
}
