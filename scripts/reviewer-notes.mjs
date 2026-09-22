// Print the reviewer notes with the real key and base URL substituted, for pasting into the
// Chrome Web Store dashboard's "Notes for reviewers" field.
//
//   USERMODS_REVIEWER_KEY='sk-…' USERMODS_REVIEWER_BASE_URL='https://…' node scripts/reviewer-notes.mjs | pbcopy
//
// Both values live only in the environment. docs/store/reviewer-notes.md keeps placeholders for
// each, so the repository never carries the credential or the endpoint hostname, and this script
// never has to be gitignored. The hostname is deliberately not written anywhere in this file
// either — it is looked up from 1Password (project vault, item "Ornith API - chrome-app-review - 14
// days") when the notes need generating.
//
// The notes are read from the doc rather than duplicated here: two copies of the same text drift,
// and the one that drifts is always the one nobody is reading while they edit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = path.join(ROOT, 'docs', 'store', 'reviewer-notes.md');

/** The lines in the doc that stand in for the credential and the endpoint. */
const KEY_PLACEHOLDER = '[reviewer key: PASTE HERE]';
const BASE_URL_PLACEHOLDER = '[reviewer base URL: PASTE HERE]';

/**
 * The fenced block under "## Short version — paste this". Matched by its first line rather than by
 * position, so adding a fenced example earlier in the doc cannot silently change which block is
 * printed.
 */
const SHORT_VERSION = /```\n(WHAT IT IS\n[\s\S]*?)```/;

/** Print to stderr and exit non-zero: stdout is the payload and must stay clean for a pipe. */
function fail(message) {
  process.stderr.write(`reviewer-notes: ${message}\n`);
  process.exit(1);
}

const key = process.env.USERMODS_REVIEWER_KEY;
if (!key || !key.trim()) {
  fail(
    'USERMODS_REVIEWER_KEY is not set.\n' +
      "  Usage: USERMODS_REVIEWER_KEY='<the key>' USERMODS_REVIEWER_BASE_URL='<the base URL>' " +
      'node scripts/reviewer-notes.mjs | pbcopy\n' +
      '  The key is the reviewer credential for the model API (model "ornith").\n' +
      '  Do not paste it into docs/store/reviewer-notes.md — that file keeps the placeholder.',
  );
}

const baseUrl = process.env.USERMODS_REVIEWER_BASE_URL;
if (!baseUrl || !baseUrl.trim()) {
  fail(
    'USERMODS_REVIEWER_BASE_URL is not set.\n' +
      "  Usage: USERMODS_REVIEWER_KEY='<the key>' USERMODS_REVIEWER_BASE_URL='<the base URL>' " +
      'node scripts/reviewer-notes.mjs | pbcopy\n' +
      '  The base URL is the reviewer endpoint (kept in 1Password, project vault, item "Ornith API - ' +
      'chrome-app-review - 14 days").\n' +
      '  Do not paste it into docs/store/reviewer-notes.md — that file keeps the placeholder.',
  );
}

const trimmedBaseUrl = baseUrl.trim();
if (!trimmedBaseUrl.startsWith('https://')) {
  fail(
    'USERMODS_REVIEWER_BASE_URL does not start with https://.\n' +
      `  Got: ${trimmedBaseUrl}\n` +
      '  Check the value pulled from 1Password.',
  );
}

let doc;
try {
  doc = fs.readFileSync(NOTES, 'utf8');
} catch (e) {
  fail(`could not read ${path.relative(ROOT, NOTES)}: ${e.message}`);
}

const match = doc.match(SHORT_VERSION);
if (!match) {
  fail(
    `could not find the short version in ${path.relative(ROOT, NOTES)}.\n` +
      '  Expected a fenced block whose first line is "WHAT IT IS". If the notes were restructured,\n' +
      '  update SHORT_VERSION in this script to match.',
  );
}

const short = match[1].trimEnd();
if (!short.includes(KEY_PLACEHOLDER)) {
  fail(
    `the short version does not contain ${KEY_PLACEHOLDER}.\n` +
      '  Either the placeholder was renamed, or — check this first — a real key was committed to\n' +
      '  the doc by hand. If so, remove it and restore the placeholder.',
  );
}
if (!short.includes(BASE_URL_PLACEHOLDER)) {
  fail(
    `the short version does not contain ${BASE_URL_PLACEHOLDER}.\n` +
      '  Either the placeholder was renamed, or — check this first — a real base URL was committed\n' +
      '  to the doc by hand. If so, remove it and restore the placeholder.',
  );
}

const out = short
  .split(KEY_PLACEHOLDER)
  .join(key.trim())
  .split(BASE_URL_PLACEHOLDER)
  .join(trimmedBaseUrl);

if (out.includes('PASTE HERE')) {
  fail(
    'a placeholder survived substitution — refusing to print.\n' +
      '  This should not happen; check KEY_PLACEHOLDER/BASE_URL_PLACEHOLDER against the doc.',
  );
}

// A trailing newline so the piped text ends cleanly; pbcopy keeps whatever it is given.
process.stdout.write(`${out}\n`);

// The character count goes to stderr, so it is visible when run in a terminal but never lands in
// the clipboard. The dashboard field's limit is undocumented; 2,500 is the working ceiling.
const LIMIT = 2500;
const note = out.length > LIMIT ? ` — OVER the ${LIMIT} working limit, trim before pasting` : '';
process.stderr.write(`reviewer-notes: ${out.length} characters${note}\n`);
