// The browser's half of operating a page: chrome.tabs, content messages, storage, and the questions
// waiting in the panel. lib/agent/driver.ts is the logic and has none of these. The arrangement is
// lib/sharecontroller.ts's: the background hands in what it owns.
//
// Everything in this file is reached through `if (!ACT_OFF)` in entrypoints/background.ts, so a
// flag-off bundle holds none of it.

import type { ActResult, ActStep } from './interact/actions';
import type { TargetSpec } from './interact/target';
import { answerFits, type Answer, type Question } from './agent/questions';
import { allowAction, allowSite, allowancesFor, forgetChat, loadAllowances, removeSite, standingSites, updateAllowances } from './agent/allowances';
import { hostOf } from './agent/boundary';
import { Driver, type DescribeReply, type DriverDeps } from './agent/driver';
import { changeNote } from './agent/note';
import type { WaitOutcome, WaitSpec } from './agent/wait';
import { noteKey } from './chats';
import { withPending, withoutPending, type PendingStep, type RunMap } from './runstate';
import { loadSettings } from './settings';
import type { AgentEventBody, ContentRequest } from './types';

/** How long a navigation a step started gets, before the run carries on and looks for itself. */
const SETTLE_MS = 10_000;
/** The tab reads 'complete' until the navigation has got going. */
const SETTLE_START_MS = 150;
const SETTLE_POLL_MS = 100;

/** What the background owns and this file borrows. */
export interface DriveHost {
  /** With the content script's injection and one retry. For reads: never for a step. */
  sendToContent<T>(tabId: number, req: ContentRequest): Promise<T>;
  updateRuns(fn: (runs: RunMap) => RunMap): Promise<void>;
  post(chatId: string, e: AgentEventBody): void;
  waitInTab(tabId: number, spec: WaitSpec, signal: AbortSignal): Promise<WaitOutcome>;
}

export type DriveRpc = { type: 'act.answer'; chatId: string; questionId: string; answer: Answer } | { type: 'act.allowances' } | { type: 'act.allowance-remove'; host: string };

/** The question each chat's run is waiting on. One at a time, as the column shows them. */
interface Waiting {
  question: Question;
  tabId: number;
  answer: (a: Answer | null) => void;
}

function abortable(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface DriveController {
  /** The driver for one run. Call `end` when the run is over. */
  driverFor(chatId: string, tabId: number): Driver;
  end(chatId: string): void;
  rpc(req: DriveRpc): Promise<unknown>;
  /** What each chat is waiting on, for a panel that opens mid-run. */
  questions(): Record<string, Question>;
  /** "I have done it", from the bar on this tab. It ends a handoff and nothing else. */
  barDone(tabId: number): void;
  /** A page finished loading. A new document has lost the bar. */
  tabLoaded(tabId: number): void;
  /** Hide the bar for the instant of a capture, if this tab has one. */
  hidingBar<T>(tabId: number, capture: () => Promise<T>): Promise<T>;
  note(chatId: string): { read(): Promise<string>; change(input: Record<string, unknown>): Promise<ReturnType<typeof changeNote>> };
  forget(chatIds: string[]): Promise<void>;
}

export function createDriveController(host: DriveHost): DriveController {
  const waiting = new Map<string, Waiting>();
  const drivers = new Map<string, { driver: Driver; tabId: number }>();

  function ask(chatId: string, tabId: number, question: Question, signal: AbortSignal): Promise<Answer | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (a: Answer | null) => {
        if (waiting.get(chatId)?.question.id !== question.id) return;
        waiting.delete(chatId);
        signal.removeEventListener('abort', onAbort);
        host.post(chatId, { type: 'question_done', id: question.id });
        resolve(a);
      };
      const onAbort = () => finish(null);
      signal.addEventListener('abort', onAbort, { once: true });
      waiting.set(chatId, { question, tabId, answer: finish });
      host.post(chatId, { type: 'question', question });
    });
  }

  function whenActive(tabId: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        chrome.tabs.onActivated.removeListener(onActivated);
        chrome.tabs.onRemoved.removeListener(onRemoved);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      const onActivated = (info: { tabId: number }) => {
        if (info.tabId === tabId) finish();
      };
      const onRemoved = (id: number) => {
        if (id === tabId) finish();
      };
      chrome.tabs.onActivated.addListener(onActivated);
      chrome.tabs.onRemoved.addListener(onRemoved);
      signal.addEventListener('abort', finish, { once: true });
      // It may have come back while these were being added.
      void chrome.tabs.get(tabId).then((t) => t.active && finish()).catch(finish);
    });
  }

  /** Polled, because a page that finished before anyone asked sends no further event. */
  async function settled(tabId: number, signal: AbortSignal): Promise<void> {
    const end = Date.now() + SETTLE_MS;
    await abortable(signal, SETTLE_START_MS);
    while (!signal.aborted && Date.now() < end) {
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      if (!tab || tab.status === 'complete') return;
      await abortable(signal, SETTLE_POLL_MS);
    }
  }

  const allowances = (chatId: string) => ({
    async load(h: string) {
      return allowancesFor(await loadAllowances(), chatId, h);
    },
    async allowSite(h: string, standing: boolean) {
      await updateAllowances((s) => allowSite(s, chatId, h, standing));
    },
    async allowAction(h: string, key: string) {
      await updateAllowances((s) => allowAction(s, chatId, h, key));
    },
    async sites() {
      return (await loadAllowances()).chats[chatId]?.sites ?? [];
    },
  });

  function depsFor(chatId: string, tabId: number): DriverDeps {
    const held = allowances(chatId);
    return {
      describe: (step: ActStep) => host.sendToContent<DescribeReply>(tabId, { type: 'describe', step }),
      // chrome.tabs.sendMessage itself, and not host.sendToContent: that one injects and sends again
      // when a send fails, and a step whose answer was lost has probably happened.
      perform: (id: string, step: ActStep, expect: string) => chrome.tabs.sendMessage(tabId, { type: 'act', id, step, expect } satisfies ContentRequest) as Promise<ActResult>,
      cancel: (id: string) => void chrome.tabs.sendMessage(tabId, { type: 'act-cancel', id } satisfies ContentRequest).catch(() => {}),
      outline: async (target: TargetSpec | null) => {
        await host.sendToContent(tabId, target ? { type: 'highlight', target, mode: 'hold' } : { type: 'highlight', mode: 'clear' });
      },
      bar: async (state) => {
        const r = await host.sendToContent<{ up?: boolean } | undefined>(tabId, { type: 'indicator', state: { bar: state } });
        return { up: r?.up !== false };
      },
      raiseAgain: async (state) => {
        await host.sendToContent(tabId, { type: 'indicator', state: { bar: null } });
        const r = await host.sendToContent<{ up?: boolean } | undefined>(tabId, { type: 'indicator', state: { bar: state } });
        return { up: r?.up !== false };
      },
      ask: (q, signal) => ask(chatId, tabId, q, signal),
      pageUrl: async () => (await chrome.tabs.get(tabId)).url ?? '',
      tabActive: async () => (await chrome.tabs.get(tabId).catch(() => null))?.active !== false,
      whenActive: (signal) => whenActive(tabId, signal),
      goBackTo: async (url, signal) => {
        await chrome.tabs.goBack(tabId).catch(() => {});
        await abortable(signal, 800);
        // No history to go back through, or it led somewhere else again: go there by address.
        const now = (await chrome.tabs.get(tabId).catch(() => null))?.url ?? '';
        if (hostOf(now) !== hostOf(url) && url) await chrome.tabs.update(tabId, { url }).catch(() => {});
        await settled(tabId, signal);
      },
      settled: (signal) => settled(tabId, signal),
      wait: (spec, signal) => host.waitInTab(tabId, spec, signal),
      journalWrite: (step: Omit<PendingStep, 'at'>) => host.updateRuns((runs) => withPending(runs, chatId, step)),
      journalClear: () => host.updateRuns((runs) => withoutPending(runs, chatId)),
      loadAllowances: held.load,
      allowSite: held.allowSite,
      allowAction: held.allowAction,
      chatSites: held.sites,
      askEveryStep: async () => (await loadSettings()).askEveryStep === true,
      emit: (e) => host.post(chatId, e),
      newId: () => crypto.randomUUID(),
      now: () => Date.now(),
      sleep: (ms, signal) => abortable(signal, ms),
    };
  }

  return {
    driverFor(chatId, tabId) {
      const driver = new Driver(depsFor(chatId, tabId));
      drivers.set(chatId, { driver, tabId });
      return driver;
    },
    end(chatId) {
      drivers.delete(chatId);
    },
    async rpc(req) {
      switch (req.type) {
        case 'act.answer': {
          const w = waiting.get(req.chatId);
          // A question that has gone is not an error: another panel answered it, or the run stopped.
          if (!w || w.question.id !== req.questionId || !answerFits(w.question, req.answer)) return { ok: false };
          w.answer(req.answer);
          return { ok: true };
        }
        case 'act.allowances':
          return { sites: standingSites(await loadAllowances()) };
        case 'act.allowance-remove':
          await updateAllowances((s) => removeSite(s, req.host));
          return { sites: standingSites(await loadAllowances()) };
      }
    },
    questions() {
      const out: Record<string, Question> = {};
      for (const [chatId, w] of waiting) out[chatId] = w.question;
      return out;
    },
    barDone(tabId) {
      for (const w of waiting.values()) if (w.tabId === tabId && w.question.kind === 'handoff') w.answer({ kind: 'done' });
    },
    tabLoaded(tabId) {
      for (const d of drivers.values()) if (d.tabId === tabId) void d.driver.restoreBar();
    },
    async hidingBar(tabId, capture) {
      const up = [...drivers.values()].some((d) => d.tabId === tabId && d.driver.barIsShowing);
      if (!up) return capture();
      await host.sendToContent(tabId, { type: 'indicator', state: { hidden: true } }).catch(() => {});
      try {
        return await capture();
      } finally {
        await host.sendToContent(tabId, { type: 'indicator', state: { hidden: false } }).catch(() => {});
      }
    },
    note(chatId) {
      const key = noteKey(chatId);
      const read = async () => {
        const r = await chrome.storage.local.get(key);
        return typeof r[key] === 'string' ? r[key] : '';
      };
      return {
        read,
        async change(input) {
          const r = changeNote(await read(), input);
          if (r.ok) await chrome.storage.local.set({ [key]: r.note });
          return r;
        },
      };
    },
    async forget(chatIds) {
      await updateAllowances((s) => chatIds.reduce(forgetChat, s));
    },
  };
}

