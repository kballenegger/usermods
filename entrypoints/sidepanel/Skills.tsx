import { useEffect, useMemo, useRef, useState } from 'react';
import { bulkTargets, editorSync, filterSkills, formatSize, skillFilenames, skillSource, timeLabel, toggleSelectAll, type ModFilter } from '@/lib/dashboard';
import { describeLeak, scanSkillForLeaks, type Leak } from '@/lib/leakscan';
import { rpc } from '@/lib/rpc';
import { prepareSkillShare } from '@/lib/share';
import type { ShareEvent } from '@/lib/sharecontroller';
import { FIRST_RUN_TEXT, SENDS_TEXT, makeItAnInput, previewSkill, skillFileName, skillHosts, skillMatchesUrl, type Skill, type SkillPreview } from '@/lib/skills';
import { copyText } from './components/ExportMenu';
import { MenuButton, type MenuItem } from './components/Menu';
import { openUpdateReview, type UpdateSummary } from './useUpdates';
import './skills.css';

/** Every skill, kept live: anything that changes one lands in the `skills` storage key. */
export function useSkillList(): Skill[] {
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    const read = () => void rpc({ type: 'skills.list' }).then(setSkills).catch(() => {});
    read();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && 'skills' in changes) read();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  return skills;
}

/** The Mods tab's two lists. */
export function skillsHere(skills: Skill[], pageUrl: string): { here: Skill[]; elsewhere: Skill[] } {
  const here = skills.filter((s) => pageUrl && skillMatchesUrl(s, pageUrl));
  return { here, elsewhere: skills.filter((s) => !here.includes(s)) };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

/**
 * What a skill will do, shown before it is installed: docs/specs/skills.md, section 4.3. Every line
 * above the author's notes is computed from the steps and the front matter (lib/skills.ts previewSkill).
 * A refused file shows why, line by line, and its Install stays off.
 */
export function SkillPreviewCard({
  preview,
  busy,
  error,
  onInstall,
  onCancel,
  installLabel = 'Install',
}: {
  preview: SkillPreview;
  busy?: boolean;
  error?: string;
  onInstall: () => void;
  onCancel: () => void;
  installLabel?: string;
}) {
  const p = preview;
  return (
    <div className="card" data-testid="skill-preview">
      <div className="row">
        <h4 className="grow" data-testid="skill-preview-name">{p.name}</h4>
        {p.version && <span className="chip">v{p.version}</span>}
        {p.namespace && <span className="chip">ns {p.namespace}</span>}
      </div>
      {p.description && <div className="desc">{p.description}</div>}
      {p.downloadUrl && (
        <div>
          <div className="label">source</div>
          <div className="muted break mono">{p.downloadUrl}</div>
        </div>
      )}

      {p.refusals.map((r, i) => (
        <div key={i} className="error" data-testid="skill-refusal">
          ▲ {r.line ? `Line ${r.line}: ` : ''}{r.message}
        </div>
      ))}
      {p.warnings.map((w, i) => (
        <div key={i} className="notice" data-testid="skill-warning">
          {w.message}
        </div>
      ))}

      {p.steps.length > 0 && (
        <>
          <dl className="skill-facts" data-testid="skill-facts">
            <dt>Runs on</dt>
            <dd data-testid="skill-runs-on">
              <div>{p.hosts.join(', ')}{p.subdomains ? ' (and subdomains)' : ''}</div>
              <div className="muted">starts at {p.startsAt}</div>
            </dd>
            <dt>What it does</dt>
            <dd data-testid="skill-does">{p.summary}</dd>
            <dt className={p.asks.length ? 'warn' : undefined}>{p.asks.length ? '▲ Asks you' : 'Asks you'}</dt>
            <dd data-testid="skill-asks">
              {p.asks.length === 0 && <div>nothing it can tell</div>}
              {p.asks.map((a) => (
                <div key={a.n}>step {a.n} {a.reasons.join(', ')}: {a.line}</div>
              ))}
              {p.asks.length > 0 && <div className="muted">usermods asks before {p.asks.length === 1 ? 'it' : 'these'}, every run, and before anything else it can tell is consequential.</div>}
              {p.yours.map((y) => (
                <div key={y.n}>step {y.n} is yours: “{y.text}”</div>
              ))}
            </dd>
            <dt>Types</dt>
            <dd data-testid="skill-types">
              {p.types.inputs.length === 0 && p.types.constants.length === 0 && <div>nothing</div>}
              {p.types.inputs.length > 0 && <div>{p.types.inputs.join(', ')} (your inputs)</div>}
              {p.types.constants.map((c) => (
                <div key={c.n}>step {c.n}: “{c.value}”, always, into {c.target}</div>
              ))}
            </dd>
            <dt>Reads</dt>
            <dd data-testid="skill-reads">
              {p.reads.length === 0 && <div>nothing</div>}
              {p.reads.map((r) => (
                <div key={r.n}>the {r.take} of <span className="mono">{r.from}</span> into “{r.into}”</div>
              ))}
            </dd>
            <dt>Sends</dt>
            <dd data-testid="skill-sends">{SENDS_TEXT}</dd>
            <dt>Inputs</dt>
            <dd data-testid="skill-inputs">{p.inputs.length ? p.inputs.map((i) => `${i.label}${i.optional ? ' (optional)' : ''}`).join(' · ') : 'none'}</dd>
            <dt>Your first run</dt>
            <dd>{FIRST_RUN_TEXT}</dd>
          </dl>
          <details open>
            <summary>▼ steps ({p.steps.length})</summary>
            <ol className="skill-steps" data-testid="skill-steps">
              {p.steps.map((s) => (
                <li key={s.n}>
                  {s.line}
                  {s.reasons.length > 0 && <span className="warn"> ▲ {s.reasons.join(', ')}</span>}
                </li>
              ))}
            </ol>
          </details>
          {p.prose && (
            <details>
              <summary>▼ the author’s notes</summary>
              <div className="skill-prose" data-testid="skill-notes">{p.prose}</div>
            </details>
          )}
        </>
      )}
      <details>
        <summary>▼ source · {Math.ceil(p.source.length / 1024)} KB</summary>
        <pre>{p.source}</pre>
      </details>

      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy || !p.ok} onClick={onInstall} data-testid="skill-install">
          {busy ? 'Installing…' : p.ok ? installLabel : 'Refused'}
        </button>
        <button className="btn" disabled={busy} onClick={onCancel} data-testid="skill-cancel">
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export and sharing
// ---------------------------------------------------------------------------

function downloadSkill(s: Skill): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([s.source], { type: 'text/markdown' }));
  a.download = skillFileName(s.name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

interface PendingShare {
  skill: Skill;
  leaks: Leak[];
  forceNew?: boolean;
}

/**
 * useModShare for a skill: Download, Copy, and a gist. There is no Greasy Fork item, because a file
 * that does nothing in Tampermonkey has no business there. The leak check runs first, and what it
 * finds in a typed value can be made an input right here, which rewrites the skill.
 */
export function useSkillShare({ onStatus, onError }: { onStatus: (s: string) => void; onError: (e: unknown) => void }) {
  const [pending, setPending] = useState<PendingShare | null>(null);
  const [link, setLink] = useState<{ name: string; url: string } | null>(null);
  const [missing, setMissing] = useState<Skill | null>(null);

  useEffect(() => {
    const onMessage = (msg: ShareEvent) => {
      if (msg?.type !== 'usermods:share-event' || !msg.skill) return;
      void rpc({ type: 'skills.list' }).then((skills) => {
        const s = skills.find((x) => x.id === msg.modId);
        const name = s?.name ?? 'your skill';
        if (msg.kind === 'recorded' && msg.rawUrl) {
          setLink({ name, url: msg.rawUrl });
          onStatus(`Shared “${name}” as a gist. Its install link is below.`);
        } else if (msg.kind === 'gist-missing') {
          if (s) setMissing(s);
        } else if (msg.kind === 'signin') {
          onStatus('Sign in on the GitHub tab; usermods fills the form in when it appears.');
        } else if (msg.kind === 'filled') {
          onStatus("Filled in. Press the site's own Create/Update gist button to save it.");
        } else if (msg.kind === 'fallback') {
          onStatus('usermods could not fill that page in. Paste the skill there (the page has a Copy button).');
        }
      });
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start(skill: Skill, forceNew = false) {
    const p = prepareSkillShare(skill, { forceNew });
    try {
      await rpc({
        type: 'share.start',
        share: { modId: skill.id, skill: true, target: 'gist', mode: p.mode, source: p.source, fileName: p.fileName, description: p.description, version: p.version, previousVersion: p.previousVersion, openUrl: p.openUrl },
      });
      onStatus(p.mode === 'update' ? `Opened the gist's editor with v${p.version}.` : 'Opened a new gist. usermods fills it in when it loads.');
    } catch (e) {
      onError(e);
    }
  }

  function begin(skill: Skill, forceNew = false) {
    setMissing(null);
    const leaks = scanSkillForLeaks(prepareSkillShare(skill, { forceNew }).source);
    if (leaks.length) {
      setPending({ skill, leaks, ...(forceNew ? { forceNew } : {}) });
      return;
    }
    void start(skill, forceNew);
  }

  /** Make it an input: the step and the declaration are rewritten, and the skill counts as edited. */
  async function makeInput(leak: Leak) {
    if (!pending || leak.step === undefined) return;
    const source = makeItAnInput(pending.skill.source, leak.step);
    if (!source) return;
    try {
      const skills = await rpc({ type: 'skills.save', id: pending.skill.id, source });
      const skill = skills.find((s) => s.id === pending.skill.id);
      if (skill) setPending({ ...pending, skill, leaks: scanSkillForLeaks(prepareSkillShare(skill, { forceNew: pending.forceNew ?? false }).source) });
    } catch (e) {
      onError(e);
    }
  }

  function items(s: Skill): MenuItem[] {
    return [
      { id: 'download', label: 'Download .skill.md', testId: 'export-download', onSelect: () => downloadSkill(s) },
      {
        id: 'copy',
        label: 'Copy to clipboard',
        testId: 'export-copy',
        onSelect: () => {
          copyText(s.source).then(() => onStatus(`Copied “${s.name}” to the clipboard.`), onError);
        },
      },
      { id: 'gist', label: s.share?.gist ? 'Update gist' : 'Share as Gist', testId: 'export-gist', onSelect: () => begin(s) },
    ];
  }

  const prompt = pending ? (
    <div className="card share-prompt" data-testid="skill-share-prompt" role="alertdialog" aria-label={`Before you share “${pending.skill.name}”`}>
      <h4>Before you share “{pending.skill.name}” on a gist</h4>
      {pending.leaks.length > 0 ? (
        <>
          <div className="error">▲ This skill looks like it contains something private:</div>
          <ul className="share-leaks" data-testid="skill-share-leaks">
            {pending.leaks.slice(0, 8).map((l, i) => (
              <li key={`${l.kind}:${l.line}:${i}`} className="mono">
                {describeLeak(l)}
                {l.kind === 'typed-value' && (
                  <>
                    {' '}
                    <button className="btn" onClick={() => void makeInput(l)} data-testid="skill-make-input">
                      Make it an input
                    </button>
                  </>
                )}
              </li>
            ))}
            {pending.leaks.length > 8 && <li className="muted">and {pending.leaks.length - 8} more</li>}
          </ul>
          <div className="desc muted">A secret gist is not listed anywhere, but anyone who has the link can read it. Remove it from the skill first unless you are sure.</div>
        </>
      ) : (
        <div className="desc">Nothing private is left in it.</div>
      )}
      <div className="row">
        <button
          className={pending.leaks.length ? 'btn danger' : 'btn primary'}
          onClick={() => {
            const p = pending;
            setPending(null);
            void start(p.skill, p.forceNew ?? false);
          }}
          data-testid="skill-share-anyway"
        >
          {pending.leaks.length ? 'Share anyway' : 'Continue'}
        </button>
        <button className="btn" onClick={() => setPending(null)} data-testid="skill-share-cancel">
          Cancel
        </button>
      </div>
    </div>
  ) : null;

  const notices = (
    <>
      {missing && (
        <div className="card" data-testid="skill-gist-missing">
          <div className="desc">The gist for “{missing.name}” no longer exists: it may have been deleted. Share it as a new gist?</div>
          <div className="row">
            <button className="btn primary" onClick={() => begin(missing, true)}>
              Share as a new gist
            </button>
            <button className="btn" onClick={() => setMissing(null)}>
              Not now
            </button>
          </div>
        </div>
      )}
      {link && (
        <div className="card" data-testid="skill-install-link">
          <div className="label">Your install link</div>
          <div className="desc">Anyone can install “{link.name}” from this link, and gets each new version you share:</div>
          <div className="mono break">{link.url}</div>
          <div className="row">
            <button className="btn" onClick={() => copyText(link.url).then(() => onStatus('Copied the install link.'), onError)}>
              Copy
            </button>
            <button className="btn" onClick={() => setLink(null)}>
              Done
            </button>
          </div>
        </div>
      )}
    </>
  );

  return { items, prompt, notices };
}

// ---------------------------------------------------------------------------
// The Mods tab's row
// ---------------------------------------------------------------------------

/** A skill in the Mods tab. Where a mod has its switch a skill will have Run, with the runner. */
export function SkillCard({
  skill,
  exportItems,
  onDelete,
  onUpdate,
  onCopyLink,
  updates,
}: {
  skill: Skill;
  exportItems: (s: Skill) => MenuItem[];
  onDelete: (name: string, id: string) => void;
  onUpdate: (name: string, id: string) => void;
  onCopyLink: (url: string) => void;
  updates: UpdateSummary;
}) {
  const upd = updates[skill.id];
  const inputs = Object.values(skill.inputs).map((i) => i.label);
  return (
    <div className="card" data-testid="skill-row" data-skill-id={skill.id}>
      <div className="row">
        <h4 className="grow">{skill.name}</h4>
        {skill.version && <span className="chip">v{skill.version}</span>}
      </div>
      {skill.description && <div className="desc">{skill.description}</div>}
      <div className="row">
        {skill.matches.map((m) => (
          <span key={m} className="chip">{m}</span>
        ))}
      </div>
      <div className="muted" style={{ fontSize: 'var(--fs-meta)' }} data-testid="skill-row-meta">
        {plural(skill.steps.length, 'step')}{inputs.length ? ` · asks for ${inputs.join(', ')}` : ''}
      </div>
      {upd?.available ? (
        <div className="mod-update-line" data-testid="skill-update-available">
          <button className="btn primary" onClick={() => openUpdateReview(skill.id)} aria-label={`Update available for “${skill.name}”: v${upd.available}. Review it`}>
            Update available v{upd.available}
          </button>
        </div>
      ) : upd?.error ? (
        <div className="mod-update-line muted" data-testid="skill-update-error" title={upd.error}>
          update check: {upd.error}
        </div>
      ) : null}
      {skill.share?.gist && (
        <div className="mod-share-link" data-testid="skill-row-link">
          <span className="label" style={{ margin: 0 }}>install link</span>
          <span className="mono" title={skill.share.gist.rawUrl}>{skill.share.gist.rawUrl}</span>
          <button className="btn" onClick={() => onCopyLink(skill.share!.gist!.rawUrl)} aria-label={`Copy the install link for “${skill.name}”`}>
            Copy
          </button>
        </div>
      )}
      <details>
        <summary>▼ file</summary>
        <pre>{skill.source}</pre>
      </details>
      <div className="row">
        <span className="grow" />
        <MenuButton label={`Export “${skill.name}”`} title="Download, copy, or share this skill" className="btn" testId="skill-export" items={exportItems(skill)} menuLabel={`Export “${skill.name}”`} placement="down">
          Export ▾
        </MenuButton>
        {skill.downloadUrl && (
          <button className="btn" onClick={() => onUpdate(skill.name, skill.id)} title="Check for a newer version now. Nothing installs until you review it." data-testid="skill-update">
            Update
          </button>
        )}
        <button className="btn danger" onClick={() => onDelete(skill.name, skill.id)} data-testid="skill-delete">
          Delete
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

/** The dashboard's skills: rows and their source editor, beside the mods' with the same filter. */
export function SkillsPanes({
  skills,
  filter,
  onStatus,
  onError,
}: {
  skills: Skill[];
  filter: ModFilter;
  onStatus: (s: string) => void;
  onError: (e: unknown) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openId, setOpenId] = useState<string | null>(null);
  const visible = useMemo(() => filterSkills(skills, filter), [skills, filter]);
  const selection = bulkTargets(selected, visible);
  const open = openId ? skills.find((s) => s.id === openId) : undefined;
  const share = useSkillShare({ onStatus, onError });
  const [updates, setUpdates] = useState<UpdateSummary>({});
  useEffect(() => {
    void rpc({ type: 'updates.summary' }).then(setUpdates).catch(() => {});
  }, [skills]);

  async function remove(ids: string[], what: string) {
    if (!ids.length || !confirm(`Delete ${what}? This cannot be undone.`)) return;
    try {
      await rpc({ type: 'skills.delete', ids });
      setSelected(new Set());
    } catch (e) {
      onError(e);
    }
  }

  async function exportZip() {
    const chosen = skills.filter((s) => selection.includes(s.id));
    if (!chosen.length) return;
    try {
      const { zipSync, strToU8 } = await import('fflate');
      const names = skillFilenames(chosen);
      const entries: Record<string, Uint8Array> = {};
      chosen.forEach((s, i) => {
        entries[names[i]!] = strToU8(s.source);
      });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([zipSync(entries) as unknown as BlobPart], { type: 'application/zip' }));
      a.download = 'usermods-skills.zip';
      a.click();
      URL.revokeObjectURL(a.href);
      onStatus(`Exported ${plural(chosen.length, 'skill')}.`);
    } catch (e) {
      onError(e);
    }
  }

  async function update(s: Skill) {
    try {
      const r = await rpc({ type: 'skills.update', id: s.id });
      if (r.available) {
        onStatus(`“${s.name}” v${r.available} is available. Review it in the tab that opened; nothing changes until you install it.`);
        openUpdateReview(s.id);
      } else onStatus(`“${s.name}” is up to date.`);
    } catch (e) {
      onError(e);
    }
  }

  if (!skills.length) return null;
  return (
    <div style={{ marginBottom: 22 }} data-testid="skills-section">
      <div className="dash-label" data-testid="skill-count">Skills · {visible.length} of {skills.length}</div>
      {selection.length > 0 && (
        <div className="bulkbar" data-testid="skill-bulkbar">
          <span>{selection.length} selected</span>
          <span className="sep">·</span>
          <button className="pill" onClick={() => void exportZip()}>Export zip</button>
          <button className="pill danger" onClick={() => void remove(selection, plural(selection.length, 'skill'))}>Delete</button>
          <span className="row" style={{ flex: 1 }} />
          <button className="pill" onClick={() => setSelected(toggleSelectAll(selected, visible))}>Select all</button>
          <button className="pill" onClick={() => setSelected(new Set())}>Clear</button>
        </div>
      )}
      {(share.prompt || share.notices) && <div className="dash-share">{share.prompt}{share.notices}</div>}
      <div className="panes">
        <div className="rows">
          {!visible.length && <div className="dash-empty">No skills match those filters.</div>}
          {visible.map((s) => {
            const t = timeLabel(s.updatedAt);
            const upd = updates[s.id];
            const inputs = Object.values(s.inputs).map((i) => i.label);
            return (
              <div
                key={s.id}
                className={`rowcard${openId === s.id ? ' selected' : ''}`}
                data-testid="skill-row"
                data-skill-id={s.id}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('button, input, a, label')) return;
                  setOpenId((prev) => (prev === s.id ? null : s.id));
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(s.id)}
                  aria-label={`Select ${s.name}`}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(s.id)) next.delete(s.id);
                      else next.add(s.id);
                      return next;
                    })
                  }
                  data-testid="skill-select"
                />
                <div className="body">
                  <div className="title" title={s.name}>
                    {s.name}
                    {s.version && <span className="badge" style={{ marginLeft: 6 }}>v{s.version}</span>}
                  </div>
                  <div className="meta" data-testid="skill-row-meta">
                    <span>{skillHosts(s).join(', ')}</span>
                    <span>·</span>
                    <span>{plural(s.steps.length, 'step')}</span>
                    {inputs.length > 0 && (
                      <>
                        <span>·</span>
                        <span>{inputs.join(', ')}</span>
                      </>
                    )}
                    <span>·</span>
                    <span>{skillSource(s)}</span>
                    <span>·</span>
                    <span>{s.walked ? 'walked' : 'first run pending'}</span>
                    <span>·</span>
                    <span title={t.absolute}>{t.relative}</span>
                  </div>
                </div>
                <div className="actions">
                  <MenuButton label={`Export “${s.name}”`} title="Download, copy, or share this skill" className="pill" testId="skill-export" items={share.items(s)} placement="down">
                    Export ▾
                  </MenuButton>
                  {upd?.available ? (
                    <button className="pill" onClick={() => openUpdateReview(s.id)} data-testid="skill-update-available" title="Review the new version; nothing installs until you say so">
                      Update available v{upd.available}
                    </button>
                  ) : (
                    s.downloadUrl && (
                      <button className="pill" onClick={() => void update(s)} data-testid="skill-update" title={upd?.error ? `Last check: ${upd.error}` : 'Check for a newer version now'}>
                        Update
                      </button>
                    )
                  )}
                  <button className="pill danger" onClick={() => void remove([s.id], `"${s.name}"`)} data-testid="skill-delete">
                    Delete
                  </button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="pane-detail">
          {open ? <SkillEditor key={open.id} skill={open} onStatus={onStatus} onError={onError} /> : <div className="dash-empty">Select a skill to see and edit its file.</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * The file in a textarea, with what the parser says about it as it is typed. A save goes through
 * skills.save, which parses it again and refuses what the preview refuses; a refused save leaves the
 * text in the box and the reason on screen. Dirtiness works as ModEditor's does, for the same reasons.
 */
function SkillEditor({ skill, onStatus, onError }: { skill: Skill; onStatus: (s: string) => void; onError: (e: unknown) => void }) {
  const [source, setSource] = useState(skill.source);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const seenRef = useRef(skill.source);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    const what = editorSync({ modSource: skill.source, seen: seenRef.current, dirty });
    if (what === 'none') return;
    if (what === 'adopt') {
      seenRef.current = skill.source;
      setSource(skill.source);
      setConflict(null);
      return;
    }
    setConflict(skill.source);
  }, [skill.source, dirty]);

  const preview = useMemo(() => previewSkill(source), [source]);
  const t = timeLabel(skill.updatedAt);

  async function save() {
    if (conflict !== null || !preview.ok) return;
    setBusy(true);
    try {
      await rpc({ type: 'skills.save', id: skill.id, source });
      seenRef.current = source;
      setDirty(false);
      onStatus(`Saved “${preview.name}”.`);
    } catch (e) {
      onError(e);
    }
    setBusy(false);
  }

  function take(next: string) {
    seenRef.current = next;
    setSource(next);
    setDirty(false);
    setConflict(null);
  }

  return (
    <div className="detail" data-testid="skill-editor">
      <h3 data-testid="skill-editor-name">{preview.name}</h3>
      <div className="detail-meta">
        {skillSource(skill)} · {t.absolute} · {formatSize(source.length)}
      </div>
      <dl className="kv">
        <dt>Runs on</dt>
        <dd>{preview.hosts.join(', ') || 'nothing'}</dd>
        <dt>What it does</dt>
        <dd>{preview.summary || 'nothing it can read'}</dd>
        {skill.downloadUrl && (
          <>
            <dt>Source</dt>
            <dd className="break">{skill.downloadUrl}</dd>
          </>
        )}
        {skill.share?.gist && (
          <>
            <dt>Gist</dt>
            <dd className="break" data-testid="skill-editor-gist">
              <a href={skill.share.gist.url} target="_blank" rel="noopener noreferrer">{skill.share.gist.url}</a>
              <br />
              install link: {skill.share.gist.rawUrl}
            </dd>
          </>
        )}
      </dl>
      {preview.refusals.map((r, i) => (
        <div key={i} className="error" data-testid="skill-editor-refusal">
          {r.line ? `Line ${r.line}: ` : ''}{r.message}
        </div>
      ))}
      {preview.warnings.map((w, i) => (
        <div key={i} className="notice" data-testid="skill-editor-warning">
          {w.line ? `Line ${w.line}: ` : ''}{w.message}
        </div>
      ))}
      {conflict !== null && (
        <div className="notice" data-testid="skill-editor-conflict">
          This skill changed elsewhere while you were editing it. Saving now would overwrite that change; loading it would drop your edits. Pick one.
          <div className="row" style={{ marginTop: 8 }}>
            <button className="pill" onClick={() => take(conflict)}>Load new version</button>
            <button
              className="pill"
              onClick={() => {
                seenRef.current = skill.source;
                setConflict(null);
              }}
            >
              Keep my edits
            </button>
          </div>
        </div>
      )}
      <textarea
        className="editor"
        value={source}
        spellCheck={false}
        data-testid="skill-editor-source"
        aria-label={`The file of ${preview.name}`}
        onChange={(e) => {
          setSource(e.target.value);
          setDirty(true);
        }}
      />
      <div className="editor-bar">
        <button className="pill primary" onClick={() => void save()} disabled={busy || !dirty || conflict !== null || !preview.ok} data-testid="skill-editor-save">
          {busy ? 'Saving…' : !preview.ok && dirty ? 'Fix what is refused first' : conflict !== null ? 'Choose a version first' : dirty ? 'Save' : 'Saved'}
        </button>
        <button className="pill" onClick={() => take(conflict ?? skill.source)} disabled={busy || (!dirty && conflict === null)}>
          Revert
        </button>
        <span className="muted">Saving by hand means its next run shows each step again.</span>
      </div>
    </div>
  );
}
