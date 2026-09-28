// The content script's half of sharing (the background's is lib/sharecontroller.ts): fill the form
// on the page, show the hint bubble, and say which .user.js files a saved gist holds.
import { fillGistEditor, fillGistFields, fillGreasyFork, gistFormPresent, gistSubmitButton, greasyForkSubmitButton, looksNotFound, looksSignedOut, waitFor, type FillResult } from './sharefill';
import { showHint } from './pageui';
import { parseGistRawUrl } from './share';
import type { ContentRequest, ShareHintSpec } from './types';

/** How long to wait for a form that renders a moment after the load event. */
const FORM_WAIT_MS = 6000;

type ShareRequest = Extract<ContentRequest, { type: 'share-fill' | 'share-hint' | 'share-files' }>;

export async function handleShareMessage(msg: ShareRequest): Promise<unknown> {
  switch (msg.type) {
    case 'share-fill':
      return fill(msg.req);
    case 'share-hint':
      return hint(msg.hint);
    case 'share-files':
      return { files: gistFiles() };
  }
}

async function fill(req: Extract<ContentRequest, { type: 'share-fill' }>['req']): Promise<FillResult> {
  const doc = document;
  if (req.target === 'greasyfork') {
    const found = await waitFor(() => !!doc.querySelector('#script_version_code'), FORM_WAIT_MS);
    if (!found) return looksSignedOut(doc, location.href) ? { state: 'signin' } : { state: 'missing', reason: 'no code box on this page' };
    const method = await fillGreasyFork(doc, req);
    return method ? { state: 'filled', method } : { state: 'missing', reason: 'the code box did not take the text' };
  }
  const found = await waitFor(() => gistFormPresent(doc) || looksNotFound(doc), FORM_WAIT_MS);
  if (!found || !gistFormPresent(doc)) {
    if (looksNotFound(doc)) return { state: 'notfound' };
    if (looksSignedOut(doc, location.href)) return { state: 'signin' };
    return { state: 'missing', reason: 'no gist editor on this page' };
  }
  fillGistFields(doc, req);
  if (req.fieldsOnly) return { state: 'fields', hasEditor: true };
  const method = await fillGistEditor(doc, req);
  return method ? { state: 'filled', method } : { state: 'missing', reason: 'the gist editor did not take the text' };
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function hint(spec: ShareHintSpec): Promise<{ ok: true; copied?: boolean }> {
  const anchor = spec.anchor === 'gist-submit' ? gistSubmitButton(document) : spec.anchor === 'greasyfork-submit' ? greasyForkSubmitButton(document) : null;
  // The fallback puts the script on the clipboard straight away where the browser allows it (Chrome
  // does for the focused tab), and keeps a Copy button for where it needs a click (Safari).
  const copied = spec.copy ? await copy(spec.copy) : undefined;
  const actions = [];
  if (spec.copy) {
    const text = spec.copy;
    actions.push({
      label: 'Copy script',
      testId: 'usermods-hint-copy',
      onClick: () => {
        void copy(text).then((ok) => {
          if (ok) h.el.shadowRoot?.querySelector('[data-testid="usermods-hint-text"]')?.replaceChildren(spec.text);
        });
      },
    });
  }
  if (spec.offerNewGist) {
    actions.push({
      label: 'Share as a new gist',
      testId: 'usermods-hint-new-gist',
      onClick: () => {
        void chrome.runtime.sendMessage({ type: 'usermods:share-new-gist' }).catch(() => {});
      },
    });
  }
  const h = showHint({
    text: spec.copy && copied === false && spec.textNotCopied ? spec.textNotCopied : spec.text,
    ...(spec.extra ? { extra: spec.extra } : {}),
    anchor,
    actions,
    ...(spec.testId ? { testId: spec.testId } : {}),
  });
  return { ok: true, ...(copied !== undefined ? { copied } : {}) };
}

/** The .user.js (and other) file names on a gist page, from its Raw links. */
function gistFiles(): string[] {
  const names = new Set<string>();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/raw/"]'))) {
    const r = parseGistRawUrl(new URL(a.getAttribute('href') ?? '', location.href).toString());
    if (r) names.add(r.fileName);
  }
  return [...names];
}
