// Print the reviewer notes with the real key substituted, for pasting into the Chrome Web Store
// dashboard's "Notes for reviewers" field.
//
//   USERMODS_REVIEWER_KEY='sk-…' node scripts/reviewer-notes.mjs | pbcopy
//
// The key lives only in the environment. docs/store/reviewer-notes.md keeps the placeholder, so
// the repository never carries the credential and this script never has to be gitignored.
//
// The notes are read from the doc rather than duplicated here: two copies of the same text drift,
// and the one that drifts is always the one nobody is reading while they edit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NOTES = path.join(ROOT, 'docs', 'store', 'reviewer-notes.md');

/** The line in the doc that stands in for the credential. */
const PLACEHOLDER = '[reviewer key: PASTE HERE]';

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
      "  Usage: USERMODS_REVIEWER_KEY='<the key>' node scripts/reviewer-notes.mjs | pbcopy\n" +
      '  The key is the reviewer credential for [reviewer base URL: PASTE HERE] (model "ornith").\n' +
      '  Do not paste it into docs/store/reviewer-notes.md — that file keeps the placeholder.',
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
if (!short.includes(PLACEHOLDER)) {
  fail(
    `the short version does not contain ${PLACEHOLDER}.\n` +
      '  Either the placeholder was renamed, or — check this first — a real key was committed to\n' +
      '  the doc by hand. If so, remove it and restore the placeholder.',
  );
}

const out = short.split(PLACEHOLDER).join(key.trim());

// A trailing newline so the piped text ends cleanly; pbcopy keeps whatever it is given.
process.stdout.write(`${out}\n`);

// The character count goes to stderr, so it is visible when run in a terminal but never lands in
// the clipboard. The dashboard field's limit is undocumented; 2,500 is the working ceiling.
const LIMIT = 2500;
const note = out.length > LIMIT ? ` — OVER the ${LIMIT} working limit, trim before pasting` : '';
process.stderr.write(`reviewer-notes: ${out.length} characters${note}\n`);
