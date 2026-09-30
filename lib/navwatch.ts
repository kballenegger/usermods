// Did the document a run_script is running in actually go away?
//
// awaitRunResult (entrypoints/background.ts) watches chrome.tabs.onUpdated so that a result lost
// to a navigation is reported as that, promptly, instead of as a 20-second timeout. It used to
// treat every status 'loading' as the document going away. Chrome fires 'loading' for a
// history.pushState, replaceState or hash change too, where the document, the script and its
// report all live on: on a single-page app a run that clicked a router link was told its result
// was lost although the script finished normally.
//
// The tab's URL cannot tell the two apart (a pushState changes it too), and without the
// webNavigation permission there is no event that says "same document". What does tell them apart
// is the document itself: performance.timeOrigin is fixed for a document's lifetime, a new
// document gets a new one, and any extension world can read it. So the background reads it once
// when the run starts and again on each 'loading'. Same value: a same-document navigation, keep
// waiting for the report. Different, or unreadable (the tab is on a page scripts cannot reach, or
// is gone): a real navigation, report it.
//
// In Chrome, 'loading' for a cross-document navigation arrives when the new document has already
// committed (seen in a real browser, for links, location.href, form posts, tabs.update and reload),
// so the first check is decisive. tabs.onUpdated's timing is not specified, though, and Safari's
// may differ: if 'loading' ever comes while the old document still answers, the tab is still
// loading, and the check is repeated until the tab settles, so a navigation that commits later is
// still caught within one interval. If the start value could not be read at all, nothing can be
// compared and 'loading' ends the wait as it always did, which is no worse than before.
//
// The start read has to land in the document the run starts in. The caller waits for `ready`
// before injecting (a few milliseconds in Chrome), so a script whose first statement navigates
// cannot win that race and have its new document read as the start.
//
// Pure, with its browser calls passed in, so test/navwatch.test.ts drives it with no browser.

/** How often a document that still answers is re-read while its tab reports it is loading. */
export const RECHECK_MS = 250;

export interface NavWatchDeps {
  /** The identity of the tab's top document now, or null when it cannot be read. */
  docToken(): Promise<string | null>;
  /** The tab's status now ('loading' | 'complete'), or undefined when the tab is gone. */
  tabStatus(): Promise<string | undefined>;
  /** setTimeout, returning its cancel. */
  schedule(fn: () => void, ms: number): () => void;
}

export type DocVerdict = 'same-document' | 'navigated';

/**
 * The decision, on its own: a document that cannot be compared is treated as gone, because that is
 * what 'loading' always meant here, and reporting a real navigation late is the failure this whole
 * watch exists to prevent.
 */
export function judgeDocument(start: string | null, now: string | null): DocVerdict {
  if (start === null || now === null) return 'navigated';
  return start === now ? 'same-document' : 'navigated';
}

export interface NavWatch {
  /**
   * Settles once the starting document has been read (or found unreadable). A caller that injects
   * the run only after this cannot have the start read land in a document the run itself navigated
   * to, which would make that navigation look like the same document and cost a full timeout.
   */
  ready: Promise<void>;
  /** Feed every tabs.onUpdated event for the watched tab. */
  onUpdated(change: { status?: string; url?: string }, tabUrl?: string): void;
  /** Stop checking; the run is over. */
  stop(): void;
}

/**
 * Start watching. `onNavigated` is called at most once, with the URL the tab reported. The start
 * token is read immediately, which is before the run is injected when the caller starts this first.
 */
export function watchDocument(deps: NavWatchDeps, onNavigated: (url: string) => void): NavWatch {
  const start = deps.docToken().catch(() => null);
  let stopped = false;
  let checking = false;
  let again = false;
  let cancelRecheck: (() => void) | null = null;
  let url = '';

  const check = async (): Promise<void> => {
    if (stopped) return;
    // One read in flight at a time; an event that lands meanwhile asks for one more afterwards,
    // since it may be the commit the first read came too early for.
    if (checking) {
      again = true;
      return;
    }
    checking = true;
    cancelRecheck?.();
    cancelRecheck = null;
    try {
      const verdict = judgeDocument(await start, await deps.docToken().catch(() => null));
      if (stopped) return;
      if (verdict === 'navigated') {
        stopped = true;
        onNavigated(url || 'a new page');
        return;
      }
      // Still the same document. If the tab says it is still loading, the navigation may not have
      // committed yet, so look again shortly; once it settles, a same-document navigation is done.
      const status = await deps.tabStatus().catch(() => undefined);
      if (stopped) return;
      if (status === undefined) {
        stopped = true;
        onNavigated('a closed tab');
      } else if (status === 'loading' && !again) {
        cancelRecheck = deps.schedule(() => void check(), RECHECK_MS);
      }
    } finally {
      checking = false;
      if (again && !stopped) {
        again = false;
        void check();
      }
    }
  };

  return {
    ready: start.then(() => undefined),
    onUpdated(change, tabUrl) {
      if (stopped || change.status !== 'loading') return;
      url = change.url ?? tabUrl ?? url;
      void check();
    },
    stop() {
      stopped = true;
      cancelRecheck?.();
      cancelRecheck = null;
    },
  };
}
