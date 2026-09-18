import type { ScriptPreview } from '@/lib/types';

/**
 * What a userscript will do, shown before it is installed. Used by the full-tab install page that
 * .user.js links land on and by the side panel's inline install flow.
 */
export function InstallPreview({
  preview,
  busy,
  error,
  onInstall,
  onCancel,
  installLabel = 'Install',
}: {
  preview: ScriptPreview;
  busy?: boolean;
  error?: string;
  onInstall: () => void;
  onCancel: () => void;
  installLabel?: string;
}) {
  const targets = [...preview.matches, ...preview.includeGlobs];
  return (
    <div className="card">
      <div className="row">
        <h4 className="grow">{preview.name}</h4>
        {preview.version && <span className="chip">v{preview.version}</span>}
        {preview.world === 'MAIN' && (
          <span className="chip warn" title="@grant none or unsafeWindow: this script runs in the page's own JavaScript context.">
            page world
          </span>
        )}
      </div>

      {preview.description && <div className="desc">{preview.description}</div>}

      {preview.downloadUrl && (
        <div className="muted break">
          From <code>{preview.downloadUrl}</code>
        </div>
      )}

      <div className="notice">Userscripts run with full access to the pages they match. Read the code before installing anything you did not write.</div>

      {preview.warnings.map((w) => (
        <div key={w} className="error">
          {w}
        </div>
      ))}

      <Section label={`Runs on (${targets.length})`}>
        {targets.length ? targets.map((m) => <span key={m} className="chip">{m}</span>) : <span className="muted">nothing — this script would never run</span>}
      </Section>

      {preview.grants.length > 0 && (
        <Section label="Permissions">
          {preview.grants.map((g) => (
            <span key={g} className="chip">{g}</span>
          ))}
        </Section>
      )}

      {preview.connect.length > 0 && (
        <Section label="Can request">
          {preview.connect.map((c) => (
            <span key={c} className="chip" title={c === '*' ? 'This script may request any host.' : `GM_xmlhttpRequest may reach ${c}`}>
              {c}
            </span>
          ))}
        </Section>
      )}

      {preview.requires.length > 0 && (
        <Section label={`Loads ${preview.requires.length} librar${preview.requires.length === 1 ? 'y' : 'ies'}`}>
          {preview.requires.map((u) => (
            <span key={u} className="chip">{u}</span>
          ))}
        </Section>
      )}

      {preview.resources.length > 0 && (
        <Section label="Resources">
          {preview.resources.map((r) => (
            <span key={r} className="chip">{r}</span>
          ))}
        </Section>
      )}

      <div className="muted">
        Runs at <code>{preview.runAt.replace('_', '-')}</code>
      </div>

      <details>
        <summary className="muted">Show full source ({Math.ceil(preview.source.length / 1024)} KB)</summary>
        <pre>{preview.source}</pre>
      </details>

      {error && <div className="error">{error}</div>}

      <div className="row">
        <button className="btn primary" disabled={busy} onClick={onInstall}>
          {busy ? 'Installing…' : installLabel}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="muted label">{label}</div>
      <div className="row">{children}</div>
    </div>
  );
}
