// lib/skillcompile.ts: from what the extension saw to a skill file. Each of the three examples is
// compared byte for byte with its fixture, which is also what the smoke flow compiles to through the
// built extension; and nothing typed may reach the file, the record or the journal.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { compileRecording, defaultDecisions, recordingOf, saveCardFor, valueIn, type JournalEntry, type SaveDecisions } from '../lib/skillcompile.ts';
import { parseSkill, previewSkill } from '../lib/skills.ts';
import type { Msg } from '../lib/types.ts';

const expected = (name: string) => fs.readFileSync(new URL(`./fixtures/skill/${name}/expected.skill.md`, import.meta.url), 'utf8');
const RUN = 'run-1';
const opts = (values: Record<string, string> = {}) => ({ today: '2026-11-02', valueOf: (toolId: string, i: number) => values[`${toolId}:${i}`] ?? null });

const entry = <E extends Partial<JournalEntry>>(n: number, url: string, e: E) => ({ n, run: RUN, url, ...e }) as unknown as JournalEntry;

function expenseJournal(): JournalEntry[] {
  const u = 'https://expenses.example.com/expenses/new';
  const form = 'form "New expense"';
  const fill = (n: number, name: string, id: string, why: string, toolId: string) => entry(n, u, { kind: 'act', verb: 'fill', role: 'textbox', name, at: { css: `#${id}`, in: form }, why, toolId, stepIndex: 0 });
  return [
    fill(1, 'Merchant', 'merchant', 'enter the merchant name', 't1'),
    fill(2, 'Amount', 'amount', 'enter the amount', 't2'),
    fill(3, 'Note', 'note', 'enter the note, if any', 't3'),
    entry(4, u, { kind: 'wait', condition: { selector: 'button[type=submit]', state: 'visible' } }),
    entry(5, u, { kind: 'ask', text: 'Check the form and press Submit.', until: { text: 'Expense filed' } }),
  ];
}

const expenseDecisions: SaveDecisions = {
  name: 'File an expense',
  description: 'Fills the new-expense form from your inputs and stops before Submit so you press it.',
  fields: {
    1: { as: 'input', name: 'merchant', label: 'Merchant' },
    2: { as: 'input', name: 'amount', label: 'Amount' },
    3: { as: 'input', name: 'note', label: 'Note', optional: true },
  },
  outputs: {},
};

test('a form with inputs compiles to the fixture, byte for byte', () => {
  const r = compileRecording(expenseJournal(), expenseDecisions, opts());
  assert.ok(r.ok, !r.ok ? r.errors.join() : '');
  assert.equal(r.source, expected('expense-form'));
  assert.ok(previewSkill(r.source).ok, 'and a file it writes is one the preview takes');
});

test('a process across pages compiles to the fixture, byte for byte', () => {
  const u = 'https://billing.example.com/invoices';
  const journal = [
    entry(1, 'https://billing.example.com/', { kind: 'act', verb: 'go', role: '', name: '', at: {}, to: u, why: 'open the invoices page' }),
    entry(2, u, { kind: 'look', selector: 'select', matched: 1, links: false }),
    entry(3, u, { kind: 'act', verb: 'select', role: 'combobox', name: 'Period', at: { css: '#period', in: 'form "Filters"' }, why: "show only this month's invoices", toolId: 't2', stepIndex: 0 }),
    entry(4, u, { kind: 'wait', condition: { selector: 'tr:nth-child(3)', state: 'visible' } }),
    entry(5, u, { kind: 'look', selector: 'table tbody tr td.number', matched: 3, links: false }),
    entry(6, u, { kind: 'act', verb: 'click', role: 'link', name: 'Download CSV', at: { css: '#download-csv', in: 'region "Invoices"', nth: 0 }, why: 'download the filtered list' }),
    entry(7, u, { kind: 'wait', condition: { ms: 500 } }),
  ];
  const r = compileRecording(
    journal,
    { name: "Export this month's invoices", description: 'Filters the invoices page to this month, lists the invoice numbers and downloads the CSV.', fields: { 3: { as: 'constant' } }, outputs: { 5: { name: 'invoices', label: 'Invoice numbers', take: 'text', list: true } } },
    opts({ 't2:0': 'This month' }),
  );
  assert.ok(r.ok, !r.ok ? r.errors.join() : '');
  assert.equal(r.source, expected('export-invoices'));
});

test('an extraction compiles to the fixture, with no first navigation when start was widened to a prefix', () => {
  const u = 'https://photos.example.com/albums/2026-kyoto';
  const journal = [
    entry(1, u, { kind: 'act', verb: 'click', role: 'button', name: 'Load more', at: { css: '#load', in: 'main "Album"' }, repeat: 50, why: 'load every photo in the album' }),
    entry(2, u, { kind: 'wait', condition: { idle: true, quiet_ms: 300 } }),
    entry(3, u, { kind: 'look', selector: 'a.photo-download', matched: 9, links: true }),
  ];
  const r = compileRecording(journal, { name: 'Album download links', description: 'Loads every photo in an album and collects the download links.', start: 'https://photos.example.com/albums/', fields: {}, outputs: { 3: { name: 'links', label: 'Download links', take: 'href', list: true } } }, opts());
  assert.ok(r.ok, !r.ok ? r.errors.join() : '');
  assert.equal(r.source, expected('album-links'));
});

test('a typed value never reaches the file: an input is a name', () => {
  const r = compileRecording(expenseJournal(), expenseDecisions, { today: '2026-11-02', valueOf: () => 'BLUE-BOTTLE-SECRET' });
  assert.ok(r.ok);
  assert.doesNotMatch(r.source, /BLUE-BOTTLE-SECRET/);
});

test('the model quoting what it typed does not get it into the file: a why goes, an ask is blanked', () => {
  const u = 'https://x.example.com/a';
  const rec = [
    entry(1, u, { kind: 'act', verb: 'fill', role: 'textbox', name: 'Merchant', at: { css: '#m' }, why: 'type Blue Bottle into the merchant', toolId: 't', stepIndex: 0 }),
    entry(2, u, { kind: 'act', verb: 'click', role: 'button', name: 'Next', at: { css: '#n' }, why: 'go on to the next page' }),
    entry(3, u, { kind: 'ask', text: 'Check that blue bottle is right and press Submit.' }),
  ];
  const r = compileRecording(rec, { name: 'x', description: 'y', fields: { 1: { as: 'input', name: 'merchant', label: 'Merchant' } }, outputs: {} }, opts({ 't:0': 'Blue Bottle' }));
  assert.ok(r.ok, !r.ok ? r.errors.join() : '');
  assert.doesNotMatch(r.source, /blue bottle/i);
  assert.match(r.source, /go on to the next page/, 'a why with nothing typed in it stays');
  assert.match(r.source, /Check that … is right/);
});

test('a wait or an address that holds what was typed is refused, not written', () => {
  const u = 'https://x.example.com/a';
  const fill = entry(1, u, { kind: 'act', verb: 'fill', role: 'textbox', name: 'Q', at: { css: '#q' }, toolId: 't', stepIndex: 0 });
  const d: SaveDecisions = { name: 'x', description: 'y', fields: { 1: { as: 'input', name: 'q', label: 'Q' } }, outputs: {} };
  const values = opts({ 't:0': 'secret word' });
  const wait = compileRecording([fill, entry(2, u, { kind: 'wait', condition: { text: 'secret word' } })], d, values);
  assert.ok(!wait.ok);
  assert.match(wait.errors[0]!, /holds what was typed/);
  const go = compileRecording([fill, entry(2, u, { kind: 'act', verb: 'go', role: '', name: '', at: {}, to: 'https://x.example.com/s?q=secret%20word' })], d, values);
  assert.ok(!go.ok);
  assert.match(go.errors[0]!, /holds what was typed/);
  const asConstant = compileRecording([fill, entry(2, u, { kind: 'wait', condition: { text: 'secret word' } })], { ...d, fields: { 1: { as: 'constant' } } }, values);
  assert.ok(asConstant.ok, 'a value the user chose to keep may be waited for');
});

test('the card does not offer a chat title that quotes what was typed as the skill’s name', () => {
  const rec = [entry(1, 'https://x.example.com/', { kind: 'act', verb: 'fill', role: 'textbox', name: 'M', at: { css: '#m' }, toolId: 't', stepIndex: 0 })];
  assert.equal(saveCardFor(rec, RUN, () => 'Blue Bottle', { title: 'lunch at Blue Bottle please' }).name, 'On x.example.com');
  assert.equal(saveCardFor(rec, RUN, () => 'Blue Bottle', { title: 'file my lunch' }).name, 'file my lunch');
});

test('the journal has no field for a value, and a value is found through the call that typed it', () => {
  const messages: Msg[] = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'act', input: { steps: [{ do: 'fill', target: '#m', text: 'Blue Bottle' }, { do: 'fill', target: '#a', text: '42' }] } }] },
  ];
  assert.equal(valueIn(messages, 't1', 1), '42');
  assert.equal(valueIn(messages, 't1', 7), null);
  assert.equal(valueIn(messages, 'gone', 0), null, 'a compaction took it, and the card says so');
  assert.doesNotMatch(JSON.stringify(expenseJournal()), /Blue Bottle|42/);
});

test('the card: every typed value offered as an input, a choice from the page as a constant, the last look kept', () => {
  const u = 'https://x.example.com/a';
  const rec = [
    entry(1, u, { kind: 'act', verb: 'fill', role: 'textbox', name: 'Full name', at: { css: '#n' }, toolId: 't', stepIndex: 0 }),
    entry(2, u, { kind: 'act', verb: 'fill', role: 'textbox', name: 'Full name', at: { css: '#o' }, toolId: 't', stepIndex: 1 }),
    entry(3, u, { kind: 'act', verb: 'select', role: 'combobox', name: 'Size', at: { css: '#s' }, toolId: 't', stepIndex: 2 }),
    entry(4, u, { kind: 'look', selector: 'ul li', matched: 2, links: false }),
    entry(5, u, { kind: 'act', verb: 'click', role: 'button', name: 'Go', at: { css: '#g' } }),
    entry(6, u, { kind: 'look', selector: 'a.result', matched: 5, links: true }),
  ];
  const values: Record<string, string> = { 't:0': 'Ada', 't:1': 'Grace', 't:2': 'Large' };
  const card = saveCardFor(rec, RUN, (t, i) => values[`${t}:${i}`] ?? null, { title: 'My chat' });
  assert.equal(card.name, 'My chat');
  assert.equal(card.start, u);
  assert.deepEqual(card.fields.map((f) => [f.name, f.value, f.suggest]), [['full_name', 'Ada', 'input'], ['full_name_2', 'Grace', 'input'], ['size', 'Large', 'constant']]);
  assert.deepEqual(card.looks.map((l) => [l.selector, l.take, l.suggest]), [['ul li', 'text', false], ['a.result', 'href', true]]);
  const d = defaultDecisions(card);
  const r = compileRecording(rec, d, { today: '2026-11-02', valueOf: (t, i) => values[`${t}:${i}`] ?? null });
  assert.ok(r.ok, !r.ok ? r.errors.join() : '');
  assert.doesNotMatch(r.source, /Ada|Grace/);
  assert.match(r.source, /select: Large/, 'a constant the user left as one is written');
});

test('a value the conversation no longer holds cannot be a constant', () => {
  const rec = [entry(1, 'https://x.example.com/', { kind: 'act', verb: 'fill', role: 'textbox', name: 'N', at: { css: '#n' }, toolId: 't', stepIndex: 0 })];
  const card = saveCardFor(rec, RUN, () => null);
  assert.equal(card.fields[0]!.suggest, 'input');
  const r = compileRecording(rec, { name: 'x', description: 'y', fields: { 1: { as: 'constant' } }, outputs: {} }, opts());
  assert.ok(!r.ok);
  assert.match(r.errors[0]!, /can only be an input/);
});

test('a go off the site is an error, not a step', () => {
  const u = 'https://x.example.com/';
  const rec = [entry(1, u, { kind: 'act', verb: 'click', role: 'button', name: 'A', at: { css: '#a' } }), entry(2, u, { kind: 'act', verb: 'go', role: '', name: '', at: {}, to: 'https://evil.test/' })];
  const r = compileRecording(rec, { name: 'x', description: 'y', fields: {}, outputs: {} }, opts());
  assert.ok(!r.ok);
  assert.match(r.errors[0]!, /off the site/);
});

test('a value with no decision is an error: nothing typed slips through by being forgotten', () => {
  const rec = [entry(1, 'https://x.example.com/', { kind: 'act', verb: 'fill', role: 'textbox', name: 'N', at: { css: '#n' }, toolId: 't', stepIndex: 0 })];
  const r = compileRecording(rec, { name: 'x', description: 'y', fields: {}, outputs: {} }, opts({ 't:0': 'typed' }));
  assert.ok(!r.ok);
  assert.match(r.errors[0]!, /nothing was decided/);
});

test('scripts and declined steps are not steps, and the body says one was declined', () => {
  const u = 'https://x.example.com/';
  const rec = [
    entry(1, u, { kind: 'act', verb: 'click', role: 'button', name: 'A', at: { css: '#a' } }),
    entry(2, u, { kind: 'script', label: 'hide the header' }),
    entry(3, u, { kind: 'dropped', label: 'click button "Delete"', consequential: true }),
  ];
  const card = saveCardFor(rec, RUN, () => null);
  assert.match(card.scriptNote!, /this run used scripts; only its 1 act step can be saved/);
  const r = compileRecording(rec, { name: 'x', description: 'y', fields: {}, outputs: {} }, opts());
  assert.ok(r.ok);
  assert.match(r.source, /One step was declined during recording and is not in this skill\./);
  assert.doesNotMatch(r.source, /hide the header|Delete/);
});

test('then_wait and a wait_for for the same thing are one wait; a different one is kept', () => {
  const u = 'https://x.example.com/';
  const w = { selector: '.a', state: 'visible' };
  const rec = [
    entry(1, u, { kind: 'act', verb: 'click', role: 'button', name: 'A', at: { css: '#a' } }),
    entry(2, u, { kind: 'wait', condition: w }),
    entry(3, u, { kind: 'wait', condition: w }),
    entry(4, u, { kind: 'wait', condition: { ms: 100 } }),
  ];
  const r = compileRecording(rec, { name: 'x', description: 'y', fields: {}, outputs: {} }, opts());
  assert.ok(r.ok);
  const parsed = parseSkill(r.source);
  assert.ok(parsed.ok);
  assert.equal(parsed.skill.steps.filter((s) => s.verb === 'wait').length, 2);
});

test('the recording is a run from its first act: what it looked at first, and other runs, are not in it', () => {
  const u = 'https://x.example.com/';
  const list = [entry(1, u, { kind: 'look', selector: 'h1', matched: 1, links: false }), entry(2, u, { kind: 'act', verb: 'click', role: 'button', name: 'A', at: { css: '#a' } }), { ...entry(3, u, { kind: 'act', verb: 'click', role: 'button', name: 'B', at: { css: '#b' } }), run: 'other' } as JournalEntry, entry(4, u, { kind: 'wait', condition: { ms: 1 } })];
  assert.deepEqual(recordingOf(list, RUN).map((e) => e.n), [2, 4]);
  assert.deepEqual(recordingOf(list, 'none'), []);
});
