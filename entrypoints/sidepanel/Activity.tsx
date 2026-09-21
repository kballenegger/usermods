import { useEffect, useState } from 'react';
import { activityFor, TICK_MS, type ChatActivity, type Phase } from '@/lib/activity';
import './activity.css';

/**
 * The one live line that says what the run is doing, and — the point of it — whether it has stopped
 * doing anything. Everything about the wording lives in lib/activity.ts; this owns only the clock
 * and the markup.
 *
 * It renders nothing at all when the run is over, so it cannot leave an empty row behind. It is
 * mounted outside the scrolling message list (above the composer), so appearing and disappearing
 * never moves the transcript.
 *
 * It shows ONE chat: the visible one. Runs are keyed by chat and several can be in flight at once,
 * so the panel keeps a line per chat (lib/activity.ts) and hands this component the entry for the
 * chat on screen. Switching chats therefore swaps the line rather than carrying one chat's progress
 * over to another.
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
  /** The model request is being retried; the wait is counted down against this component's clock. */
  retry?: ChatActivity['retry'];
  onStop: () => void;
  onRetry: () => void;
  /**
   * Offer Stop for the whole run, not only once it has stalled. The panel has a Stop button beside
   * Send for as long as a run lasts, so its line only needs one when something looks wrong. The
   * compact shell (iPhone, iPad) has ONE button beside the message box, which is Queue the moment
   * there is something typed, and this line is then the only Stop on screen.
   */
  stopAlways?: boolean;
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
    retry: props.retry ? { ...props.retry, remainingMs: props.retry.until - now } : undefined,
  });
  if (!a) return null;
  const action = a.action ?? (props.stopAlways ? 'stop' : undefined);

  return (
    <div className={`activity${a.tone === 'live' ? '' : ` ${a.tone}`}`} role="status" aria-live="polite">
      {/* The design system's own dot, so a running line reads like a running tool row. */}
      <span className="dot" aria-hidden="true" />
      {/* A wait reads "waiting for .result": prose first, identifier second. Everything else leads
          with the identifier ("find_elements #login"), so the order is a property of the line. */}
      {a.labelFirst && a.label && <span className="activity-label">{a.label}</span>}
      {a.mono && <span className="activity-mono activity-seg">{a.mono}</span>}
      {!a.labelFirst && a.mono && a.label && a.monoJoin === ' · ' && <span className="activity-sep">·</span>}
      {!a.labelFirst && a.label && <span className="activity-label">{a.label}</span>}
      {a.segments.map((s) => (
        <span key={s} style={{ display: 'contents' }}>
          <span className="activity-sep">·</span>
          <span className="activity-seg">{s}</span>
        </span>
      ))}
      {action === 'stop' && (
        <button className="activity-action" onClick={props.onStop}>
          Stop
        </button>
      )}
      {action === 'retry' && (
        <button className="activity-action" onClick={props.onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
