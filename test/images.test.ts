// The pure half of attached images: what is accepted, how far it shrinks, where it sits in the
// message that goes to the model, how long the history keeps it, and how a blob is addressed.
// The decoding and re-encoding itself needs a browser and is exercised by the --images flow.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACCEPT_ATTR,
  ACCEPTED_MEDIA_TYPES,
  MAX_BYTES,
  MAX_EDGE,
  MAX_IMAGES_PER_MESSAGE,
  THUMB_EDGE,
  base64Bytes,
  blobsKey,
  capNote,
  elidedImageNote,
  emptyTextFor,
  fitWithin,
  formatBytes,
  imageHash,
  imageNote,
  isAcceptedType,
  parseDataUrl,
  refuseReason,
  sizeLabel,
  tooLargeNote,
  type AttachedImage,
} from '../lib/images.ts';
import { KEEP_IMAGE_TURNS, appendTurn, chatKeys, itemsKey, messagesKey, referencedHashes, slimMessages } from '../lib/chats.ts';
import { artifactKey } from '../lib/artifact.ts';
import { elideOldImages, estimatePart, IMAGE_TOKENS } from '../lib/agent/compact.ts';
import type { ChatItem, Msg, Part } from '../lib/types.ts';
import { pruneBlobs } from '../lib/blobs.ts';

/** A processed attachment, at whatever size the test cares about. */
function img(over: Partial<AttachedImage> = {}): AttachedImage {
  return { mediaType: 'image/jpeg', data: 'AAAA', width: 1200, height: 800, bytes: 240_000, ...over };
}

// ---------- what we take ----------

test('the four listed image types are accepted and nothing else is', () => {
  for (const type of ACCEPTED_MEDIA_TYPES) assert.equal(isAcceptedType(type), true, type);
  for (const type of ['image/svg+xml', 'image/avif', 'text/plain', 'application/pdf', '', undefined]) {
    assert.equal(isAcceptedType(type), false, String(type));
  }
});

test('a media type with a charset parameter is still recognised', () => {
  // A DataTransfer item can hand over "image/png; charset=binary" on some platforms.
  assert.equal(isAcceptedType('image/png; charset=binary'), true);
  assert.equal(isAcceptedType('IMAGE/PNG'), true);
});

test('the file picker offers exactly the accepted types', () => {
  assert.equal(ACCEPT_ATTR, 'image/png,image/jpeg,image/webp,image/gif');
});

test('an SVG is refused with a note that names the formats that work', () => {
  const note = refuseReason({ type: 'image/svg+xml', name: 'logo.svg' });
  assert.ok(note, 'an SVG must be refused');
  assert.match(note, /SVG is not supported/);
  assert.match(note, /PNG, JPEG, WebP or GIF/);
});

test('an SVG with a stripped media type is still caught by its name', () => {
  // A drop from some file managers arrives with an empty `type`; the extension is all we have.
  assert.match(refuseReason({ type: '', name: 'diagram.svg' }) ?? '', /SVG is not supported/);
  assert.match(refuseReason({ type: '', name: 'diagram.svgz' }) ?? '', /SVG is not supported/);
});

test('an accepted image is refused for no reason', () => {
  assert.equal(refuseReason({ type: 'image/png', name: 'shot.png' }), null);
  assert.equal(refuseReason({ type: 'image/webp', name: 'shot.webp' }), null);
});

test('a non-image says so rather than naming a format', () => {
  assert.match(refuseReason({ type: 'application/pdf', name: 'spec.pdf' }) ?? '', /Only images can be attached/);
  assert.match(refuseReason({ type: 'image/avif', name: 'a.avif' }) ?? '', /image\/avif images are not supported/);
});

// ---------- the caps ----------

test('four images fit in a message and a fifth does not', () => {
  assert.equal(capNote(0, 4), null);
  assert.equal(capNote(3, 1), null);
  assert.match(capNote(4, 1) ?? '', new RegExp(`${MAX_IMAGES_PER_MESSAGE} images per message`));
});

test('a partial overflow says how many were taken rather than refusing the lot', () => {
  const note = capNote(3, 3);
  assert.match(note ?? '', /Only 1 more image fits/);
  assert.doesNotMatch(note ?? '', /were skipped\b.*\bnone/);
});

test('an image still over the cap after shrinking is reported with both sizes', () => {
  const note = tooLargeNote('huge.png', 3_400_000);
  assert.match(note, /huge\.png/);
  assert.match(note, /3\.4 MB/);
  assert.match(note, new RegExp(formatBytes(MAX_BYTES).replace('.', '\\.')));
});

// ---------- sizing ----------

test('an oversized image is scaled to the long edge, keeping its aspect ratio', () => {
  const fit = fitWithin(6000, 6000, MAX_EDGE);
  assert.deepEqual(fit, { width: MAX_EDGE, height: MAX_EDGE });

  const wide = fitWithin(4000, 1000, MAX_EDGE);
  assert.equal(wide.width, MAX_EDGE);
  assert.equal(wide.height, Math.round((1000 * MAX_EDGE) / 4000));
  // The ratio survives to within a rounded pixel, which is what "not squashed" means in practice.
  assert.ok(Math.abs(wide.width / wide.height - 4) < 0.01);
});

test('an image already inside the box is never upscaled', () => {
  assert.deepEqual(fitWithin(400, 300, MAX_EDGE), { width: 400, height: 300 });
  assert.deepEqual(fitWithin(MAX_EDGE, 20, MAX_EDGE), { width: MAX_EDGE, height: 20 });
});

test('a very wide image still has at least one pixel on its short edge', () => {
  const fit = fitWithin(10_000, 3, MAX_EDGE);
  assert.equal(fit.width, MAX_EDGE);
  assert.ok(fit.height >= 1, 'a zero-height image would encode to nothing');
});

test('the thumbnail box is much smaller than the one that goes to the model', () => {
  assert.ok(THUMB_EDGE < MAX_EDGE / 4, 'a thumbnail that is a quarter of the full size is not a thumbnail');
  assert.deepEqual(fitWithin(1600, 800, THUMB_EDGE), { width: 320, height: 160 });
});

test('sizes read the way a person would write them', () => {
  assert.equal(formatBytes(1_200_000), '1.2 MB');
  assert.equal(formatBytes(240_000), '240 KB');
  assert.equal(formatBytes(812), '812 bytes');
  assert.equal(sizeLabel({ width: 1568, height: 980, bytes: 240_000 }), '1568×980 · 240 KB');
});

// ---------- base64 ----------

test('a base64 length is measured without decoding it', () => {
  assert.equal(base64Bytes('AAAA'), 3);
  assert.equal(base64Bytes('AAA='), 2);
  assert.equal(base64Bytes('AA=='), 1);
  assert.equal(base64Bytes(''), 0);
});

test('a data URL is split into its type and payload, and anything else is refused', () => {
  assert.deepEqual(parseDataUrl('data:image/png;base64,AAAA'), { mediaType: 'image/png', data: 'AAAA' });
  assert.equal(parseDataUrl('https://example.com/a.png'), null);
  assert.equal(parseDataUrl('data:image/png,notbase64'), null);
});

// ---------- what the model is told ----------

test('each image gets a caption with its index, size, format and name', () => {
  assert.equal(imageNote(img({ name: 'mock.png', mediaType: 'image/png' }), 0), '[attached image 1: 1200x800 png, mock.png]');
  assert.equal(imageNote(img(), 1), '[attached image 2: 1200x800 jpeg]');
});

test('an empty message with images sends a sentence rather than nothing', () => {
  assert.equal(emptyTextFor(1), 'Attached 1 image');
  assert.equal(emptyTextFor(3), 'Attached 3 images');
});

// ---------- the order in the rendered turn ----------
//
// renderTurn/turnParts are module-private in lib/agent/loop.ts, so the order they produce is
// asserted through appendTurn, which is the same rule written in the one place a test can reach.
// The browser flow asserts it end to end, on the wire.

test('a recovered turn puts its images before its text', () => {
  const out = appendTurn([], { text: 'make it look like this', images: [img({ name: 'a.png' }), img()] });
  assert.equal(out.length, 1);
  const kinds = out[0]!.content.map((p) => p.type);
  assert.deepEqual(kinds, ['image', 'image', 'text'], 'every provider expects the picture before the words');
});

test('a turn with no images is unchanged', () => {
  const out = appendTurn([], { text: 'hide the sidebar' });
  assert.deepEqual(out[0]!.content, [{ type: 'text', text: 'hide the sidebar' }]);
});

// ---------- history elision ----------

/** A user turn carrying `n` images and some text. */
function turn(text: string, n = 0): Msg {
  const parts: Part[] = [];
  for (let i = 0; i < n; i++) parts.push({ type: 'image', mediaType: 'image/jpeg', data: 'AAAA' });
  parts.push({ type: 'text', text });
  return { role: 'user', content: parts };
}

const reply = (text: string): Msg => ({ role: 'assistant', content: [{ type: 'text', text }] });

test('the two most recent user turns keep their images and older ones are stubbed', () => {
  const history: Msg[] = [turn('first', 2), reply('ok'), turn('second', 1), reply('ok'), turn('third', 1), reply('ok')];
  const slim = slimMessages(history);

  const images = (m: Msg) => m.content.filter((p) => p.type === 'image').length;
  assert.equal(images(slim[0]!), 0, 'the oldest turn loses its pictures');
  assert.equal(images(slim[2]!), 1, 'the second-newest turn keeps its picture');
  assert.equal(images(slim[4]!), 1, 'the newest turn keeps its picture');
  assert.equal(KEEP_IMAGE_TURNS, 2);
});

test('an elided image leaves a numbered stub where it was, so the message is never empty', () => {
  const history: Msg[] = [turn('first', 2), reply('ok'), turn('second'), reply('ok'), turn('third'), reply('ok')];
  const slim = slimMessages(history);
  const texts = slim[0]!.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
  assert.deepEqual(texts, [elidedImageNote(0), elidedImageNote(1), 'first']);
  assert.equal(elidedImageNote(0), '[attached image 1 elided]');
});

test('eliding the same history twice changes nothing the second time', () => {
  const history: Msg[] = [turn('first', 2), reply('ok'), turn('second'), reply('ok'), turn('third'), reply('ok')];
  const once = slimMessages(history);
  assert.deepEqual(slimMessages(once), once);
});

test('a screenshot in a tool result is dropped whatever its age', () => {
  const history: Msg[] = [
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'screenshot', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }] }] },
  ];
  const slim = slimMessages(history);
  const result = slim[1]!.content[0] as Extract<Part, { type: 'tool_result' }>;
  assert.deepEqual(result.content, [{ type: 'text', text: '[screenshot omitted from history]' }]);
});

test('a history with fewer turns than we promise to keep loses no images at all', () => {
  const history: Msg[] = [turn('only', 2), reply('ok')];
  assert.deepEqual(slimMessages(history), history);
});

test('a user message carrying tool results does not count as a turn', () => {
  // Otherwise a turn with two tool rounds would push its own images out of the keep window.
  const history: Msg[] = [
    turn('first', 1),
    { role: 'assistant', content: [{ type: 'tool_call', id: 't1', name: 'get_page', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't1', content: [{ type: 'text', text: 'html' }] }] },
    { role: 'assistant', content: [{ type: 'tool_call', id: 't2', name: 'get_page', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolCallId: 't2', content: [{ type: 'text', text: 'html' }] }] },
    turn('second', 1),
  ];
  const slim = slimMessages(history);
  assert.equal(slim[0]!.content.filter((p) => p.type === 'image').length, 1, 'both real turns are inside the window');
});

// ---------- compaction ----------

test('an attached image is counted at the same flat cost as a screenshot', () => {
  const part: Part = { type: 'image', mediaType: 'image/png', data: 'AAAA' };
  assert.ok(estimatePart(part) >= IMAGE_TOKENS, 'an image must not be estimated by its base64 length');
});

test('tier 1 elides attached images before the cutoff and leaves recent ones alone', () => {
  const history: Msg[] = [turn('old', 2), reply('ok'), turn('new', 1)];
  const { messages, changed } = elideOldImages(history, 2);
  assert.equal(changed, true);
  assert.equal(messages[0]!.content.filter((p) => p.type === 'image').length, 0);
  assert.equal(messages[2]!.content.filter((p) => p.type === 'image').length, 1);
});

test('tier 1 reports no change when every image is recent', () => {
  const history: Msg[] = [turn('new', 1)];
  const { messages, changed } = elideOldImages(history, 0);
  assert.equal(changed, false);
  assert.equal(messages, history, 'an unchanged history must be the same array, so no write is scheduled');
});

// ---------- blobs ----------

test('a chat owns a blobs key alongside its messages and items', () => {
  assert.equal(blobsKey('abc'), 'chat:abc:blobs');
  // Every per-chat key, not just the blobs one: chatKeys() is the single list every deletion route
  // uses, so this asserts the whole set — a key added later and forgotten here fails loudly rather
  // than leaking storage for the life of the profile. The draft mod's key is in it for that reason.
  assert.deepEqual(chatKeys('abc').sort(), [blobsKey('abc'), itemsKey('abc'), messagesKey('abc'), artifactKey('abc')].sort());
});

test('the same image hashes to the same key and a different one does not', () => {
  const a = imageHash('image/jpeg', 'AAAABBBB');
  assert.equal(a, imageHash('image/jpeg', 'AAAABBBB'));
  assert.notEqual(a, imageHash('image/png', 'AAAABBBB'), 'the media type is part of the identity');
  assert.notEqual(a, imageHash('image/jpeg', 'AAAABBBC'));
  assert.notEqual(a, imageHash('image/jpeg', 'AAAABBBB='), 'a different length must not collide');
});

test('a hash is short enough to sit in a storage key', () => {
  assert.ok(imageHash('image/png', 'A'.repeat(100_000)).length < 24);
});

test('the hashes a transcript still refers to are the ones worth keeping', () => {
  const items: ChatItem[] = [
    { kind: 'user', id: '1', text: 'a', images: [{ thumb: 'data:,', width: 1, height: 1, bytes: 1, hash: 'keep1' }] },
    { kind: 'assistant', text: 'ok' },
    { kind: 'user', id: '2', text: 'b', images: [{ thumb: 'data:,', width: 1, height: 1, bytes: 1, hash: 'keep2' }] },
    { kind: 'user', id: '3', text: 'c' },
  ];
  assert.deepEqual(referencedHashes(items).sort(), ['keep1', 'keep2']);

  const store = { keep1: {} as never, keep2: {} as never, gone: {} as never };
  assert.deepEqual(Object.keys(pruneBlobs(store, referencedHashes(items))).sort(), ['keep1', 'keep2']);
});
