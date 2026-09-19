import { useEffect, useRef, useState } from 'react';
import { currentVersion, diffLines, lineCount, type Artifact } from '@/lib/artifact';
import './artifact.css';

/**
 * The chat's draft mod, pinned above the composer.
 *
 * The problem it solves is that a conversation produced a sequence of proposal cards and no answer
 * to "so what is the script right now?". The answer was wherever the last card happened to be, five
 * screens up, and telling it apart from the four cards above it meant reading all five. So: one
 * draft per chat, always in the same place, with its history behind a chevron.
 *
 * Collapsed it is one line — name, version, size and the three things you do with a draft — because
 * that is what it is most of the time, and a panel that ate a third of the transcript to say "v3"
 * would be worse than the scrolling it replaced. Expanded it shows the code, the version strip and
 * the diff.
 *
 * It sits in the chat column as its own row, like the activity line: `flex: none` between the
 * scrolling transcript and the composer. That is what keeps it from moving the transcript when it
 * appears — a draft arriving mid-run must not scroll the message you are reading out from under
 * you, and a panel inside `.messages` would do exactly that.
 */
export function ArtifactPanel({
  artifact,
  busy,
  canTry,
  selected,
  onSelect,
  onTry,
  onSave,
  onExport,
  onRename,
  onRollback,
  openDashboard,
}: {
  artifact: Artifact;
  /** A run is in flight in this chat: Save and Rollback would race the version it is writing. */
  busy: boolean;
  /** There is a tab to run against. */
  canTry: boolean;
  /** The version the strip has selected, which is the current one unless the user picked another. */
  selected: number;
  onSelect: (n: number) => void;
  onTry: () => void | Promise<void>;
  onSave: () => void | Promise<void>;
  onExport: () => void;
  onRename: (name: string) => void | Promise<void>;
  onRollback: (n: number) => void | Promise<void>;
  openDashboard: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  /** The draft name while it is being edited inline, or null when it is a heading again. */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);

  const current = currentVersion(artifact);
  // The strip's selection, defended against an artifact that changed underneath it (a rollback
  // appends, so the selected version always still exists — but a panel restored from storage can
  // hold a number this artifact never had).
  const shown = artifact.versions.find((v) => v.n === selected) ?? current;
  const isCurrent = !!shown && !!current && shown.n === current.n;
  const previous = shown ? artifact.versions.filter((v) => v.n < shown.n).pop() : undefined;
  const hunks = showDiff && shown && previous ? diffLines(previous.code, shown.code) : [];

  // Copy says so for a moment and then stops; a button that stays "Copied" is lying by the time
  // you look at it again.
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);

  if (!current || !shown) return null;

  const saveLabel = artifact.linkedModId ? 'Update mod' : 'Save';

  function commitRename() {
    const name = (renaming ?? '').trim();
    setRenaming(null);
    if (name && name !== current!.name) void onRename(name);
  }

  return (
    <div className={`artifact${open ? ' open' : ''}`} data-testid="artifact" data-version={current.n} data-versions={artifact.versions.length}>
      <div className="artifact-bar">
        {/* Identity and actions are separate groups so the buttons never shrink and the name is
            always the thing that gives up width. See artifact.css. */}
        <div className="artifact-ident">
          <button
            className="artifact-chevron"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            title={open ? 'Collapse the draft' : 'Show the draft, its versions and its diff'}
            data-testid="artifact-toggle"
          >
            {open ? '▾' : '▸'}
          </button>
          {/* Each separator is named for the thing it precedes, so hiding that thing at a
              breakpoint hides its separator with it. Positional selectors could not do this:
              nth-of-type counts spans, and every part of this bar is a span. */}
          <span className="artifact-kind">Draft</span>
          <span className="artifact-sep sep-name">·</span>
          <span className="artifact-name" title={current.name} data-testid="artifact-name">
            {current.name}
          </span>
          <span className="artifact-sep sep-v">·</span>
          <span className="artifact-v" data-testid="artifact-current">
            v{current.n}
          </span>
          <span className="artifact-sep sep-size">·</span>
          <span className="artifact-size">{lineCount(current.code)} lines</span>
        </div>
        <div className="artifact-actions">
          <button className="btn" onClick={() => void onTry()} disabled={!canTry} title="Run the current draft once on this page" data-testid="artifact-try">
            Try
          </button>
          <button
            className="btn primary"
            onClick={() => void onSave()}
            disabled={busy}
            title={artifact.linkedModId ? 'Write this version over the mod this chat created' : 'Save this draft as a mod and enable it'}
            data-testid="artifact-save"
          >
            {saveLabel}
          </button>
          {/* Export is the least-used of the three and the only one whose label can be a glyph
              without losing its meaning — a download arrow beside Try and Save reads as "get the
              file". Its accessible name and tooltip stay the full word. */}
          <button className="btn artifact-export" onClick={onExport} title="Download the current version as a .user.js file" aria-label="Export the draft as a .user.js file" data-testid="artifact-export">
            <span className="artifact-export-word">Export</span>
            <span className="artifact-export-glyph" aria-hidden="true">
              ↓
            </span>
          </button>
        </div>
      </div>

      {open && (
        <div className="artifact-body" data-testid="artifact-body">
          {/* The model could not run this one; the same caveat the proposal card carries. It lives
              in the body rather than under the bar, so the collapsed panel stays one line. */}
          {artifact.untestedReason && <div className="label untested artifact-untested">not tested on this page · {artifact.untestedReason}</div>}
          <div className="artifact-row">
            {renaming !== null ? (
              <input
                ref={renameRef}
                className="artifact-rename"
                value={renaming}
                autoFocus
                onChange={(e) => setRenaming(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    commitRename();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    setRenaming(null);
                  }
                }}
                onBlur={commitRename}
                aria-label="Draft name"
                data-testid="artifact-rename-input"
              />
            ) : (
              <button
                className="artifact-title"
                onClick={() => setRenaming(current.name)}
                title="Rename this draft. The new name becomes a version, so it can be rolled back like any other change."
                data-testid="artifact-rename"
              >
                {current.name}
              </button>
            )}
          </div>

          {current.description && <div className="artifact-desc">{current.description}</div>}

          <div className="row">
            {current.matches.map((m) => (
              <span key={m} className="chip">
                {m}
              </span>
            ))}
          </div>

          {/* The version strip. The current one is highlighted; selecting another shows it here
              read-only, which is how you look at v1 without leaving v3. */}
          <div className="artifact-versions" role="group" aria-label="Draft versions">
            {artifact.versions.map((v) => (
              <button
                key={v.n}
                className={`artifact-vchip${v.n === current.n ? ' is-current' : ''}${v.n === shown.n ? ' is-shown' : ''}`}
                onClick={() => onSelect(v.n)}
                title={`${versionWhy(v.source)} · ${new Date(v.createdAt).toLocaleString()}`}
                data-testid="artifact-version"
                data-v={v.n}
                data-current={v.n === current.n ? 'true' : 'false'}
              >
                v{v.n}
              </button>
            ))}
            <span className="grow" />
            <button
              className={`artifact-difftoggle${showDiff ? ' on' : ''}`}
              onClick={() => setShowDiff((d) => !d)}
              disabled={!previous}
              title={previous ? `Show what changed between v${previous.n} and v${shown.n}` : 'The first version has nothing to compare against'}
              data-testid="artifact-diff-toggle"
            >
              Diff
            </button>
          </div>

          {!isCurrent && (
            <div className="artifact-note" data-testid="artifact-viewing-old">
              Viewing v{shown.n}. The draft is v{current.n}.
              <button className="linklike" onClick={() => void onRollback(shown.n)} disabled={busy} data-testid="artifact-rollback">
                Roll back to this version
              </button>
            </div>
          )}

          {showDiff ? (
            previous ? (
              hunks.length ? (
                <pre className="artifact-diff" data-testid="artifact-diff">
                  {hunks.map((h, i) => (
                    <span key={i}>
                      <span className="d-hunk">{`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`}</span>
                      {'\n'}
                      {h.lines.map((l, j) => (
                        <span key={j} className={l.startsWith('+') ? 'd-add' : l.startsWith('-') ? 'd-del' : 'd-same'}>
                          {l}
                          {'\n'}
                        </span>
                      ))}
                    </span>
                  ))}
                </pre>
              ) : (
                <div className="artifact-note" data-testid="artifact-diff-empty">
                  v{shown.n} is identical to v{previous.n}.
                </div>
              )
            ) : null
          ) : (
            <pre className="artifact-code" data-testid="artifact-code">
              {shown.code}
            </pre>
          )}

          <div className="row artifact-foot">
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(shown.code).then(() => setCopied(true)).catch(() => {});
              }}
              data-testid="artifact-copy"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            {/* Editing code is the dashboard's job: it has the width, the header, the warnings and
                the dependency resolution. Duplicating a source editor into a 420px panel would be
                a worse one in a worse place. */}
            <button className="linklike" onClick={openDashboard} data-testid="artifact-edit-link">
              Edit in dashboard
            </button>
            {artifact.linkedModId && (
              <span className="muted artifact-linked" data-testid="artifact-linked">
                saved · updates in place
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** What a version's origin reads as in its tooltip. */
function versionWhy(source: Artifact['versions'][number]['source']): string {
  switch (source) {
    case 'proposal':
      return 'proposed by the model';
    case 'rollback':
      return 'rolled back to an earlier version';
    case 'user-edit':
      return 'edited by you';
  }
}
