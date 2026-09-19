// Turning a file the user dropped into something we can send.
//
// Everything here runs in the side panel, before anything leaves it: an attachment is decoded,
// downscaled, re-encoded and measured here, so what reaches the model endpoint is a picture we
// chose the size of rather than whatever came off the user's disk.
//
// Re-encoding is also how EXIF is stripped. A phone screenshot carries GPS coordinates, a device
// id and a timestamp in its metadata; drawing the decoded pixels onto a fresh canvas and encoding
// that keeps the image and drops everything around it. There is no EXIF-parsing step to get wrong,
// because no metadata survives the round trip.
//
// The policy (what is accepted, how large, how many) is lib/images.ts, which is pure and tested in
// node. This file is the browser half: createImageBitmap + OffscreenCanvas where they exist, a
// plain <canvas> and an <img> where they do not.

import {
  JPEG_QUALITY,
  MAX_BYTES,
  MAX_EDGE,
  PNG_KEEP_MAX_BYTES,
  THUMB_EDGE,
  THUMB_QUALITY,
  base64Bytes,
  fitWithin,
  isAcceptedType,
  refuseReason,
  tooLargeNote,
  type AttachedImage,
  type OutputMediaType,
} from '@/lib/images';

/** One processed attachment, plus the small copy the transcript keeps. */
export interface ProcessedImage {
  full: AttachedImage;
  /** A data URL at THUMB_EDGE, for the composer strip and the stored transcript. */
  thumb: string;
}

export type ProcessResult = { ok: true; image: ProcessedImage } | { ok: false; error: string };

/**
 * Decode, downscale, re-encode and measure one file.
 *
 * Never throws: a file that cannot be decoded is a note in the composer, not an exception in a
 * paste handler. The caller shows `error` inline and carries on with the other files.
 */
export async function processImageFile(file: File): Promise<ProcessResult> {
  const refusal = refuseReason(file);
  if (refusal) return { ok: false, error: refusal };

  let bitmap: Decoded;
  try {
    bitmap = await decode(file);
  } catch {
    return { ok: false, error: `${file.name || 'That image'} could not be read — it may be corrupt.` };
  }

  try {
    // Transparency decides the output format. A JPEG has no alpha channel, so a screenshot of a
    // rounded window corner or a transparent mockup would come back on a black box; a PNG keeps it
    // but is several times the size, which is why it is only kept while the image stays small.
    const transparent = await hasAlpha(bitmap, file.type);
    const target = fitWithin(bitmap.width, bitmap.height, MAX_EDGE);
    const preferPng = transparent && isAcceptedType(file.type) && file.size <= PNG_KEEP_MAX_BYTES;

    let encoded = await draw(bitmap, target, preferPng ? 'image/png' : 'image/jpeg', JPEG_QUALITY);
    // A PNG that turned out fat after all still goes out as a JPEG: the size limit wins over the
    // alpha channel, because an image we refuse helps nobody.
    if (encoded.mediaType === 'image/png' && encoded.bytes > MAX_BYTES) {
      encoded = await draw(bitmap, target, 'image/jpeg', JPEG_QUALITY);
    }
    if (encoded.bytes > MAX_BYTES) {
      close(bitmap);
      return { ok: false, error: tooLargeNote(file.name || undefined, encoded.bytes) };
    }

    const thumbTarget = fitWithin(bitmap.width, bitmap.height, THUMB_EDGE);
    const thumb = await draw(bitmap, thumbTarget, 'image/jpeg', THUMB_QUALITY);
    close(bitmap);

    return {
      ok: true,
      image: {
        full: {
          mediaType: encoded.mediaType,
          data: encoded.data,
          width: target.width,
          height: target.height,
          bytes: encoded.bytes,
          ...(file.name ? { name: file.name } : {}),
        },
        thumb: `data:${thumb.mediaType};base64,${thumb.data}`,
      },
    };
  } catch (e) {
    close(bitmap);
    return { ok: false, error: `${file.name || 'That image'} could not be processed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/** What we drew from: an ImageBitmap where the API exists, an <img> where it does not. */
type Decoded = { kind: 'bitmap'; bitmap: ImageBitmap; width: number; height: number } | { kind: 'element'; el: HTMLImageElement; width: number; height: number };

async function decode(file: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return { kind: 'bitmap', bitmap, width: bitmap.width, height: bitmap.height };
    } catch {
      // Fall through: some builds refuse animated or unusual files here but decode them as an <img>.
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const el = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('decode failed'));
      img.src = url;
    });
    return { kind: 'element', el, width: el.naturalWidth, height: el.naturalHeight };
  } finally {
    // Safe once the load has settled: the decoded image is retained by the element.
    URL.revokeObjectURL(url);
  }
}

function close(d: Decoded): void {
  if (d.kind === 'bitmap') d.bitmap.close?.();
}

function source(d: Decoded): CanvasImageSource {
  return d.kind === 'bitmap' ? d.bitmap : d.el;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

interface Encoded {
  mediaType: OutputMediaType;
  data: string;
  bytes: number;
}

/**
 * Draw the decoded image at `target` and encode it.
 *
 * JPEG gets a white background painted first. Without it a transparent source composites onto the
 * canvas's own transparent black and every soft edge turns into a dark halo — the classic "why is
 * my logo outlined in grey" artefact.
 */
async function draw(d: Decoded, target: { width: number; height: number }, mediaType: OutputMediaType, quality: number): Promise<Encoded> {
  const canvas = makeCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d') as (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null;
  if (!ctx) throw new Error('no 2d context');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (mediaType === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
  }
  ctx.drawImage(source(d), 0, 0, target.width, target.height);

  const blob = await toBlob(canvas, mediaType, quality);
  const data = await blobToBase64(blob);
  return { mediaType, data, bytes: base64Bytes(data) };
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas === 'function') return new OffscreenCanvas(width, height);
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  return el;
}

async function toBlob(canvas: AnyCanvas, type: OutputMediaType, quality: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality });
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), type, quality);
  });
}

/** Base64 without the `data:` prefix, which is the shape the `image` content Part carries. */
async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  // Chunked: String.fromCharCode(...buf) on a megabyte overflows the argument limit.
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  return btoa(binary);
}

/**
 * Does this image actually use its alpha channel?
 *
 * A PNG almost always HAS an alpha channel and almost never uses it — a screenshot saved as PNG is
 * fully opaque — so trusting the format would keep every screenshot as a 3 MB PNG. This samples the
 * decoded pixels at a small size: cheap, and wrong only for an image whose sole transparent region
 * is smaller than one sample cell, which then goes out as a JPEG on white and looks correct anyway.
 */
async function hasAlpha(d: Decoded, sourceType: string): Promise<boolean> {
  // JPEG cannot carry alpha at all, so there is nothing to sample.
  if (sourceType === 'image/jpeg') return false;
  const probe = fitWithin(d.width, d.height, 64);
  try {
    const canvas = makeCanvas(probe.width, probe.height);
    const ctx = canvas.getContext('2d') as (CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D) | null;
    if (!ctx) return false;
    ctx.drawImage(source(d), 0, 0, probe.width, probe.height);
    const { data } = ctx.getImageData(0, 0, probe.width, probe.height);
    for (let i = 3; i < data.length; i += 4) if (data[i]! < 250) return true;
    return false;
  } catch {
    return false; // a tainted canvas or a missing getImageData: treat it as opaque and send a JPEG
  }
}

// ---------------------------------------------------------------------------
// Getting files out of the events
// ---------------------------------------------------------------------------

/**
 * The image files in a paste or a drop, including the case that has no File at all.
 *
 * A clipboard from a screenshot tool hands over `items` with a File; a copy from a web page can
 * instead hand over `text/html` or a `text/uri-list` holding a data URL, which is still an image
 * the user meant to attach. Both are collected here so the two call sites do not each grow their
 * own idea of what counts.
 */
export function filesFromTransfer(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const add = (f: File | null) => {
    if (!f) return;
    const key = `${f.name}:${f.size}:${f.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };
  // `files` and `items` overlap; both are read because a paste populates one or the other
  // depending on the source, and the dedupe above makes reading both harmless.
  for (const f of Array.from(dt.files ?? [])) add(f);
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile());
  }
  return out;
}

/** Does this paste or drop carry anything that looks like a file at all? */
export function carriesFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  if ((dt.files?.length ?? 0) > 0) return true;
  return Array.from(dt.items ?? []).some((i) => i.kind === 'file');
}

/**
 * A data URL from a paste that carried no File, as a File we can process. Returns null when the
 * clipboard held no image data URL, which is the ordinary case for a text paste.
 */
export function fileFromDataUrlText(text: string): File | null {
  const trimmed = text.trim();
  if (!/^data:image\//i.test(trimmed)) return null;
  const match = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(trimmed);
  if (!match) return null;
  const mediaType = match[1]!.toLowerCase();
  try {
    const binary = atob(match[2]!.replace(/\s+/g, ''));
    const buf = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
    return new File([buf], 'pasted-image', { type: mediaType });
  } catch {
    return null;
  }
}
