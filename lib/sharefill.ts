// Filling GitHub's gist editor and Greasy Fork's post form, in the user's own tab.
//
// This runs in the page content script (entrypoints/content.ts), in the isolated world, when the
// background asks. It sets form fields the way a person typing would leave them, and never submits
// anything: the user presses the site's own button, which the hint bubble points at.
//
// The gist editor is the hard part. Its file content is not a plain textarea: GitHub mounts a code
// editor over `textarea.js-code-textarea` (the `.js-code-editor` wrapper, a CodeMirror underneath)
// and the form posts whatever that editor holds. Setting the hidden textarea does nothing. What
// works, in order of preference:
//
//   1. On Chrome, the background first sets the editor through its OWN API from the page world
//      (`setEditorInPage` below, run by chrome.scripting.executeScript with world: 'MAIN' — a
//      bundled function, never a code string): CodeMirror 5 hangs its instance on the wrapper
//      element (`.CodeMirror`.CodeMirror), CodeMirror 6 on its content element (`.cm-content`
//      .cmView). That is exact, and reading it back is an exact verification.
//   2. GitHub's own drop handler. gist.github.com listens for a `gist:filedrop` CustomEvent on the
//      form, and for a file dropped on the editor it finds the first empty file slot, sets its name
//      and calls the editor's setCode(). Dispatching that event from the isolated world reaches the
//      page's delegated listener (DOM events cross worlds; the detail is cloned). New gists only:
//      on the edit page every slot already has a name, and the handler would add a second file.
//   3. A synthetic paste: focus the editor's input, select all with the editor's own keyboard
//      binding (Cmd/Ctrl+A as a keydown the editor handles), and dispatch a ClipboardEvent('paste')
//      carrying a DataTransfer with the text. CodeMirror 5 and 6 both read clipboardData from the
//      event and replace the selection.
//   4. document.execCommand('insertText') into the focused input, which both editors observe.
//
// Each is checked before the next is tried. If none took, the fallback is honest: the script goes
// on the clipboard and the hint says to paste it and what to name the file.

export interface FillRequest {
  target: 'gist' | 'greasyfork';
  mode: 'new' | 'update';
  fileName: string;
  description: string;
  source: string;
  version: string;
  previousVersion: string;
  /** Skip the editor (Chrome sets it from the page world first). */
  fieldsOnly?: boolean;
}

export type FillResult =
  | { state: 'filled'; method: string }
  | { state: 'fields'; hasEditor: boolean }
  | { state: 'signin' }
  | { state: 'notfound' }
  | { state: 'missing'; reason: string };

// ---------------------------------------------------------------------------
// Finding things
// ---------------------------------------------------------------------------

const GIST_FILE = '.js-gist-file';
const GIST_FILENAME = '.js-gist-filename, input[name="gist[contents][][name]"], input[name^="gist[contents]"][name$="[name]"]';
const GIST_CONTENTS = 'textarea.js-blob-contents, textarea.js-code-textarea, textarea[name="gist[contents][][value]"], textarea[name^="gist[contents]"][name$="[value]"]';
const GIST_DESCRIPTION = 'input[name="gist[description]"], #gist_description';

/** The gist file the share is about: the one named like it, else the only one, else the first. */
export function gistFileFor(doc: Document, fileName: string): Element | null {
  const files = Array.from(doc.querySelectorAll(GIST_FILE));
  const candidates = files.length ? files : Array.from(doc.querySelectorAll('.file, .js-code-editor'));
  const named = candidates.find((f) => (f.querySelector<HTMLInputElement>(GIST_FILENAME)?.value ?? '') === fileName);
  if (named) return named;
  if (candidates.length === 1) return candidates[0]!;
  // New gist: the first empty slot, which is where GitHub's own drop handler puts a file too.
  return candidates.find((f) => !(f.querySelector<HTMLInputElement>(GIST_FILENAME)?.value ?? '')) ?? candidates[0] ?? null;
}

export function gistFormPresent(doc: Document): boolean {
  return !!doc.querySelector(GIST_FILENAME) || !!doc.querySelector(GIST_CONTENTS);
}

/** The button the hint points at on a gist form: "Create secret gist", "Update public gist", … */
export function gistSubmitButton(doc: Document): HTMLElement | null {
  const buttons = Array.from(doc.querySelectorAll<HTMLElement>('form button, form input[type="submit"]'));
  const byText = (re: RegExp) => buttons.find((b) => re.test((b.textContent || (b as HTMLInputElement).value || '').trim()));
  return byText(/^(create|update) secret gist$/i) ?? byText(/^(create|update) public gist$/i) ?? byText(/(create|update) (secret |public )?gist/i) ?? doc.querySelector<HTMLElement>('form .js-gist-create, form button[type="submit"].btn-primary') ?? null;
}

export function greasyForkSubmitButton(doc: Document): HTMLElement | null {
  const form = doc.querySelector('#script_version_code')?.closest('form') ?? doc;
  return (
    form.querySelector<HTMLElement>('input[type="submit"][name="commit"]') ??
    Array.from(form.querySelectorAll<HTMLElement>('[type="submit"]')).filter((b) => b.id !== 'add-additional-info' && (b as HTMLButtonElement).name !== 'preview').pop() ??
    null
  );
}

/**
 * A page that is asking the user to sign in rather than showing the form. Signed out,
 * gist.github.com's root is the Discover page with a "Sign in" link; Greasy Fork redirects to
 * /users/sign_in.
 */
export function looksSignedOut(doc: Document, href: string): boolean {
  if (/\/users\/sign_in|github\.com\/(login|session)/.test(href)) return true;
  if (doc.querySelector('form[action="/session"], form[action*="/users/sign_in"], input[name="login"][type="text"]')) return true;
  const signIn = Array.from(doc.querySelectorAll('a')).some((a) => /^sign in$/i.test((a.textContent ?? '').trim()) && /login|auth|sign_in/.test(a.getAttribute('href') ?? ''));
  return signIn;
}

export function looksNotFound(doc: Document): boolean {
  return /not found|page not found|404/i.test(doc.title) || !!doc.querySelector('#parallax_wrapper, .js-plaxify, [data-testid="not-found"]');
}

// ---------------------------------------------------------------------------
// Setting values the way typing would
// ---------------------------------------------------------------------------

/**
 * Set an input's value through the prototype's setter and fire input + change, so a framework that
 * tracks the value (React, GitHub's own behaviours) sees a change rather than a stale value.
 */
export function setFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** The editor's own input element inside a gist file, or the plain textarea when there is none. */
function editorInput(file: Element): HTMLElement | null {
  return (
    file.querySelector<HTMLElement>('.cm-content[contenteditable="true"], .cm-content') ??
    file.querySelector<HTMLElement>('.CodeMirror textarea') ??
    file.querySelector<HTMLElement>('textarea:not([hidden]):not(.d-none)') ??
    null
  );
}

/**
 * What the editor shows, as far as the isolated world can tell: the backing textarea when GitHub
 * keeps it in sync, else the rendered lines. Rendered lines are only the visible ones, so this is a
 * signature check (the header's first lines and version), not an equality check — Chrome does the
 * exact check from the page world instead.
 */
export function editorText(file: Element): string {
  const parts: string[] = [];
  const ta = file.querySelector<HTMLTextAreaElement>(GIST_CONTENTS);
  if (ta?.value) parts.push(ta.value);
  for (const sel of ['.cm-content', '.CodeMirror-code', '.CodeMirror-lines']) {
    const el = file.querySelector<HTMLElement>(sel);
    if (el) {
      parts.push(el.innerText || el.textContent || '');
      break;
    }
  }
  return parts.join('\n');
}

const norm = (s: string) => s.replace(/ /g, ' ').replace(/[ \t]+/g, ' ');

/**
 * Does this text look like the script we meant to put there — and not like the script plus the one
 * that was there before? Checks the first header lines, the new @version, and (on an update) that
 * the previous @version line is gone.
 */
export function looksFilled(text: string, req: Pick<FillRequest, 'source' | 'version' | 'previousVersion'>): boolean {
  const t = norm(text);
  const firstLines = req.source.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2);
  if (!firstLines.every((l) => t.includes(norm(l)))) return false;
  if (req.version && !new RegExp(`@version\\s+${escapeRe(req.version)}(?![\\w.-])`).test(t)) return false;
  if (req.previousVersion && req.previousVersion !== req.version && new RegExp(`@version\\s+${escapeRe(req.previousVersion)}(?![\\w.-])`).test(t)) return false;
  return true;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function settle(check: () => boolean, ms = 900): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(60);
  }
  return check();
}

/** Select everything in a code editor the way its user would: its own Select All binding. */
function selectAll(input: HTMLElement): void {
  input.focus();
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const init: KeyboardEventInit & { keyCode?: number; which?: number } = { key: 'a', code: 'KeyA', keyCode: 65, which: 65, bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac };
  input.dispatchEvent(new KeyboardEvent('keydown', init));
  input.dispatchEvent(new KeyboardEvent('keyup', init));
  // A plain textarea (or a contenteditable the editor maps a DOM selection from) also takes this.
  if (input instanceof HTMLTextAreaElement) input.select();
}

function paste(input: HTMLElement, text: string): boolean {
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return true;
  } catch {
    return false;
  }
}

/** Fill the gist file's editor from the isolated world. Returns the method that worked, or null. */
export async function fillGistEditor(doc: Document, req: FillRequest): Promise<string | null> {
  const file = gistFileFor(doc, req.fileName);
  if (!file) return null;
  const ok = () => looksFilled(editorText(file), req);
  if (ok()) return 'already';

  // 2. GitHub's own drop handler: a new gist's empty slot.
  const form = file.closest('form') ?? doc.querySelector('form.js-blob-form');
  const nameInput = file.querySelector<HTMLInputElement>(GIST_FILENAME);
  const contents = file.querySelector<HTMLTextAreaElement>(GIST_CONTENTS);
  if (req.mode === 'new' && form && !(contents?.value ?? '')) {
    // The handler only uses a slot with no name and no content. The name may be ours already (the
    // fields are filled first); clear it so the slot qualifies — the drop names it again.
    if (nameInput && nameInput.value === req.fileName) setFieldValue(nameInput, '');
    if (!nameInput?.value) {
      form.dispatchEvent(new CustomEvent('gist:filedrop', { bubbles: true, detail: { file: { name: req.fileName }, data: req.source } }));
      const took = await settle(ok);
      if (nameInput && !nameInput.value) setFieldValue(nameInput, req.fileName);
      if (took) return 'filedrop';
    }
  }

  const input = editorInput(file);
  if (!input) return null;

  // A plain textarea with no editor over it: just set it.
  if (input instanceof HTMLTextAreaElement && !input.closest('.CodeMirror')) {
    setFieldValue(input, req.source);
    if (await settle(ok, 300)) return 'textarea';
  }

  // 3. Select all, then a synthetic paste.
  selectAll(input);
  paste(input, req.source);
  if (await settle(ok)) return 'paste';

  // 4. insertText, which the editors see as typing.
  selectAll(input);
  try {
    doc.execCommand('selectAll');
    doc.execCommand('insertText', false, req.source);
  } catch {
    /* not supported here */
  }
  if (await settle(ok)) return 'insertText';
  return null;
}

/** Name the file and describe the gist: plain inputs, set directly. */
export function fillGistFields(doc: Document, req: FillRequest): { named: boolean } {
  const file = gistFileFor(doc, req.fileName);
  const nameInput = file?.querySelector<HTMLInputElement>(GIST_FILENAME) ?? doc.querySelector<HTMLInputElement>(GIST_FILENAME);
  let named = false;
  // On an update the file already has its name; renaming it would break the install link.
  if (nameInput && req.mode === 'new' && nameInput.value !== req.fileName) {
    setFieldValue(nameInput, req.fileName);
    named = true;
  }
  const desc = doc.querySelector<HTMLInputElement | HTMLTextAreaElement>(GIST_DESCRIPTION);
  if (desc && req.mode === 'new' && !desc.value && req.description) setFieldValue(desc, req.description);
  return { named };
}

/**
 * Greasy Fork's post form is plain HTML: `textarea#script_version_code` for the code, one
 * `textarea#script-version-additional-info-0` for the description page. If the user has turned on
 * the site's syntax-highlighting editor for the code box, that is turned off first, so the textarea
 * is what gets posted.
 */
export async function fillGreasyFork(doc: Document, req: FillRequest): Promise<string | null> {
  const code = doc.querySelector<HTMLTextAreaElement>('#script_version_code, textarea[name="script_version[code]"]');
  if (!code) return null;
  const toggle = doc.querySelector<HTMLInputElement>('#enable-source-editor-code');
  if (toggle?.checked) toggle.click();
  setFieldValue(code, req.source);
  const info = doc.querySelector<HTMLTextAreaElement>('#script-version-additional-info-0');
  if (info && req.mode === 'new' && !info.value.trim() && req.description) setFieldValue(info, req.description);
  return (await settle(() => code.value === req.source, 300)) ? 'textarea' : null;
}

/** Wait for a selector to appear, for pages that render their form a moment after load. */
export async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  return settle(check, ms);
}

// ---------------------------------------------------------------------------
// The page world (Chrome): functions passed to chrome.scripting.executeScript as `func`
// ---------------------------------------------------------------------------
//
// These are serialised and run in the page's own world, so they must be self-contained: no imports,
// no closures over this module, nothing but their arguments and the page's DOM. They reach the
// editor instance the page's own JavaScript created, which the isolated world cannot see.

/** Set the gist file's editor to `text` through the editor's own API, and read it back. */
export function setEditorInPage(fileName: string, text: string, write: boolean): 'set' | 'same' | 'no-editor' | 'mismatch' {
  type CM5 = { getValue(): string; setValue(v: string): void; save?: () => void };
  type CM6View = { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void };
  const files = Array.from(document.querySelectorAll('.js-gist-file'));
  const pick =
    files.find((f) => (f.querySelector<HTMLInputElement>('.js-gist-filename, input[name$="[name]"]')?.value ?? '') === fileName) ??
    (files.length === 1 ? files[0] : files.find((f) => !(f.querySelector<HTMLInputElement>('.js-gist-filename, input[name$="[name]"]')?.value ?? ''))) ??
    document;
  const cm5El = pick.querySelector('.CodeMirror') as (Element & { CodeMirror?: CM5 }) | null;
  const cm5 = cm5El?.CodeMirror;
  if (cm5 && typeof cm5.getValue === 'function') {
    if (write && cm5.getValue() !== text) cm5.setValue(text);
    try {
      cm5.save?.();
    } catch {
      /* fromTextArea only */
    }
    return cm5.getValue() === text ? (write ? 'set' : 'same') : 'mismatch';
  }
  const content = pick.querySelector('.cm-content') as (Element & { cmView?: { rootView?: { view?: CM6View }; view?: CM6View; editorView?: CM6View } }) | null;
  const cv = content?.cmView;
  const view = cv?.rootView?.view ?? cv?.view ?? cv?.editorView;
  if (view && typeof view.dispatch === 'function') {
    if (write && view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    return view.state.doc.toString() === text ? (write ? 'set' : 'same') : 'mismatch';
  }
  return 'no-editor';
}
