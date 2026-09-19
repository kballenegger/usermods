import { useState } from 'react';
import { currentVersion, lineCount, toSource, type Artifact } from '@/lib/artifact';
import { exportFilename } from '@/lib/dashboard';
import { toolRowTitle } from '@/lib/transcript';
import type { ChatItem } from '@/lib/types';

/**
 * A stored chat transcript, rendered read-only.
 *
 * The side panel's transcript is not reused as a component: it is not one. Chat.tsx renders its
 * rows inline inside the live view, wired to the agent port — every row carries buttons that act on
 * the current tab (Try now, Save & enable) and state that only exists while a run is in flight
 * (queued, streaming). Lifting that out would mean either dragging the port into this page or
 * gutting the panel's transcript into something that takes a dozen optional callbacks.
 *
 * So this is a faithful re-render of the same ChatItem union with the interactive parts removed:
 * the same shapes and the same class names for user, assistant, tool, proposal, note and error
 * rows, minus every button.
 *
 * lib/transcript.ts is the other half and is not duplicated here: it reduces agent EVENTS into a
 * ChatItem[], which is exactly the array this renders. Nothing in it renders anything, so there is
 * no shared renderer to import — this page reads items that reducer already wrote to storage.
 */
export function TranscriptPreview({ items, artifact }: { items: ChatItem[]; artifact?: Artifact | null }) {
  if (!items.length && !artifact) {
    return <div className="prev-note">This chat has no stored transcript.</div>;
  }
  return (
    <div className="preview">
      {/* What the chat produced, above what it said. A reader opening an old chat almost always
          wants the script rather than the conversation that arrived at it, and the transcript is
          the long thing they would otherwise scroll through to reach it. Read-only here: editing
          a draft is the side panel's job, and editing the SAVED mod is the Mods tab's. */}
      {artifact && <ArtifactPreview artifact={artifact} />}
      {!items.length && <div className="prev-note">This chat has no stored transcript.</div>}
      {items.map((it, i) => {
        switch (it.kind) {
          case 'user':
            return (
              <div key={i} className="msg user">
                {it.text}
                {it.refs && it.refs.length > 0 && (
                  <div className="row" style={{ marginTop: 4 }}>
                    {it.refs.map((r) => (
                      <span key={r.token} className="chip" title={r.selector}>
                        @{r.token} → {r.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          case 'assistant':
            return (
              <div key={i} className="msg assistant">
                {it.text}
              </div>
            );
          case 'note':
            return (
              <div key={i} className="prev-note">
                {it.text}
              </div>
            );
          case 'tool':
            return (
              <details key={i} className={`prev-tool${it.isError ? ' is-error' : ''}`}>
                <summary>
                  {toolRowTitle(it.name, it.input)}
                  {it.isError ? ' · failed' : ''}
                </summary>
                {typeof it.input.code === 'string' && <pre>{it.input.code}</pre>}
                {it.summary && <pre>{it.summary}</pre>}
              </details>
            );
          case 'proposal':
            return (
              <div key={i} className="prev-proposal">
                <h4>{it.proposal.name}</h4>
                {it.proposal.description && <div className="muted">{it.proposal.description}</div>}
                <div className="row">
                  {it.proposal.matches.map((m) => (
                    <span key={m} className="chip">
                      {m}
                    </span>
                  ))}
                  {it.saved && <span className="badge">saved</span>}
                </div>
                <details>
                  <summary className="muted">Show code</summary>
                  <pre>{it.proposal.code}</pre>
                </details>
              </div>
            );
          case 'error':
            return (
              <div key={i} className="error">
                {it.text}
              </div>
            );
        }
      })}
    </div>
  );
}

/**
 * The chat's draft mod at the top of its preview: the current code, the version strip, and the same
 * Export the side panel offers. The strip is selectable — reading v1 of a draft that is now at v4 is
 * exactly the sort of thing this page is for — but nothing here writes: no rollback, no rename, no
 * save. Those all belong to the chat that owns the draft, which is a click away via Open.
 */
function ArtifactPreview({ artifact }: { artifact: Artifact }) {
  const current = currentVersion(artifact);
  const [selected, setSelected] = useState<number | null>(null);
  const shown = artifact.versions.find((v) => v.n === selected) ?? current;
  if (!current || !shown) return null;
  return (
    <div className="prev-artifact" data-testid="preview-artifact" data-version={current.n}>
      <div className="prev-artifact-head">
        <span className="badge">draft</span>
        <strong>{current.name}</strong>
        <span className="muted">
          v{current.n} · {lineCount(current.code)} lines
        </span>
        <span className="row" style={{ flex: 1 }} />
        <button
          className="pill"
          onClick={() => download(new Blob([toSource(artifact)], { type: 'text/javascript' }), exportFilename(artifact.name))}
          data-testid="preview-artifact-export"
        >
          Export
        </button>
      </div>
      {current.description && <div className="muted">{current.description}</div>}
      <div className="row">
        {current.matches.map((m) => (
          <span key={m} className="chip">
            {m}
          </span>
        ))}
      </div>
      <div className="prev-artifact-versions">
        {artifact.versions.map((v) => (
          <button
            key={v.n}
            className={`prev-vchip${v.n === current.n ? ' is-current' : ''}${v.n === shown.n ? ' is-shown' : ''}`}
            onClick={() => setSelected(v.n)}
            title={new Date(v.createdAt).toLocaleString()}
            data-testid="preview-artifact-version"
            data-v={v.n}
          >
            v{v.n}
          </button>
        ))}
      </div>
      <pre data-testid="preview-artifact-code">{shown.code}</pre>
    </div>
  );
}

function download(blob: Blob, filename: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** The transcript as plain text, for searching a chat's message bodies. */
export function transcriptText(items: ChatItem[]): string {
  const parts: string[] = [];
  for (const it of items) {
    switch (it.kind) {
      case 'user':
      case 'assistant':
      case 'note':
      case 'error':
        parts.push(it.text);
        break;
      case 'tool':
        parts.push(it.name, it.summary ?? '');
        break;
      case 'proposal':
        parts.push(it.proposal.name, it.proposal.description, it.proposal.code);
        break;
    }
  }
  return parts.join('\n');
}
