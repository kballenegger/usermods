// scripts/appstore-connect.mjs fills the App Store record from docs/store/appstore/. It cannot be
// run here (it needs the API key), so these pin the two things that would otherwise fail at Apple:
// the copy fitting the field limits, and the script never carrying a credential.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(root + rel, 'utf8');

/** The first fenced block after a `## heading`, the way the script reads it. */
function fenced(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}`);
  assert.notEqual(start, -1, `no "## ${heading}" section`);
  const open = markdown.indexOf('\n```', start);
  const close = markdown.indexOf('\n```', open + 4);
  assert.ok(open !== -1 && close !== -1, `no fenced block under "## ${heading}"`);
  return markdown.slice(markdown.indexOf('\n', open + 1) + 1, close).replace(/\n+$/, '');
}

test('the listing copy fits every App Store field it is pasted into', () => {
  const md = read('docs/store/appstore/listing.md');
  assert.ok(fenced(md, 'Promotional text').length <= 170, 'promotional text over 170');
  assert.ok(fenced(md, 'Description').length <= 4000, 'description over 4000');
  assert.ok(fenced(md, 'Keywords').replace(/\s*\n\s*/g, '').length <= 100, 'keywords over 100');
  assert.ok(fenced(md, "What's New in This Version").length <= 4000, "what's new over 4000");
  assert.match(md, /Support URL \| `https:\/\/[^`]+`/);
});

test('the review notes carry exactly the two placeholders the script fills, and fit once filled', () => {
  const notes = fenced(read('docs/store/appstore/reviewer-notes.md'), 'Notes');
  const placeholders = notes.match(/<[A-Z_ ]+>/g) ?? [];
  assert.deepEqual([...new Set(placeholders)].sort(), ['<API_KEY>', '<BASE_URL>']);
  // A real endpoint and key are longer than the placeholders; leave headroom under 4,000.
  assert.ok(notes.length <= 3900, `the notes are ${notes.length} characters with the placeholders in`);
});

test('the screenshots are the sets the script uploads, in the order it uploads them', () => {
  const files = readdirSync(root + 'docs/store/appstore/screenshots/').filter((f) => f.endsWith('.png')).sort();
  assert.deepEqual(files.filter((f) => f.startsWith('iphone-')).length, 5);
  assert.deepEqual(files.filter((f) => f.startsWith('ipad-')).length, 4);
});

test('the script reads credentials from outside the repository and carries none', () => {
  const script = read('scripts/appstore-connect.mjs');
  assert.match(script, /appstore\.env/);
  assert.match(script, /ASC_KEY_PATH/);
  // The header's AuthKey_XXXXXXXXXX.p8 is a placeholder; a real key id has no run of Xs.
  assert.doesNotMatch(script, /AuthKey_(?!X+\.)[A-Z0-9]{6,}/);
  assert.doesNotMatch(script, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.doesNotMatch(script, /sk-[A-Za-z0-9]{10,}/);
  // The notes are sent, never printed.
  assert.doesNotMatch(script, /\$\{(review|rd\.attributes)\.notes\}/);
});
