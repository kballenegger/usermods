// Model-written chat titles: what survives the sanitiser, what the title call is fed, and when a
// chat is retitled at all.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTitleInput, completedTurns, REFRESH_AT_TURN, sanitizeTitle, stripTurnContext, titleDecision, TITLE_INPUT_MAX, TITLE_MAX } from '../lib/title.ts';
import type { Msg } from '../lib/types.ts';

const user = (text: string): Msg => ({ role: 'user', content: [{ type: 'text', text }] });
const assistant = (text: string): Msg => ({ role: 'assistant', content: [{ type: 'text', text }] });
const proposes = (name: string): Msg => ({
  role: 'assistant',
  content: [{ type: 'tool_call', id: 't1', name: 'propose_mod', input: { name, code: '…', matches: ['*://x/*'] } }],
});

// ---------- the sanitiser ----------

test('a clean title comes back untouched', () => {
  assert.equal(sanitizeTitle('Full-width Wikipedia articles'), 'Full-width Wikipedia articles');
});

test('wrapping quotes are stripped, straight and curly', () => {
  assert.equal(sanitizeTitle('"Dark mode for Hacker News"'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle("'Dark mode for Hacker News'"), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('“Dark mode for Hacker News”'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('«Dark mode for Hacker News»'), 'Dark mode for Hacker News');
});

test('a quote inside the title is kept, because only wrapping quotes are the model’s packaging', () => {
  assert.equal(sanitizeTitle('Hiding the "subscribe" banner'), 'Hiding the "subscribe" banner');
  // …and a wrapper around a title that also quotes a word still comes off.
  assert.equal(sanitizeTitle('"Hiding the “subscribe” banner"'), 'Hiding the “subscribe” banner');
});

test('markdown emphasis, headings and bullets come off', () => {
  assert.equal(sanitizeTitle('**Dark mode for Hacker News**'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('## Dark mode for Hacker News'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('- Dark mode for Hacker News'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('`Dark mode for Hacker News`'), 'Dark mode for Hacker News');
});

test('a "Title:" preamble is dropped', () => {
  assert.equal(sanitizeTitle('Title: Dark mode for Hacker News'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('Chat title — Dark mode for Hacker News'), 'Dark mode for Hacker News');
});

test('only the first non-empty line is used, so commentary is discarded', () => {
  assert.equal(sanitizeTitle('\n\nDark mode for Hacker News\n\nLet me know if you want another.'), 'Dark mode for Hacker News');
});

test('newlines inside a reply never reach the switcher', () => {
  assert.ok(!sanitizeTitle('Dark mode\nfor Hacker News').includes('\n'));
});

test('trailing punctuation and emoji are removed', () => {
  assert.equal(sanitizeTitle('Dark mode for Hacker News.'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('Dark mode for Hacker News!!'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('🌙 Dark mode for Hacker News'), 'Dark mode for Hacker News');
  assert.equal(sanitizeTitle('Dark mode for Hacker News ✨'), 'Dark mode for Hacker News');
});

test('quotes plus a period plus bold, all at once, still yield the bare title', () => {
  // The exact shape scripts/mock-llm.mjs replies with.
  assert.equal(sanitizeTitle('**"Full-width Wikipedia articles."**'), 'Full-width Wikipedia articles');
});

test('a title longer than the switcher allows is clamped with an ellipsis', () => {
  const long = sanitizeTitle('word '.repeat(40));
  assert.equal(long.length, TITLE_MAX);
  assert.ok(long.endsWith('…'));
});

test('an empty or whitespace-only reply means keep the existing title', () => {
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle('   \n\n  '), '');
  assert.equal(sanitizeTitle('""'), '');
  assert.equal(sanitizeTitle('...'), '');
});

test('a refusal is rejected rather than stored as the chat name', () => {
  assert.equal(sanitizeTitle("I'm sorry, but I can't help with that"), '');
  assert.equal(sanitizeTitle('I cannot name this conversation'), '');
  assert.equal(sanitizeTitle('Sorry — no title for this one'), '');
  assert.equal(sanitizeTitle('As an AI language model, I do not name chats'), '');
});

test('a title that merely starts with a word like "Improving" is not mistaken for a refusal', () => {
  assert.equal(sanitizeTitle('Improving the Wikipedia layout'), 'Improving the Wikipedia layout');
  assert.equal(sanitizeTitle('Image downloads from a gallery'), 'Image downloads from a gallery');
});

test('a non-string reply is handled rather than thrown on', () => {
  assert.equal(sanitizeTitle(undefined as unknown as string), '');
});

// ---------- the input the title call is given ----------

test('the agent’s bracketed context lines are stripped from the user’s text', () => {
  const raw = '[Current page: Common kingfisher — https://en.wikipedia.org/wiki/Common_kingfisher]\n[@img.thumb = image — selector: img]\n\nhide the sidebar';
  assert.equal(stripTurnContext(raw), 'hide the sidebar');
});

test('the first-turn input carries the user request, the proposal name and the last reply', () => {
  const messages = [user('[Current page: HN — https://news.ycombinator.com/]\n\nmake hacker news dark'), proposes('Hacker News dark'), assistant('Here is a dark theme.')];
  const input = buildTitleInput(messages, { userMessages: 1, includeAssistant: true });
  assert.match(input, /User: make hacker news dark/);
  assert.match(input, /Proposed mod: Hacker News dark/);
  assert.match(input, /Assistant: Here is a dark theme\./);
  assert.ok(!input.includes('[Current page:'), 'page context is noise for a title');
});

test('the refresh input is the last three user messages and nothing from the assistant', () => {
  const messages = [user('one'), assistant('a'), user('two'), assistant('b'), user('three'), assistant('c'), user('four'), assistant('d')];
  const input = buildTitleInput(messages, { userMessages: 3, includeAssistant: false });
  assert.deepEqual(input.split('\n'), ['User: two', 'User: three', 'User: four']);
});

test('the input stays under the budget however long the conversation is', () => {
  const messages = [user('x'.repeat(9000)), assistant('y'.repeat(9000)), proposes('z'.repeat(400))];
  const input = buildTitleInput(messages);
  assert.ok(input.length <= TITLE_INPUT_MAX, `input was ${input.length} chars`);
  assert.ok(input.startsWith('User: xxx'));
});

test('a chat with nothing but context lines produces no input, so no call is made', () => {
  assert.equal(buildTitleInput([user('[Current page: X — https://x/]')]), '');
  assert.equal(buildTitleInput([]), '');
});

// ---------- how many turns have completed ----------

test('completed turns counts the user’s messages, not the model’s round trips', () => {
  assert.equal(completedTurns([]), 0);
  assert.equal(completedTurns([user('one'), assistant('a')]), 1);
  assert.equal(completedTurns([user('one'), assistant('a'), user('two'), assistant('b')]), 2);
});

test('a tool-result message does not count as a turn of its own', () => {
  // The loop pushes tool results back as a user message with no text part.
  const results: Msg = { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: [{ type: 'text', text: 'ok' }] }] };
  assert.equal(completedTurns([user('one'), proposes('m'), results, assistant('done')]), 1);
});

// ---------- when a chat gets retitled ----------

test('the first completed turn names the chat', () => {
  assert.deepEqual(titleDecision({ titleSource: 'auto-first' }, 1, true), { kind: 'first' });
});

test('turns 2 and 3 change nothing', () => {
  assert.deepEqual(titleDecision({ titleSource: 'auto-model' }, 2, true), { kind: 'none' });
  assert.deepEqual(titleDecision({ titleSource: 'auto-model' }, 3, true), { kind: 'none' });
});

test('the 4th turn refreshes a model-written title exactly once', () => {
  assert.deepEqual(titleDecision({ titleSource: 'auto-model' }, REFRESH_AT_TURN, true), { kind: 'refresh' });
  assert.deepEqual(titleDecision({ titleSource: 'auto-model', titleRefreshed: true }, REFRESH_AT_TURN, true), { kind: 'none' });
});

test('there is never a second refresh, however long the chat runs', () => {
  for (const turns of [5, 6, 8, 12, 40]) {
    assert.deepEqual(titleDecision({ titleSource: 'auto-model' }, turns, true), { kind: 'none' }, `turn ${turns}`);
    assert.deepEqual(titleDecision({ titleSource: 'auto-model', titleRefreshed: true }, turns, true), { kind: 'none' }, `turn ${turns}`);
  }
});

test('a title the user typed is never overwritten, at the first turn or the refresh', () => {
  assert.deepEqual(titleDecision({ titleSource: 'user' }, 1, true), { kind: 'none' });
  assert.deepEqual(titleDecision({ titleSource: 'user' }, REFRESH_AT_TURN, true), { kind: 'none' });
});

test('a chat still on its truncated first message is not refreshed at turn 4', () => {
  // Only 'auto-model' chats refresh: an 'auto-first' title at turn 4 means naming was off when the
  // chat started, and turning it on later should not retroactively rename old chats mid-flight.
  assert.deepEqual(titleDecision({ titleSource: 'auto-first' }, REFRESH_AT_TURN, true), { kind: 'none' });
});

test('a record from before the field existed is treated as auto-first', () => {
  assert.deepEqual(titleDecision({}, 1, true), { kind: 'first' });
  assert.deepEqual(titleDecision({}, REFRESH_AT_TURN, true), { kind: 'none' });
});

test('the setting off means no title call ever happens', () => {
  assert.deepEqual(titleDecision({ titleSource: 'auto-first' }, 1, false), { kind: 'none' });
  assert.deepEqual(titleDecision({ titleSource: 'auto-model' }, REFRESH_AT_TURN, false), { kind: 'none' });
});

test('a chat that has gone missing decides nothing', () => {
  assert.deepEqual(titleDecision(null, 1, true), { kind: 'none' });
  assert.deepEqual(titleDecision(undefined, 1, true), { kind: 'none' });
});

test('a turn count of zero does nothing, so an empty chat is never named', () => {
  assert.deepEqual(titleDecision({ titleSource: 'auto-first' }, 0, true), { kind: 'none' });
});
