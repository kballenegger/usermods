import { useEffect, useState } from 'react';
import { activityFor, TICK_MS, type Phase } from '@/lib/activity';
import './activity.css';

/**
 * The one live line that says what the run is doing, and — the point of it — whether it has stopped
 * doing anything. Everything about the wording lives in lib/activity.ts; this owns only the clock
 * and the markup.
 *
 * It renders nothing at all when the run is over, so it cannot leave an empty row behind. It is
 * mounted outside the scrolling message list (above the composer), so appearing and disappearing
 * never moves the transcript.
 */
export interface ActivityProps {
  /** What the background last said it was doing. 'idle' hides the line. */
  phase: Phase;
  tool?: string;
  detail?: string;
  iteration?: number;
  /** performance.now()-style timestamp of when the current run started. */
  startedAt: number | null;
  /** …and of the last event of any kind from the port. Silence here is what a stall is. */
  lastEventAt: number | null;
  /** Set once text has streamed in the current model phase: "waiting" has become "writing". */
  writing?: boolean;
  /** Messages the user sent that have not entered the conversation yet. */
  queued?: number;
  /** The port went away mid-run. */
  disconnected?: boolean;
  onStop: () => void;
  onRetry: () => void;
}

export function Activity(props: ActivityProps) {
  const { phase, startedAt, lastEventAt, disconnected } = props;
  const showing = disconnected || phase !== 'idle';

  // One interval while the line is up, so the elapsed timer ticks and the stall thresholds are
  // crossed even when the port has gone completely quiet — which is exactly the case that matters.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!showing) return;
    const id = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(id);
  }, [showing]);

  if (!showing) return null;

  const now = Date.now();
  const a = activityFor({
    phase,
    tool: props.tool,
    detail: props.detail,
    iteration: props.iteration,
    elapsed: startedAt == null ? 0 : now - startedAt,
    sinceLastEvent: lastEventAt == null ? 0 : now - lastEventAt,
    writing: props.writing,
    queued: props.queued,
    disconnected,
  });
  if (!a) return null;

  return (
    <div className={`activity${a.tone === 'live' ? '' : ` ${a.tone}`}`} role="status" aria-live="polite">
      <span className="activity-dot" aria-hidden="true" />
      {a.mono && <span className="activity-mono activity-seg">{a.mono}</span>}
      {a.mono && a.label && a.monoJoin === ' · ' && <span className="activity-sep">·</span>}
      {a.label && <span className="activity-label">{a.label}</span>}
      {a.segments.map((s) => (
        <span key={s} style={{ display: 'contents' }}>
          <span className="activity-sep">·</span>
          <span className="activity-seg">{s}</span>
        </span>
      ))}
      {a.action === 'stop' && (
        <button className="activity-action" onClick={props.onStop}>
          Stop
        </button>
      )}
      {a.action === 'retry' && (
        <button className="activity-action" onClick={props.onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
