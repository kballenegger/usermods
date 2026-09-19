// The three places an attached image appears: the composer strip, a sent message, and full size.
//
// All three are here rather than inline in Chat.tsx because the same picture has to look like the
// same picture in all of them, and because the lightbox is the only part of the panel that puts
// anything over the transcript — one component owning that is easier to keep honest than three
// call sites each remembering to close on Escape.

import { useEffect, useState } from 'react';
import { getBlob } from '@/lib/blobs';
import { sizeLabel, toDataUrl, type ImageThumb } from '@/lib/images';

/** A pending attachment in the composer: the thumbnail to show and the size to label it with. */
export interface PendingImage {
  /** Stable key for React, and the handle the remove button passes back. */
  id: string;
  thumb: string;
  width: number;
  height: number;
  bytes: number;
  name?: string;
}

/**
 * The strip above the composer. It sits in the same row as the @element chips, because they are
 * the same idea — things attached to the message you are about to send — and splitting them into
 * two rows costs a line of a 420px panel for no gain.
 */
export function PendingStrip({ images, onRemove }: { images: PendingImage[]; onRemove: (id: string) => void }) {
  if (!images.length) return null;
  return (
    <div className="attach-strip" role="list" aria-label="Attached images">
      {images.map((img) => (
        <div key={img.id} className="attach" role="listitem">
          <img src={img.thumb} alt={img.name ? `Attached image ${img.name}` : 'Attached image'} />
          <span className="attach-size">{sizeLabel(img)}</span>
          <button className="attach-x" onClick={() => onRemove(img.id)} title={`Remove ${img.name ?? 'this image'}`} aria-label="Remove attached image">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

/**
 * The thumbnails inside a sent user bubble. Clicking one opens it full size.
 *
 * These render from the data URL stored in the transcript, so a reloaded panel shows them without
 * reading the blob store at all — which is the whole reason the transcript carries a small copy.
 */
export function SentImages({ images, onOpen }: { images: ImageThumb[]; onOpen?: (img: ImageThumb) => void }) {
  if (!images.length) return null;
  return (
    <div className="attach-strip sent">
      {images.map((img, i) => {
        const label = img.name ? `${img.name} · ${sizeLabel(img)}` : sizeLabel(img);
        // A button rather than a bare <img>: it is a control that opens something, so it has to be
        // reachable by keyboard and announce itself. Read-only callers pass no onOpen and get a
        // plain picture instead.
        if (!onOpen) {
          return (
            <span key={i} className="attach">
              <img src={img.thumb} alt={label} title={label} />
            </span>
          );
        }
        return (
          <button key={i} className="attach" onClick={() => onOpen(img)} title={`${label} — click to view full size`}>
            <img src={img.thumb} alt={label} />
          </button>
        );
      })}
    </div>
  );
}

/**
 * The full-size overlay. Escape closes it, so does clicking anywhere outside the picture.
 *
 * It loads the full image from the chat's blob store on open. When that read comes back empty —
 * an old transcript, a chat whose blobs were evicted, a write that hit the quota — it falls back
 * to the thumbnail rather than showing a broken frame, and says so.
 */
export function Lightbox({ chatId, image, onClose }: { chatId: string | null; image: ImageThumb; onClose: () => void }) {
  const [src, setSrc] = useState(image.thumb);
  const [full, setFull] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    // Capture, so the composer's own keydown handler never sees the Escape that closed this.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setSrc(image.thumb);
    setFull(false);
    if (!chatId || !image.hash) return;
    void getBlob(chatId, image.hash)
      .then((blob) => {
        if (!live || !blob) return;
        setSrc(toDataUrl(blob));
        setFull(true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [chatId, image.hash, image.thumb]);

  return (
    <div className="lightbox" role="dialog" aria-modal="true" aria-label="Attached image" onClick={onClose}>
      <img src={src} alt={image.name ?? 'Attached image'} onClick={(e) => e.stopPropagation()} />
      <div className="lightbox-bar">
        <span>
          {image.name ? `${image.name} · ` : ''}
          {sizeLabel(image)}
          {full ? '' : ' · preview only'}
        </span>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
