import { useEffect, useState } from 'react';
import type { Answer, PageCard, Question, StepRow, ToolEffect } from '@/lib/agent/questions';
import { rpc } from '@/lib/rpc';
import './operate.css';

// Everything the panel draws for a run that operates the page: the questions, the touched rows, the
// card and the Settings section. See docs/specs/browser-use.md, sections 5.4, 5.5 and 5.7.
//
// A build with ACT_OFF has neither this code nor its styles: there, wxt.config.ts resolves this file to
// operate-off.ts.

/** The pointer mark: a touched row's, in place of the dot. `currentColor`, so it takes the row's state. */
export function PointerMark() {
  return (
    <svg className="pointer-mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" shapeRendering="crispEdges">
      <path fill="currentColor" d="M3 1h2v1h1v1h1v1h1v1h1v1h1v1h1v1h1v2H9v1h1v2H8v-2H7v-1H6v1H5v1H3z" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// The questions
// ---------------------------------------------------------------------------

export interface QuestionRowProps {
  question: Question;
  onAnswer: (a: Answer) => void;
  onStop: () => void;
}

/**
 * The question up on this chat: a row of the chat column, above the activity line, one at a time.
 * The heading, the lines about what is going on and the buttons are the extension's; the model's words
 * appear only where they are labelled as the model's, or as what it is asking you to do.
 */
export function QuestionRow({ question: q, onAnswer, onStop }: QuestionRowProps) {
  const [standing, setStanding] = useState(false);
  // A new question starts unticked: the answer to the last site is not the answer to this one.
  useEffect(() => setStanding(false), [q.id]);
  const base = { 'data-testid': 'question', 'data-question': q.kind } as const;
  const notAgain = (host: string) => (
    <label className="question-check">
      <input type="checkbox" data-testid="question-standing" checked={standing} onChange={(e) => setStanding(e.target.checked)} />
      Do not ask again on {host}
    </label>
  );
  const allow = (every = false) => onAnswer({ kind: 'allow', ...(every ? { every } : {}), ...(standing ? { standing } : {}) });
  switch (q.kind) {
    case 'operate':
      return (
        <div {...base} className="question ask" role="group" aria-label={`Let usermods operate ${q.host}?`}>
          <div className="question-head">Let usermods operate {q.host}?</div>
          <p>
            It will click and type on this site, in this tab, while you watch. It asks before anything it can tell sends, buys, deletes or unsubscribes, and never types a password, a code or a
            card number. A page can contain text written to mislead the model. Stop is always here.
          </p>
          {notAgain(q.host)}
          <div className="question-actions">
            <button className="btn primary" data-action="question-allow" onClick={() => allow()}>
              Allow
            </button>
            <button className="linklike" data-action="question-decline" onClick={() => onAnswer({ kind: 'decline' })}>
              Not now
            </button>
          </div>
        </div>
      );
    case 'allow':
      return (
        <div {...base} className="question warn" role="group" aria-label="Allow this?">
          <div className="question-head">Allow this?</div>
          <p className="question-headline" data-testid="question-headline">
            {q.headline}
          </p>
          {q.where && <p className="question-where">{q.where}</p>}
          {q.modelSays && <p data-testid="question-model">the model says: {q.modelSays}</p>}
          {q.firstOnSite && <p>usermods has not operated {q.host} in this chat yet.</p>}
          {q.firstOnSite && notAgain(q.host)}
          <div className="question-actions">
            <button className="btn primary" data-action="question-allow" onClick={() => allow()}>
              Allow
            </button>
            {q.every && (
              <button className="btn" data-action="question-every" onClick={() => allow(true)}>
                {q.every.label}
              </button>
            )}
            <button className="linklike" data-action="question-decline" onClick={() => onAnswer({ kind: 'decline' })}>
              Decline
            </button>
          </div>
        </div>
      );
    case 'script':
      return (
        <div {...base} className="question warn" role="group" aria-label="Run this script?">
          <div className="question-head">Run this script?</div>
          {q.description && <p>the model says: {q.description}</p>}
          <details className="question-code">
            <summary>▼ code</summary>
            <pre>{q.code}</pre>
          </details>
          <div className="question-actions">
            <button className="btn primary" data-action="question-allow" onClick={() => onAnswer({ kind: 'allow' })}>
              Run
            </button>
            <button className="linklike" data-action="question-decline" onClick={() => onAnswer({ kind: 'decline' })}>
              Decline
            </button>
          </div>
        </div>
      );
    case 'handoff':
      return (
        <div {...base} className="question warn" role="group" aria-label="Your turn">
          <div className="question-head">Your turn</div>
          <p data-testid="question-model">{q.text}</p>
          {q.until && <p>It continues by itself when it sees {q.until}.</p>}
          <div className="question-actions">
            <button className="btn primary" data-action="question-done" onClick={() => onAnswer({ kind: 'done' })}>
              I have done it
            </button>
            <button className="linklike" data-action="question-stop" onClick={onStop}>
              Stop
            </button>
          </div>
        </div>
      );
    case 'left-site':
      return (
        <div {...base} className="question warn" role="group" aria-label={`The page left ${q.from}`}>
          <div className="question-head">The page left {q.from}</div>
          <p>It is now on {q.to}. usermods stays on the site it started on.</p>
          <div className="question-actions">
            <button className="btn primary" data-action="question-back" onClick={() => onAnswer({ kind: 'back' })}>
              Go back
            </button>
            {q.canContinue && (
              <button className="btn" data-action="question-continue" onClick={() => onAnswer({ kind: 'continue' })}>
                Continue on {q.to}
              </button>
            )}
            <button className="linklike" data-action="question-stop" onClick={onStop}>
              Stop
            </button>
          </div>
        </div>
      );
    case 'bar-removed':
      return (
        <div {...base} className="question warn" role="group" aria-label="The page removed usermods’ bar">
          <div className="question-head">The page removed usermods’ bar</div>
          <p>This page took away the bar that shows usermods is working and lets you stop it. Stop is still here.</p>
          <div className="question-actions">
            <button className="btn primary" data-action="question-allow" onClick={() => onAnswer({ kind: 'allow' })}>
              Carry on
            </button>
            <button className="linklike" data-action="question-stop" onClick={onStop}>
              Stop
            </button>
          </div>
        </div>
      );
  }
}

// ---------------------------------------------------------------------------
// Touched rows
// ---------------------------------------------------------------------------

/** One step of an `act` call: the mark, the rail and a sentence, opening to what it was read as. */
function TouchedStep({ step, interrupted }: { step: StepRow; interrupted: boolean }) {
  const state = step.state === 'running' && interrupted ? 'failed' : step.state;
  const text = step.state === 'running' && interrupted ? `${step.text} · interrupted before it finished` : step.text;
  const d = step.detail;
  return (
    <details className={`tool touched is-${state}`} data-testid="touched" data-step-state={state}>
      <summary>
        <PointerMark />
        <span>{text}</span>
      </summary>
      {d?.modelSays && <p className="touched-detail">the model says: {d.modelSays}</p>}
      {d?.read && <p className="touched-detail">read on the page: {d.read}</p>}
      {d?.result && <pre>{d.result}</pre>}
    </details>
  );
}

/** Every step of one `act` call, each its own row. Finished calls cannot have one still running. */
export function TouchedSteps({ steps, finished }: { steps: StepRow[]; finished: boolean }) {
  return (
    <>
      {steps.map((step, i) => (
        <TouchedStep key={i} step={step} interrupted={finished} />
      ))}
    </>
  );
}

/** A script or a test that changed the page. Whether it did is decided from its result. */
export function TouchedScript({ effect, code, summary, isError }: { effect: ToolEffect; code?: string; summary?: string; isError?: boolean }) {
  return (
    <details className={`tool touched${isError ? ' is-failed' : ''}`} data-testid="touched" data-step-state={isError ? 'failed' : 'done'}>
      <summary>
        <PointerMark />
        <span>{effect.text}</span>
      </summary>
      {code && <pre>{code}</pre>}
      {summary && <pre>{summary}</pre>}
    </details>
  );
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** What the extension recorded of the run. It never says done: done is the model's claim. */
export function PageCardRow({ card }: { card: PageCard }) {
  return (
    <div className="card page-card" data-testid="page-card">
      <div className="label">{card.label}</div>
      <div className="page-card-line">{card.where}</div>
      <div className="page-card-line" data-testid="page-card-counts">
        {card.counts}
      </div>
      <details>
        <summary>▼ actions</summary>
        <ol className="page-card-list">
          {card.actions.map((a, i) => (
            <li key={i}>{a}</li>
          ))}
        </ol>
        <p className="page-card-line">usermods records what it did, not whether it worked.</p>
        {card.scripted && <p className="page-card-line">A script can do things usermods does not see.</p>}
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Settings' section: the sites it may operate without asking first, and the slow, safe switch. */
export function OperatingPages({ askEveryStep, onAskEveryStep }: { askEveryStep: boolean; onAskEveryStep: (on: boolean) => void }) {
  const [sites, setSites] = useState<string[] | null>(null);
  useEffect(() => {
    void rpc({ type: 'act.allowances' }).then((r) => setSites(r.sites), () => setSites([]));
  }, []);
  const remove = (host: string) => void rpc({ type: 'act.allowance-remove', host }).then((r) => setSites(r.sites), () => {});
  return (
    <div className="operating-pages" data-testid="settings-operating">
      <div className="operating-heading">
        Operating pages
        <span>Sites usermods may operate without asking first</span>
      </div>
      {sites && !sites.length && (
        <p className="operating-empty" data-testid="operating-none">
          none · usermods asks the first time in each chat
        </p>
      )}
      {sites && sites.length > 0 && (
        <ul className="operating-list" data-testid="operating-sites">
          {sites.map((host) => (
            <li key={host}>
              <span className="operating-host">{host}</span>
              <button type="button" className="linklike" data-action="operating-remove" aria-label={`Remove ${host}`} onClick={() => remove(host)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="field">
        <span className="toggle" style={{ marginBottom: 'var(--sp-1)' }}>
          <input type="checkbox" checked={askEveryStep} data-testid="setting-ask-every-step" onChange={(e) => onAskEveryStep(e.target.checked)} />
          Ask before every step
        </span>
        <span>Every click, every field and every script waits for you. Slow, and the safest setting for a model you do not trust.</span>
      </label>
    </div>
  );
}
