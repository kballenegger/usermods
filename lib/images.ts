// Attached images: the policy, kept pure so it is testable in node.
//
// The user can paste, drop or pick an image in the composer. Everything about what we accept, how
// far we shrink it, what it may weigh and how it is addressed in storage lives here; the actual
// decoding and re-encoding is in entrypoints/sidepanel/images.ts, because it needs a browser.
//
// Nothing here touches chrome.* or the DOM, so `npm test` can exercise the rules that decide
// whether a user's screenshot is accepted, and at what size it reaches the model.

/** The media types the composer accepts. SVG is deliberately absent: see `refuseReason`. */
export const ACCEPTED_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

export type AcceptedMediaType = (typeof ACCEPTED_MEDIA_TYPES)[number];

/** What an <input type="file"> should offer, and what a drop is filtered by. */
export const ACCEPT_ATTR = ACCEPTED_MEDIA_TYPES.join(',');

/**
 * The media types that leave the panel, after re-encoding. A provider sees only these two: the
 * processing step re-encodes everything to JPEG, or to PNG when the image has transparency, so a
 * WebP or GIF the user attached never reaches a backend that might not accept it.
 */
export type OutputMediaType = 'image/png' | 'image/jpeg';

/**
 * Longest edge we send. 1568px is the point past which the big vision models downscale anyway
 * (Anthropic states it outright, OpenAI's high-detail tiling saturates around the same place), so
 * anything larger costs bytes and tokens and buys nothing.
 */
export const MAX_EDGE = 1568;

/** Longest edge of the thumbnail stored in the transcript, which is what the panel renders. */
export const THUMB_EDGE = 320;

/** JPEG quality for the full-size copy. High enough that UI text in a screenshot stays readable. */
export const JPEG_QUALITY = 0.85;

/** JPEG quality for the thumbnail, which is only ever seen at ~150px. */
export const THUMB_QUALITY = 0.72;

/**
 * The most one processed image may weigh, in bytes of decoded data (base64 is ~4/3 of this on the
 * wire). A 1568px JPEG at q0.85 is normally 200-500 KB; 1.2 MB is generous headroom for a dense
 * screenshot and still small enough that four of them do not blow the storage quota or the request.
 */
export const MAX_BYTES = 1_200_000;

/** PNG is kept (rather than re-encoded to JPEG) only when the image has alpha AND is under this. */
export const PNG_KEEP_MAX_BYTES = 400_000;

/** How many images one message may carry. */
export const MAX_IMAGES_PER_MESSAGE = 4;

/**
 * One attached image, as it travels from the composer to the model.
 *
 * `data` is base64 without a data-URL prefix, matching the `image` Part the providers already
 * speak. `width`/`height` are the PROCESSED dimensions, so the panel can lay a thumbnail out
 * without decoding and the model can be told what it is looking at.
 */
export interface AttachedImage {
  mediaType: OutputMediaType;
  /** Base64, no `data:` prefix. */
  data: string;
  width: number;
  height: number;
  /** Decoded byte length of `data`. */
  bytes: number;
  /** The file's own name, when it had one (a pasted screenshot usually does not). */
  name?: string;
}

/**
 * The small copy that lives in the transcript, plus the hash that finds the full-size original in
 * the chat's blob store. Stored in chrome.storage.local as part of a ChatItem, so it must stay
 * small: a 320px JPEG is 10-25 KB, which is the whole reason the full copy lives elsewhere.
 */
export interface ImageThumb {
  /** Data URL, ready for an <img src>. */
  thumb: string;
  /** Dimensions of the FULL image, not of the thumbnail: this is what the size label reports. */
  width: number;
  height: number;
  bytes: number;
  name?: string;
  /** Content hash of the full-size image, i.e. its key in `chat:<id>:blobs`. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------

/** Is this a media type we will process? */
export function isAcceptedType(type: string | undefined | null): type is AcceptedMediaType {
  return !!type && (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(type.toLowerCase().split(';')[0]!.trim());
}

/**
 * Why we will not take this file, or null when we will.
 *
 * SVG is refused on purpose, and not because it is hard to rasterize. An SVG is a document: it can
 * carry script, external references and text that reads like an instruction, and the whole point of
 * an attachment is that it goes to the model as a picture. Rasterizing one here would mean either
 * running it (no) or shipping a renderer (no), so it is refused with a note rather than half-handled.
 */
export function refuseReason(file: { type?: string; name?: string }): string | null {
  const type = (file.type ?? '').toLowerCase().split(';')[0]!.trim();
  const name = file.name ?? 'that file';
  if (type === 'image/svg+xml' || /\.svgz?$/i.test(name)) {
    return `SVG is not supported — paste or drop a PNG, JPEG, WebP or GIF instead.`;
  }
  if (isAcceptedType(type)) return null;
  if (type.startsWith('image/')) return `${type} images are not supported — use PNG, JPEG, WebP or GIF.`;
  return `Only images can be attached (PNG, JPEG, WebP or GIF).`;
}

/**
 * How many more images this message may take, and the note to show when that is none.
 *
 * The cap is on the message, not the chat: four images is already more than any "make it look like
 * this" needs, and every one of them is resent on every model call for the rest of the turn.
 */
export function capNote(current: number, incoming: number): string | null {
  if (current >= MAX_IMAGES_PER_MESSAGE) {
    return `You can attach ${MAX_IMAGES_PER_MESSAGE} images per message. Send this one first, or remove one.`;
  }
  if (current + incoming > MAX_IMAGES_PER_MESSAGE) {
    const room = MAX_IMAGES_PER_MESSAGE - current;
    return `Only ${room} more image${room === 1 ? ' fits' : 's fit'} in this message — the rest were skipped.`;
  }
  return null;
}

/** The note shown when a processed image is still over MAX_BYTES after downscaling. */
export function tooLargeNote(name: string | undefined, bytes: number): string {
  return `${name ?? 'That image'} is ${formatBytes(bytes)} after shrinking, over the ${formatBytes(MAX_BYTES)} limit. Crop it or save it smaller.`;
}

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

/**
 * The size to draw at: the same aspect ratio, with the longest edge at most `maxEdge`. An image
 * already inside the box is left exactly as it is — upscaling a small screenshot would cost bytes
 * and invent detail that is not there.
 */
export function fitWithin(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** "1.2 MB", "340 KB", "812 bytes". One decimal for MB, whole numbers below. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1000) return `${Math.round(bytes / 1000)} KB`;
  return `${Math.max(0, Math.round(bytes))} bytes`;
}

/** The chip label under a thumbnail: "1568×980 · 240 KB". */
export function sizeLabel(img: { width: number; height: number; bytes: number }): string {
  return `${img.width}×${img.height} · ${formatBytes(img.bytes)}`;
}

// ---------------------------------------------------------------------------
// The model's view
// ---------------------------------------------------------------------------

/**
 * The one-line note that rides with each image in the user message.
 *
 * Without it an image is an anonymous blob in the middle of a conversation: the model can see it
 * but cannot refer to it, and "the second screenshot" means nothing. This gives each one an index,
 * its real dimensions and its filename when it had one, so both sides can talk about the same
 * picture. It is short on purpose — the picture is the content, this is the caption.
 */
export function imageNote(img: AttachedImage, index: number): string {
  const kind = img.mediaType === 'image/png' ? 'png' : 'jpeg';
  const name = img.name ? `, ${img.name}` : '';
  return `[attached image ${index + 1}: ${img.width}x${img.height} ${kind}${name}]`;
}

/** The stub that replaces an image once it is too old to keep resending. */
export function elidedImageNote(index: number): string {
  return `[attached image ${index + 1} elided]`;
}

/** Recognise our own stub, so eliding twice is a no-op. */
export const ELIDED_IMAGE_MARK = '[attached image ';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** Where a chat's full-size attachments live, beside its messages and items. */
export const blobsKey = (chatId: string) => `chat:${chatId}:blobs`;

/**
 * A content hash for one image, used as its key in the chat's blob store.
 *
 * FNV-1a over the base64 text, with the length mixed in. It is not a cryptographic hash and does
 * not need to be: the only thing it decides is whether two attachments in the same chat are the
 * same picture, and a collision would show the wrong thumbnail in a lightbox, not leak anything.
 * Synchronous and dependency-free, which crypto.subtle (async, browser-only) is not.
 */
export function imageHash(mediaType: string, data: string): string {
  let h = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  mix(mediaType);
  mix(' ');
  mix(data);
  // Length is mixed in last so two different-length strings that happen to fold to the same value
  // still part ways.
  return `${(h >>> 0).toString(36)}${data.length.toString(36)}`;
}

/** A stored blob: the full-size image, addressed by hash. */
export interface StoredBlob {
  mediaType: OutputMediaType;
  data: string;
  width: number;
  height: number;
  bytes: number;
}

/** A full-size attachment as a data URL, for the lightbox and for a provider that wants one. */
export function toDataUrl(img: { mediaType: string; data: string }): string {
  return `data:${img.mediaType};base64,${img.data}`;
}

/**
 * Split a data URL into its media type and base64 payload, or null when it is not one we take.
 * Used by the paste path, where a clipboard may hand over a data URL rather than a File.
 */
export function parseDataUrl(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+)(;[^,]*)?;base64,([\s\S]+)$/i.exec(url.trim());
  if (!m) return null;
  return { mediaType: m[1]!.toLowerCase(), data: m[3]!.replace(/\s+/g, '') };
}

/** Decoded byte length of a base64 string, without decoding it. */
export function base64Bytes(data: string): number {
  const clean = data.replace(/\s+/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * The text a message with images but no words sends instead.
 *
 * An empty send used to be refused outright, which is wrong here: dropping three mockups into the
 * panel and pressing Enter is a complete thought. The model still needs a sentence to answer, so
 * it gets the plainest true one.
 */
export function emptyTextFor(count: number): string {
  return `Attached ${count} image${count === 1 ? '' : 's'}`;
}
