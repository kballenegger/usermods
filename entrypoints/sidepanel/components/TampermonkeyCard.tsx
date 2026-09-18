import { useRef, useState } from 'react';
import { rpc } from '@/lib/rpc';
import type { Mod } from '@/lib/types';

/**
 * Migration from Tampermonkey. Chrome extensions cannot read each other's storage, so the only
 * route is the backup file Tampermonkey's Utilities tab writes.
 *
 * Lives here rather than inside ModsView because the dashboard offers the same migration, and two
 * copies of these instructions would drift the moment Tampermonkey moves a menu item.
 */
export function TampermonkeyCard({
  onImported,
  onError,
  defaultOpen = false,
}: {
  onImported: (r: { imported: number; skipped: string[]; mods: Mod[] }) => void;
  onError: (e: unknown) => void;
  /** The dashboard has the room to show this expanded; the side panel does not. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onFile(file: File) {
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b;
      const r = isZip
        ? await rpc({ type: 'mods.importBackup', zipBase64: toBase64(bytes) })
        : await rpc({ type: 'mods.importBackup', json: new TextDecoder().decode(bytes) });
      onImported(r);
      setOpen(defaultOpen);
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  }

  return (
    <div className="card" style={{ marginBottom: 10 }}>
      <div className="row">
        <h4 className="grow">Migrate from Tampermonkey</h4>
        <button className="btn" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Show'}</button>
      </div>
      {open && (
        <>
          <div className="desc">Extensions cannot read each other's storage, so bring your scripts over with Tampermonkey's own export file.</div>
          <ol className="steps">
            <li>Open the Tampermonkey dashboard (its toolbar icon → Dashboard).</li>
            <li>Go to the <b>Utilities</b> tab.</li>
            <li>Under <b>File</b>, click <b>Export</b> to save the backup (.zip or .json).</li>
            <li>Pick that file here. Scripts, their on/off state and their stored values come across.</li>
          </ol>
          <input
            ref={inputRef}
            type="file"
            accept=".json,.zip,.txt,application/json,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void onFile(f);
            }}
          />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? 'Importing…' : 'Choose backup file'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
