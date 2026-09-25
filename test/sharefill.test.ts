// Finding and filling the share forms (lib/sharefill.ts), on the reconstructed signed-in pages in
// scripts/lib/share-fixtures.mjs and the saved signed-out gist page. The editor-driving paths
// (the page world's editor API, GitHub's gist:filedrop, a synthetic paste) need a real browser and
// are exercised by the `share` smoke flow; this file covers what can be decided on a parsed DOM.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';
import {
  fillGistFields,
  fillGreasyFork,
  gistFileFor,
  gistFormPresent,
  gistSubmitButton,
  greasyForkSubmitButton,
  looksFilled,
  looksNotFound,
  looksSignedOut,
  type FillRequest,
} from '../lib/sharefill.ts';
// @ts-expect-error: a plain .mjs module shared with the smoke harness
import { gist404Page, gistEditorPage, greasyForkFormPage } from '../scripts/lib/share-fixtures.mjs';

function dom(html: string): Document {
  const w = parseHTML(html);
  // setFieldValue reaches for the element prototypes by their global names, as it does in a page.
  Object.assign(globalThis, { HTMLTextAreaElement: w.HTMLTextAreaElement, HTMLInputElement: w.HTMLInputElement, Event: w.Event });
  return w.document as unknown as Document;
}

const SOURCE = '// ==UserScript==\n// @name Wide Wiki\n// @version 1.2.4\n// @match *://*.wikipedia.org/*\n// ==/UserScript==\n\nrun();\n';
const req = (over: Partial<FillRequest> = {}): FillRequest => ({
  target: 'gist',
  mode: 'new',
  fileName: 'wide-wiki.user.js',
  description: 'Lets articles use the whole window.',
  source: SOURCE,
  version: '1.2.4',
  previousVersion: '1.2.3',
  ...over,
});

test('the new-gist form: found, named, described, and the Create button pointed at', () => {
  const d = dom(gistEditorPage({ mode: 'new' }));
  assert.equal(gistFormPresent(d), true);
  fillGistFields(d, req());
  assert.equal(d.querySelector<HTMLInputElement>('.js-gist-filename')!.value, 'wide-wiki.user.js');
  assert.equal(d.querySelector<HTMLInputElement>('#gist_description')!.value, 'Lets articles use the whole window.');
  assert.equal(gistSubmitButton(d)?.textContent?.trim(), 'Create secret gist');
});

test('the edit page: the file is found by name among several, and neither name nor description is touched', () => {
  const d = dom(
    gistEditorPage({
      mode: 'edit',
      description: 'Mine',
      files: [
        { name: 'README.md', content: '# hi' },
        { name: 'wide-wiki.user.js', content: SOURCE.replace('1.2.4', '1.2.3') },
      ],
      visibility: 'public',
    }),
  );
  const file = gistFileFor(d, 'wide-wiki.user.js');
  assert.equal(file?.querySelector<HTMLInputElement>('.js-gist-filename')?.value, 'wide-wiki.user.js');
  fillGistFields(d, req({ mode: 'update' }));
  assert.deepEqual(
    Array.from(d.querySelectorAll<HTMLInputElement>('.js-gist-filename')).map((i) => i.value),
    ['README.md', 'wide-wiki.user.js'],
  );
  assert.equal(d.querySelector<HTMLInputElement>('#gist_description')!.value, 'Mine');
  assert.equal(gistSubmitButton(d)?.textContent?.trim(), 'Update public gist');
});

test('signed out, gist.github.com is the Discover page: that is a sign-in wall, not a missing form', () => {
  const d = dom(readFileSync(fileURLToPath(new URL('./fixtures/pages/gist-signed-out.html', import.meta.url)), 'utf8'));
  assert.equal(gistFormPresent(d), false);
  assert.equal(looksSignedOut(d, 'https://gist.github.com/'), true);
  assert.equal(looksSignedOut(dom(gistEditorPage({ variant: 'unknown' })), 'https://gist.github.com/'), false);
  assert.equal(looksSignedOut(dom('<html><body></body></html>'), 'https://greasyfork.org/en/users/sign_in'), true);
});

test('a deleted gist’s edit page is recognised as gone', () => {
  assert.equal(looksNotFound(dom(gist404Page())), true);
  assert.equal(looksNotFound(dom(gistEditorPage({ mode: 'edit', files: [{ name: 'a.user.js', content: 'x' }] }))), false);
});

test('a redesigned page whose markup matches nothing is "missing", which is what sends the clipboard fallback', () => {
  const d = dom(gistEditorPage({ variant: 'unknown' }));
  assert.equal(gistFormPresent(d), false);
  assert.equal(looksNotFound(d), false);
});

test('Greasy Fork: the code box is set, the description goes in Additional info, and Post script is pointed at', async () => {
  const d = dom(greasyForkFormPage());
  assert.equal(await fillGreasyFork(d, req({ target: 'greasyfork' })), 'textarea');
  assert.equal(d.querySelector<HTMLTextAreaElement>('#script_version_code')!.value, SOURCE);
  assert.equal(d.querySelector<HTMLTextAreaElement>('#script-version-additional-info-0')!.value, 'Lets articles use the whole window.');
  const submit = greasyForkSubmitButton(d) as HTMLInputElement | null;
  assert.equal(submit?.getAttribute('value'), 'Post script');
  // A new version: "Post new version", and the additional info the script already has is kept.
  const v = dom(greasyForkFormPage({ scriptId: '424242' }));
  v.querySelector<HTMLTextAreaElement>('#script-version-additional-info-0')!.value = 'Existing page';
  await fillGreasyFork(v, req({ target: 'greasyfork', mode: 'update' }));
  assert.equal(v.querySelector<HTMLTextAreaElement>('#script-version-additional-info-0')!.value, 'Existing page');
  assert.equal((greasyForkSubmitButton(v) as HTMLInputElement).getAttribute('value'), 'Post new version');
});

test('looksFilled: the header’s first lines and the new version, and not the old version as well', () => {
  const r = req();
  assert.equal(looksFilled(SOURCE, r), true);
  assert.equal(looksFilled('', r), false);
  assert.equal(looksFilled(SOURCE.replace('1.2.4', '1.2.3'), r), false, 'still the old version');
  assert.equal(looksFilled(SOURCE.replace('1.2.4', '1.2.3') + SOURCE, r), false, 'pasted after the old script instead of over it');
  assert.equal(looksFilled(SOURCE.replace(/ /g, ' '), r), true, 'rendered editors use no-break spaces');
  assert.equal(looksFilled(SOURCE.replace('1.2.4', '1.2.40'), r), false, '1.2.40 is not 1.2.4');
});
