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
export function TranscriptPreview({ items }: { items: ChatItem[] }) {
  if (!items.length) {
    return <div className="prev-note">This chat has no stored transcript.</div>;
  }
  return (
    <div className="preview">
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
                  {it.name}
                  {typeof it.input.description === 'string'
                    ? `: ${it.input.description}`
                    : typeof it.input.selector === 'string'
                      ? ` ${it.input.selector}`
                      : ''}
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
