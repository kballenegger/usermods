// Full-size attachments, stored once per chat.
//
// A chat has three storage keys already (index, messages, items); this is the fourth:
//   'chat:<id>:blobs' — { [hash]: StoredBlob }, the full-size image behind every thumbnail.
//
// Why separate. The transcript is read on every panel open and rewritten on every streamed delta,
// so a megabyte of base64 inside it would be re-serialized hundreds of times a turn. The thumbnail
// that lives in the transcript is 10-25 KB and renders instantly on reload; the full copy is read
// only when the user opens the lightbox, and is what the model was actually sent.
//
// Keyed by content hash, so attaching the same screenshot twice in one chat stores it once.
//
// Lifetime is the chat's: deleteChat, the bulk delete and the MAX_CHATS eviction all remove this
// key alongside the other two (lib/chats.ts), so an image cannot outlive the conversation it
// belonged to.

import { blobsKey, imageHash, type AttachedImage, type ImageThumb, type StoredBlob } from './images.ts';

export { blobsKey };

/** Every full-size attachment stored for one chat, by hash. */
export type BlobStore = Record<string, StoredBlob>;

export async function loadBlobs(chatId: string): Promise<BlobStore> {
  try {
    const r = await chrome.storage.local.get(blobsKey(chatId));
    const raw = r[blobsKey(chatId)] as BlobStore | undefined;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/**
 * Store the full-size images of one message and return the thumbnails the transcript keeps.
 *
 * Read-modify-write of a single key, which is safe here because a message is only ever composed in
 * one panel at a time — unlike the transcript, which a background run also writes.
 */
export async function putBlobs(chatId: string, images: AttachedImage[], thumbs: string[]): Promise<ImageThumb[]> {
  if (!images.length) return [];
  const store = await loadBlobs(chatId);
  const out: ImageThumb[] = [];
  images.forEach((img, i) => {
    const hash = imageHash(img.mediaType, img.data);
    store[hash] = { mediaType: img.mediaType, data: img.data, width: img.width, height: img.height, bytes: img.bytes };
    out.push({
      thumb: thumbs[i] ?? '',
      width: img.width,
      height: img.height,
      bytes: img.bytes,
      hash,
      ...(img.name ? { name: img.name } : {}),
    });
  });
  try {
    await chrome.storage.local.set({ [blobsKey(chatId)]: store });
  } catch {
    // Over quota, or storage unavailable. The thumbnails are still returned and still render; only
    // the lightbox's full-size view is lost, which is a better outcome than failing the send.
  }
  return out;
}

/** The full-size image behind a thumbnail, or null when it was never stored (or has been evicted). */
export async function getBlob(chatId: string, hash: string): Promise<StoredBlob | null> {
  const store = await loadBlobs(chatId);
  return store[hash] ?? null;
}

/**
 * Drop blobs no surviving thumbnail refers to.
 *
 * Called with the hashes a chat's transcript still mentions. Nothing calls it on a schedule: the
 * only way a hash is orphaned is a transcript that was rewritten without it, and the chat's whole
 * key is removed when the chat goes.
 */
export function pruneBlobs(store: BlobStore, keep: Iterable<string>): BlobStore {
  const wanted = new Set(keep);
  const out: BlobStore = {};
  for (const [hash, blob] of Object.entries(store)) if (wanted.has(hash)) out[hash] = blob;
  return out;
}
