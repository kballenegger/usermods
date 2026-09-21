// The compact shell's decisions (lib/compactshell.ts): which sheet is up, what the one button
// beside the message box does, which tool rows fold, what the draft pill says, and what size the
// iPad popover settles at. These are the parts of a content-first phone UI that a screenshot
// cannot vouch for, because most of them are about what is NOT on screen.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Artifact } from '../lib/artifact.ts';
import { FOLD_AT, POPOVER_FLOOR, POPOVER_GROW_STEP, SEND_LABEL, draftPill, foldToolRows, nextSheet, sendMode, stepsSummary, tabletPopupSize } from '../lib/compactshell.ts';
import type { ChatItem } from '../lib/types.ts';

type Tool = Extract<ChatItem, { kind: 'tool' }>;
const tool = (id: string, over: Partial<Tool> = {}): Tool => ({ kind: 'tool', id, name: 'find_elements', input: { selector: `#${id}` }, summary: 'ok', ...over });
const say = (text: string): ChatItem => ({ kind: 'assistant', text });

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

test('one sheet at a time: a sheet opened from a sheet replaces it', () => {
  const draft = { hasDraft: true };
  assert.equal(nextSheet(null, { type: 'open', sheet: 'add' }, draft), 'add');
  // "+" then Model. Closing the model sheet must land on the chat, not back on "+".
  const model = nextSheet('add', { type: 'open', sheet: 'model' }, draft);
  assert.equal(model, 'model');
  assert.equal(nextSheet(model, { type: 'close' }, draft), null);
  assert.equal(nextSheet('chat', { type: 'open', sheet: 'editmod' }, draft), 'editmod');
});

test('picking something ends the sheet', () => {
  for (const sheet of ['chat', 'add', 'model', 'draft', 'editmod'] as const) {
    assert.equal(nextSheet(sheet, { type: 'done' }, { hasDraft: true }), null);
  }
});

test('the draft sheet needs a draft', () => {
  assert.equal(nextSheet(null, { type: 'open', sheet: 'draft' }, { hasDraft: false }), null);
  assert.equal(nextSheet(null, { type: 'open', sheet: 'draft' }, { hasDraft: true }), 'draft');
});

test('a sheet about this chat does not outlive the chat', () => {
  const ctx = { hasDraft: true };
  // These three are showing the previous chat's list position, model or draft.
  for (const sheet of ['chat', 'model', 'draft'] as const) assert.equal(nextSheet(sheet, { type: 'chat-changed' }, ctx), null);
  // These are not about a chat: the first send creates the chat while "+" may still be up.
  for (const sheet of ['add', 'editmod'] as const) assert.equal(nextSheet(sheet, { type: 'chat-changed' }, ctx), sheet);
  assert.equal(nextSheet(null, { type: 'chat-changed' }, ctx), null);
});

// ---------------------------------------------------------------------------
// Send / Queue / Stop
// ---------------------------------------------------------------------------

test('the one button is Send, Queue or Stop', () => {
  assert.equal(sendMode({ busy: false, hasContent: false }), 'send');
  assert.equal(sendMode({ busy: false, hasContent: true }), 'send');
  // A run in flight and nothing typed: the button stops it.
  assert.equal(sendMode({ busy: true, hasContent: false }), 'stop');
  // Something typed: it queues, as the panel's Queue does. Stop is still on the activity line.
  assert.equal(sendMode({ busy: true, hasContent: true }), 'queue');
});

test('every mode has a name a screen reader can say', () => {
  for (const mode of ['send', 'queue', 'stop'] as const) assert.ok(SEND_LABEL[mode].length > 0);
  assert.notEqual(SEND_LABEL.send, SEND_LABEL.queue);
});

// ---------------------------------------------------------------------------
// Folding
// ---------------------------------------------------------------------------

test('a long run of tool rows folds into one block, a short one does not', () => {
  const items: ChatItem[] = [say('a'), tool('1'), tool('2'), say('b'), tool('3'), tool('4'), tool('5'), tool('6'), say('c')];
  assert.equal(FOLD_AT, 3);
  assert.deepEqual(foldToolRows(items), [
    { kind: 'item', index: 0 },
    { kind: 'item', index: 1 },
    { kind: 'item', index: 2 },
    { kind: 'item', index: 3 },
    { kind: 'steps', indices: [4, 5, 6, 7] },
    { kind: 'item', index: 8 },
  ]);
});

test('folding never reorders and never loses a row', () => {
  const items: ChatItem[] = [tool('1'), tool('2'), tool('3'), say('x'), tool('4'), { kind: 'note', text: 'n' }, tool('5'), tool('6'), tool('7')];
  const seen = foldToolRows(items).flatMap((b) => (b.kind === 'item' ? [b.index] : b.indices));
  assert.deepEqual(seen, items.map((_, i) => i));
});

test('only adjacent tool rows fold: prose between them keeps the order honest', () => {
  const items: ChatItem[] = [tool('1'), tool('2'), say('then'), tool('3'), tool('4')];
  assert.ok(foldToolRows(items).every((b) => b.kind === 'item'));
});

test('a run at the very end folds, which is the run in progress', () => {
  const blocks = foldToolRows([say('a'), tool('1'), tool('2'), tool('3', { summary: undefined })]);
  assert.deepEqual(blocks.at(-1), { kind: 'steps', indices: [1, 2, 3] });
});

test('an empty transcript folds to nothing', () => {
  assert.deepEqual(foldToolRows([]), []);
});

test('the folded line names the step that is running', () => {
  const s = stepsSummary([tool('1'), tool('2'), tool('3', { name: 'run_script', input: { description: 'widen the table' }, summary: undefined })]);
  assert.equal(s.state, 'running');
  assert.equal(s.label, '3 steps · run_script: widen the table');
});

test('folding cannot hide a failure', () => {
  const s = stepsSummary([tool('1'), tool('2', { isError: true, summary: 'boom' }), tool('3')]);
  assert.equal(s.state, 'error');
  assert.equal(s.label, '3 steps · 1 failed');
});

test('a wait that timed out is amber, not a failure', () => {
  const s = stepsSummary([tool('1'), tool('2', { name: 'wait_for', summary: 'timed out after 2000ms' }), tool('3')]);
  assert.equal(s.state, 'waiting');
  assert.equal(s.label, '3 steps · 1 timed out');
});

test('a clean run is just the count', () => {
  assert.deepEqual(stepsSummary([tool('1'), tool('2'), tool('3'), tool('4')]), { label: '4 steps', state: 'ok' });
  assert.equal(stepsSummary([tool('1')]).label, '1 step');
});

// ---------------------------------------------------------------------------
// The draft pill
// ---------------------------------------------------------------------------

function artifact(over: Partial<Artifact> = {}): Artifact {
  const v = (n: number) => ({ n, code: `// v${n}`, name: 'Kingfisher Notes', description: '', matches: ['https://example.com/*'], createdAt: n, source: 'proposal' as const });
  return { id: 'a', chatId: 'c', name: 'Kingfisher Notes', description: '', matches: [], versions: [v(1), v(2)], current: 2, ...over };
}

test('a draft that was never saved offers Save', () => {
  const p = draftPill(artifact(), '')!;
  assert.deepEqual([p.name, p.version, p.status, p.action, p.upToDate], ['Kingfisher Notes', 'v2', 'draft', 'Save', false]);
});

test('an edit of an installed mod says so, and offers Update', () => {
  const p = draftPill(artifact({ linkedModId: 'm', savedVersion: 1 }), 'Kingfisher Notes')!;
  assert.deepEqual([p.status, p.action, p.upToDate], ['editing', 'Update', false]);
  assert.match(p.label, /editing the installed mod “Kingfisher Notes”/);
});

test('once the mod holds this version there is nothing to press', () => {
  const p = draftPill(artifact({ linkedModId: 'm', savedVersion: 2 }), 'Kingfisher Notes')!;
  assert.deepEqual([p.status, p.upToDate], ['saved', true]);
});

test('a draft whose mod was deleted is not "editing" anything', () => {
  // The caller resolves the name from the live mod list, so a deleted mod arrives as ''.
  const p = draftPill(artifact({ linkedModId: 'gone', savedVersion: 1 }), '')!;
  assert.equal(p.status, 'unsaved');
  assert.equal(p.action, 'Update');
});

test('the pill names itself in one sentence for VoiceOver', () => {
  assert.equal(draftPill(artifact(), '')!.label, 'Draft: Kingfisher Notes, v2, not saved yet. Show the draft');
});

test('an artifact with no versions has no pill', () => {
  assert.equal(draftPill(artifact({ versions: [] }), ''), null);
});

// ---------------------------------------------------------------------------
// The iPad popover
// ---------------------------------------------------------------------------

const STATIC = { width: 440, height: 660 };

test('a viewport that is not a real window never replaces the static size', () => {
  // The two windows a content-sized popover offers before it has been sized, and the sliver the
  // Mac bug produced. Adopting any of these is the deadlock.
  assert.deepEqual(tabletPopupSize({ width: 100, height: 50 }, STATIC), STATIC);
  assert.deepEqual(tabletPopupSize({ width: 0, height: 0 }, STATIC), STATIC);
  assert.deepEqual(tabletPopupSize({ width: NaN, height: NaN }, STATIC), STATIC);
  // 470 is wider than the document by less than a real window would be; 90 is under the floor.
  assert.deepEqual(tabletPopupSize({ width: 470, height: 90 }, STATIC), STATIC);
});

test('the popover at its own size is a fixed point', () => {
  assert.deepEqual(tabletPopupSize(STATIC, STATIC), STATIC);
});

test('a popover a few pixels larger than its content is not chased', () => {
  const grown = { width: STATIC.width + POPOVER_GROW_STEP - 1, height: STATIC.height + POPOVER_GROW_STEP - 1 };
  assert.deepEqual(tabletPopupSize(grown, STATIC), STATIC);
});

test('a popover Safari clamped shorter is adopted, so the composer stays on screen', () => {
  assert.deepEqual(tabletPopupSize({ width: 440, height: 560 }, STATIC), { width: 440, height: 560 });
});

test('a system-sized sheet (Split View, Slide Over) is adopted, narrower and taller', () => {
  assert.deepEqual(tabletPopupSize({ width: 320, height: 900 }, STATIC), { width: 320, height: 900 });
  assert.deepEqual(tabletPopupSize({ width: 507, height: 1000 }, STATIC), { width: 507, height: 1000 });
});

test('the result is never smaller than the floor', () => {
  for (const vp of [{ width: 319, height: 419 }, { width: 1, height: 1 }, { width: 320, height: 420 }]) {
    const out = tabletPopupSize(vp, STATIC);
    assert.ok(out.width >= POPOVER_FLOOR.width && out.height >= POPOVER_FLOOR.height, JSON.stringify(out));
  }
});

test('each dimension is judged alone', () => {
  // A usable width with a useless height: take the one, keep the other.
  assert.deepEqual(tabletPopupSize({ width: 360, height: 90 }, STATIC), { width: 360, height: 660 });
});
