// Running out of chrome.storage.local, and the blob leak that got us there.
//   npm test
//
// "It breaks in long sessions" has a storage half. The Chrome manifest asks for `storage` and not
// `unlimitedStorage`, so storage.local is capped at 10 MB — and against the real constants in
// lib/images.ts one full-size attachment costs about 1.53 MB of it (MAX_BYTES is 1.2 MB decoded,
// base64 is 4/3 of that). Six attachments in a whole profile is the entire quota.
//
// Two separate failures made that break silently rather than loudly:
//   1. Every save is `.catch(() => {})`, so a write refused for want of room said nothing at all.
//   2. pruneBlobs existed in lib/blobs.ts and NOTHING EVER CALLED IT, so an image whose transcript
//      row was rewritten stayed in the store for the life of the chat.

import assert from 'node:assert/strict';
import test from 'node:test';
import { collectBlobs, pruneBlobs, referencedHashes, type BlobStore } from '../lib/blobs.ts';
import { blobsKey, MAX_BYTES } from '../lib/images.ts';
import { QUOTA_BYTES, WARN_AT, isQuotaError, quotaWarningNote, shouldWarn, trySet } from '../lib/quota.ts';
import type { ChatItem } from '../lib/types.ts';

// ---------------------------------------------------------------------------
// The measurement that makes this a bug rather than a theory
// ---------------------------------------------------------------------------

test('one full-size attachment is a sixth of the entire storage quota', () => {
  // The number that makes the rest of this file worth having. If MAX_BYTES or the quota ever
  // changes enough that this stops being true, the storage story needs rethinking, not patching.
  const onDisk = Math.ceil((MAX_BYTES * 4) / 3); // base64 inflation, as stored
  assert.ok(onDisk > 1.5 * 1024 * 1024, `an attachment costs ${(onDisk / 1024 / 1024).toFixed(2)} MB`);
  const attachmentsUntilFull = Math.floor(QUOTA_BYTES / onDisk);
  assert.ok(attachmentsUntilFull <= 7, `only ${attachmentsUntilFull} attachments fit in the whole quota`);
});

// ---------------------------------------------------------------------------
// Recognising a quota failure
// ---------------------------------------------------------------------------

test('every browser\'s way of saying "out of room" is recognised', () => {
  assert.equal(isQuotaError(new Error('QUOTA_BYTES quota exceeded')), true, 'Chrome');
  assert.equal(isQuotaError(new Error('QUOTA_BYTES_PER_ITEM quota exceeded')), true, 'Chrome, one key');
  assert.equal(isQuotaError(new Error('Resource::kQuotaBytes quota exceeded')), true, 'Chrome, newer');
  assert.equal(isQuotaError(Object.assign(new Error('x'), { name: 'QuotaExceededError' })), true, 'the spec spelling');
  assert.equal(isQuotaError(new Error('exceeded the storage quota')), true, 'Safari');
});

test('a failure that is not about room is not reported as one', () => {
  // Telling the user to delete chats when the real problem is something else wastes their time and
  // hides the actual fault.
  assert.equal(isQuotaError(new Error('Extension context invalidated')), false);
  assert.equal(isQuotaError(new Error('No storage access')), false);
  assert.equal(isQuotaError(null), false);
  assert.equal(isQuotaError(undefined), false);
});

test('trySet reports a quota failure instead of throwing it', async () => {
  // Saves must not throw: losing the reply because the record could not be written is worse than
  // losing the record. The point of this wrapper is that the failure becomes SAYABLE, not fatal.
  const g = globalThis as { chrome?: unknown };
  const before = g.chrome;
  try {
    g.chrome = { storage: { local: { async set() { throw new Error('QUOTA_BYTES quota exceeded'); } } } };
    assert.equal(await trySet({ k: 1 }), 'quota');

    g.chrome = { storage: { local: { async set() { throw new Error('something else'); } } } };
    assert.equal(await trySet({ k: 1 }), 'error');

    g.chrome = { storage: { local: { async set() {} } } };
    assert.equal(await trySet({ k: 1 }), 'ok');
  } finally {
    g.chrome = before;
  }
});

// ---------------------------------------------------------------------------
// Warning before the wall rather than at it
// ---------------------------------------------------------------------------

test('the warning fires with room still left, and never on an unavailable measurement', () => {
  assert.equal(shouldWarn(QUOTA_BYTES * WARN_AT), true);
  assert.equal(shouldWarn(QUOTA_BYTES * (WARN_AT - 0.01)), false);
  // getBytesInUse is not implemented everywhere. Unavailable must not read as "empty" — nor as
  // "full", which would warn every user on that browser on every turn.
  assert.equal(shouldWarn(null), false);
});

test('the warning names a percentage the user can act on', () => {
  const note = quotaWarningNote(QUOTA_BYTES * 0.9);
  assert.match(note, /90% full/);
  assert.match(note, /dashboard/, 'it has to say where to go');
  // It must never claim 100% while writes are still working — that reads as "already broken".
  assert.match(quotaWarningNote(QUOTA_BYTES), /99% full/);
});

// ---------------------------------------------------------------------------
// The blob leak
// ---------------------------------------------------------------------------

const thumb = (hash: string) => ({ thumb: '', width: 1, height: 1, bytes: 1, hash });
const userItem = (id: string, hashes: string[]): ChatItem =>
  ({ kind: 'user', id, text: 'look at this', images: hashes.map(thumb) }) as unknown as ChatItem;
const blob = (bytes: number) => ({ mediaType: 'image/jpeg' as const, data: 'x'.repeat(bytes), width: 1, height: 1, bytes });

function storageWith(initial: Record<string, unknown>) {
  const data: Record<string, unknown> = { ...initial };
  const g = globalThis as { chrome?: unknown };
  const before = g.chrome;
  g.chrome = {
    storage: {
      local: {
        async get(key: string | string[]) {
          const out: Record<string, unknown> = {};
          for (const k of Array.isArray(key) ? key : [key]) if (k in data) out[k] = data[k];
          return out;
        },
        async set(items: Record<string, unknown>) {
          Object.assign(data, items);
        },
        async remove(key: string | string[]) {
          for (const k of Array.isArray(key) ? key : [key]) delete data[k];
        },
      },
    },
  };
  return { data, restore: () => { g.chrome = before; } };
}

test('referencedHashes finds every hash a transcript still mentions', () => {
  const items = [userItem('u1', ['a', 'b']), { kind: 'assistant', id: 'a1', text: 'ok' } as unknown as ChatItem, userItem('u2', ['c'])];
  assert.deepEqual(referencedHashes(items).sort(), ['a', 'b', 'c']);
  assert.deepEqual(referencedHashes([]), []);
});

test('collectBlobs drops the images no transcript row refers to any more', async () => {
  // THE LEAK. A transcript rewritten without a row — compaction, an unqueued message, a rollback —
  // leaves its image in the store forever. pruneBlobs was written to fix exactly this and was
  // never wired to anything.
  const store: BlobStore = { keep: blob(100), orphan: blob(5000), alsoOrphan: blob(3000) };
  const s = storageWith({ [blobsKey('c1')]: store });
  try {
    const freed = await collectBlobs('c1', [userItem('u1', ['keep'])]);
    assert.equal(freed, 8000, 'the bytes freed should be reported, so a caller can log or warn');
    const after = s.data[blobsKey('c1')] as BlobStore;
    assert.deepEqual(Object.keys(after), ['keep']);
  } finally {
    s.restore();
  }
});

test('a chat whose every image is orphaned loses the whole key, not an empty object', async () => {
  const s = storageWith({ [blobsKey('c1')]: { gone: blob(100) } });
  try {
    await collectBlobs('c1', []);
    assert.equal(blobsKey('c1') in s.data, false, 'an empty blob store should not be left behind');
  } finally {
    s.restore();
  }
});

test('collectBlobs writes nothing when every image is still referenced', async () => {
  // It runs after every turn, so the common case has to be free.
  const store: BlobStore = { a: blob(10), b: blob(10) };
  const s = storageWith({ [blobsKey('c1')]: store });
  try {
    const freed = await collectBlobs('c1', [userItem('u1', ['a', 'b'])]);
    assert.equal(freed, 0);
    assert.equal(s.data[blobsKey('c1')], store, 'nothing was rewritten');
  } finally {
    s.restore();
  }
});

test('collectBlobs never throws, whatever storage does', async () => {
  // It is fire-and-forget after a turn. A cleanup that could not run must not take the turn with it.
  const g = globalThis as { chrome?: unknown };
  const before = g.chrome;
  try {
    g.chrome = { storage: { local: { async get() { throw new Error('gone'); } } } };
    assert.equal(await collectBlobs('c1', []), 0);
  } finally {
    g.chrome = before;
  }
});

test('pruneBlobs keeps exactly what it is told to', () => {
  const store: BlobStore = { a: blob(1), b: blob(1), c: blob(1) };
  assert.deepEqual(Object.keys(pruneBlobs(store, ['a', 'c'])).sort(), ['a', 'c']);
  assert.deepEqual(Object.keys(pruneBlobs(store, [])), []);
  // A hash the transcript mentions but the store never had must not invent an entry.
  assert.deepEqual(Object.keys(pruneBlobs(store, ['a', 'nope'])), ['a']);
});
