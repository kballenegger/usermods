// Check the Chrome Web Store description in docs/store/listing.md against the keyword-spam rules
// the first submission was rejected under (violation "Yellow Argon", 2026-09-22), and the other
// dashboard texts against the field limits the dashboard enforces.
//
//   npm run listing-check
//
// The rules are Google's, from https://developer.chrome.com/docs/webstore/program-policies/spam-faq:
// list no more than five sites or brands, and keep any one keyword under five uses even when it is
// the extension's main purpose. Prints the counts and exits non-zero when one is broken, so an edit
// to the listing cannot quietly reintroduce the list that was rejected.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LISTING = path.join(ROOT, 'docs', 'store', 'listing.md');

/** The fenced block under "## Detailed description". */
const DESCRIPTION = /## Detailed description[\s\S]*?```\n([\s\S]*?)```/;

const MAX_BRANDS = 5;
const MAX_KEYWORD_USES = 4;

/**
 * Every company, product and site name the listing, the UI or the README has ever used. A name
 * missing from this list is not counted, so add to it when the extension learns a new integration.
 */
const BRANDS = [
  'Anthropic', 'Claude', 'OpenAI', 'ChatGPT', 'GPT', 'xAI', 'Grok', 'SuperGrok', 'OpenRouter',
  'Ollama', 'LM Studio', 'vLLM', 'mlx_lm', 'Gemini', 'Google', 'Chrome', 'Brave', 'Edge', 'Firefox',
  'Safari', 'Tampermonkey', 'Violentmonkey', 'Greasemonkey', 'Greasy Fork', 'OpenUserJS', 'GitHub',
  'GitLab', 'Wikipedia', 'YouTube', 'Reddit', 'Hacker News',
];

/** The words a reviewer would read as the listing's keywords. Matched whole, plural included. */
const KEYWORDS = ['userscript', 'user script', 'usermods', 'script', 'mod', 'model', 'AI', 'LLM', 'extension', 'website'];

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function count(text, term, { caseSensitive }) {
  const re = new RegExp(`(?<![A-Za-z0-9_])${escape(term)}s?(?![A-Za-z0-9_])`, caseSensitive ? 'g' : 'gi');
  return (text.match(re) ?? []).length;
}

const doc = fs.readFileSync(LISTING, 'utf8');
const m = DESCRIPTION.exec(doc);
if (!m) {
  process.stderr.write('listing-check: no fenced description under "## Detailed description".\n');
  process.exit(1);
}
const text = m[1];
// A brand inside a URL is a link, not a mention; "chrome://extensions" is an address the user types.
const prose = text.replace(/\b(?:https?|chrome):\/\/\S+/g, ' ');

const problems = [];

const brands = BRANDS.map((b) => [b, count(prose, b, { caseSensitive: true })]).filter(([, n]) => n > 0);
console.log(`characters: ${text.trimEnd().length}`);
console.log(`brands (${brands.length} of ${MAX_BRANDS} allowed): ${brands.map(([b, n]) => `${b} ×${n}`).join(', ') || 'none'}`);
if (brands.length > MAX_BRANDS) problems.push(`${brands.length} brand names, more than ${MAX_BRANDS}`);
for (const [b, n] of brands) {
  if (n > MAX_KEYWORD_USES) problems.push(`"${b}" is used ${n} times, more than ${MAX_KEYWORD_USES}`);
}

console.log('keywords:');
for (const k of KEYWORDS) {
  const n = count(text, k, { caseSensitive: k === 'AI' || k === 'LLM' });
  console.log(`  ${k.padEnd(12)} ${n}`);
  if (n > MAX_KEYWORD_USES) problems.push(`"${k}" is used ${n} times, more than ${MAX_KEYWORD_USES}`);
}

// The dashboard's own field limits, which it enforces by refusing the paste.
const PERMISSIONS = path.join(ROOT, 'docs', 'store', 'permissions.md');
const NOTES = path.join(ROOT, 'docs', 'store', 'reviewer-notes.md');
const FIELD_LIMIT = 1000;
const INSTRUCTIONS_LIMIT = 500;

console.log(`justifications (${FIELD_LIMIT} characters each):`);
const permissions = fs.readFileSync(PERMISSIONS, 'utf8');
// Every fenced block in that file is a dashboard field, under the nearest heading above it.
for (const block of permissions.matchAll(/^#{2,3} (.+)\n(?:(?!^#{2,3} )[\s\S])*?```\n([\s\S]*?)```/gm)) {
  const name = block[1].replace(/`/g, '');
  const n = block[2].trimEnd().length;
  console.log(`  ${name.padEnd(30)} ${n}`);
  if (n > FIELD_LIMIT) problems.push(`the "${name}" justification is ${n} characters, over ${FIELD_LIMIT}`);
  if (block[2].trimEnd().includes('\n')) problems.push(`the "${name}" justification has a line break; the field is one paragraph`);
}

const notes = fs.readFileSync(NOTES, 'utf8');
const instructions = /## Test instructions\s+```\n([\s\S]*?)```/.exec(notes);
if (!instructions) {
  problems.push('no fenced block under "## Test instructions" in docs/store/reviewer-notes.md');
} else {
  const n = instructions[1].trimEnd().length;
  console.log(`test instructions (${INSTRUCTIONS_LIMIT} characters): ${n}`);
  if (n > INSTRUCTIONS_LIMIT) problems.push(`the test instructions are ${n} characters, over ${INSTRUCTIONS_LIMIT}`);
}

if (problems.length) {
  for (const p of problems) process.stderr.write(`listing-check: ${p}\n`);
  process.exit(1);
}
console.log('ok');
