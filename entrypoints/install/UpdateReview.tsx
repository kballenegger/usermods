// The update review screen: install.html?update=<modId>.
//
// The only place an installed mod's newer version gets installed, and only on "Install update".
// It shows the old and new version, what the new header lets the script do that the old one did
// not (lib/updates.ts powersDiff), the code diff, and — if the user asks — a safety review by their
// own chosen model. The review is advisory; the buttons are the user's.
import { useEffect, useMemo, useState } from 'react';
import { diffLines } from '@/lib/artifact';
import { rpc, type RpcResponse } from '@/lib/rpc';
import { powersDiff, type UpdateReview } from '@/lib/updates';
import '../sidepanel/artifact.css';

type Loaded = RpcResponse<'updates.get'>;

const VERDICT_CLASS: Record<UpdateReview['verdict'], string> = {
  'looks safe': 'chip',
  'review carefully': 'chip warn',
  'do not install': 'chip danger',
};

export function UpdateReviewPage({ modId }: { modId: string }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'install' | 'review' | 'skip'>('');
  const [done, setDone] = useState<'' | 'installed' | 'skipped'>('');
  const [review, setReview] = useState<UpdateReview | null>(null);
  const [reviewError, setReviewError] = useState('');

  useEffect(() => {
    rpc({ type: 'updates.get', modId })
      .then((d) => {
        setData(d);
        setReview(d.review);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [modId]);

  const powers = useMemo(() => (data?.update ? powersDiff(data.mod.source, data.update.source) : null), [data]);
  const hunks = useMemo(() => (data?.update ? diffLines(data.mod.source, data.update.source) : []), [data]);

  async function closeTab() {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id != null) await chrome.tabs.remove(tab.id);
  }

  async function install() {
    if (!data?.update) return;
    setBusy('install');
    setError('');
    try {
      await rpc({ type: 'updates.apply', modId, hash: data.update.hash });
      setDone('installed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy('');
  }

  async function skip() {
    if (!data?.update) return;
    setBusy('skip');
    try {
      await rpc({ type: 'updates.skip', modId, version: data.update.version });
      setDone('skipped');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy('');
  }

  async function ask() {
    if (!data?.update) return;
    setBusy('review');
    setReviewError('');
    try {
      setReview(await rpc({ type: 'updates.review', modId, hash: data.update.hash }));
    } catch (e) {
      setReviewError(e instanceof Error ? e.message : String(e));
    }
    setBusy('');
  }

  if (error && !data) return <div className="card"><div className="error">▲ {error}</div></div>;
  if (!data) return <div className="empty">loading…</div>;
  const { mod, update, reviewer } = data;

  if (done) {
    return (
      <div className="card hero" data-testid="update-done">
        <h4>{done === 'installed' ? `“${mod.name}” is updated to v${update?.version}` : `Skipped v${update?.version}`}</h4>
        <div className="desc">
          {done === 'installed'
            ? 'It runs from the next page load it matches. Its settings and stored values are kept.'
            : 'usermods will not offer this version again. A newer one will still be offered.'}
        </div>
        <div className="row">
          <button className="btn primary" onClick={() => void closeTab()}>Close tab</button>
        </div>
      </div>
    );
  }

  if (!update) {
    return (
      <div className="card" data-testid="update-none">
        <h4>{mod.name}</h4>
        <div className="desc">No update is waiting for this mod{mod.version ? ` (v${mod.version} is installed)` : ''}.</div>
        <div className="row"><button className="btn" onClick={() => void closeTab()}>Close tab</button></div>
      </div>
    );
  }

  return (
    <>
      <div className="card">
        <div className="row">
          <h4 className="grow" data-testid="update-title">{mod.name}</h4>
          <span className="chip" data-testid="update-versions">v{mod.version || '?'} → v{update.version}</span>
        </div>
        <div className="label">from</div>
        <div className="muted break mono">{update.url}</div>
        <div className="notice">Nothing has changed yet. The installed version keeps running until you press Install update.</div>
      </div>

      <div className="card" data-testid="update-powers">
        <div className="label">What changed in its powers</div>
        {powers?.notes.length ? (
          <ul className="update-notes">
            {powers.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : (
          <div className="desc">Nothing about what it may do changed: the same sites, permissions, network hosts and libraries.</div>
        )}
      </div>

      {(review || reviewError || busy === 'review') && (
        <div className="card" data-testid="update-review">
          <div className="row">
            <div className="label grow">Safety review</div>
            {review && <span className={VERDICT_CLASS[review.verdict]} data-testid="update-verdict">{review.verdict}</span>}
          </div>
          {busy === 'review' && <div className="muted">Asking {reviewer.ok ? reviewer.model : 'the model'}…</div>}
          {reviewError && <div className="error">▲ {reviewError}</div>}
          {review && (
            <>
              <div className="desc" data-testid="update-review-summary">{review.summary}</div>
              {review.findings.length > 0 && (
                <ul className="update-findings" data-testid="update-findings">
                  {review.findings.map((f, i) => (
                    <li key={i}>
                      <span className={f.severity === 'high' ? 'chip danger' : f.severity === 'medium' ? 'chip warn' : 'chip'}>{f.severity}</span> <b>{f.what}</b>
                      {f.where && <span className="mono muted"> · {f.where}</span>}
                      {f.why && <div className="muted">{f.why}</div>}
                    </li>
                  ))}
                </ul>
              )}
              <div className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
                Advisory only: {review.model ?? 'the model'} read the two versions and can be wrong in either direction. You decide.
              </div>
            </>
          )}
        </div>
      )}

      {error && <div className="card"><div className="error">▲ {error}</div></div>}

      <div className="card">
        <div className="row update-actions">
          <button className="btn primary" disabled={!!busy} onClick={() => void install()} data-testid="update-install">
            {busy === 'install' ? 'Installing…' : 'Install update'}
          </button>
          <button className="btn" disabled={!!busy} onClick={() => void closeTab()} data-testid="update-not-now">Not now</button>
          <button className="btn" disabled={!!busy} onClick={() => void skip()} data-testid="update-skip">Skip this version</button>
          <button
            className="btn"
            disabled={!!busy || !reviewer.ok || !!review}
            onClick={() => void ask()}
            data-testid="update-ask-agent"
            title={reviewer.ok ? `Sends only the installed and the new source, and the header changes above, to ${reviewer.model}.` : reviewer.reason}
          >
            {review ? 'Reviewed' : 'Check with the agent first'}
          </button>
        </div>
        {!reviewer.ok && (
          <div className="muted" style={{ fontSize: 'var(--fs-meta)' }} data-testid="update-ask-disabled">
            The agent check needs a connected model: {reviewer.reason}
          </div>
        )}
        {reviewer.ok && !review && (
          <div className="muted" style={{ fontSize: 'var(--fs-meta)' }}>
            The agent check sends only the two versions of this script and the header changes to {reviewer.model}. Nothing from any page.
          </div>
        )}
      </div>

      <div className="card">
        <div className="label">Code changes</div>
        {hunks.length ? (
          <pre className="artifact-diff update-diff" data-testid="update-diff">
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
          <div className="desc">The text is the same apart from its version.</div>
        )}
      </div>
    </>
  );
}
