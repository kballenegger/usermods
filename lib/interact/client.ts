// The page's end of operating it: what entrypoints/content.ts hands its inventory, describe, act,
// highlight and indicator messages to, and what find_elements' refs come from. Everything here sits
// behind ACT_OFF at the one call site, so a flag-off bundle holds none of this directory. See
// lib/shareclient.ts for the same arrangement around sharing.
//
// The bar's two buttons are the only thing that talks back, and they say only "stop" and "done".
// Nothing the page can reach here answers a permission.

import { describeElements } from '../inspect';
import { BAR_DONE, BAR_STOP, barIsUp, clearOutline, flashTarget, holdOutline, removeBar, setBarHidden, showBar } from '../pageui';
import { describeStep, runStep, type ActStep } from './actions';
import { createRegistry, type Registry } from './registry';
import { queryEverywhere, resolveSelector, type TargetSpec } from './target';
import { operableInventory } from './view';

export type IndicatorState =
  /** Up, reading this. `handoff` adds "I have done it", which is only ever true during Your turn. */
  | { bar: { status: string; handoff?: boolean } }
  /** Off for the instant of a screenshot, so the model does not see usermods' own mark. */
  | { hidden: boolean }
  | { bar: null };

export type InteractMessage =
  | { type: 'inventory'; selector?: string; maxChars?: number }
  | { type: 'describe'; step: ActStep }
  | { type: 'act'; id: string; step: ActStep; expect: string }
  | { type: 'act-cancel'; id: string }
  | { type: 'highlight'; target?: TargetSpec; mode: 'flash' | 'hold' | 'clear'; label?: string }
  | { type: 'indicator'; state: IndicatorState };

let registry: Registry | null = null;

/** One registry for this document, made on first use: its prefix is the document's identity. */
function theRegistry(): Registry {
  return (registry ??= createRegistry(performance.timeOrigin));
}

let leaving: Promise<void> | null = null;

/** This document leaving, for an action whose answer would otherwise be lost with it. */
function unloading(): Promise<void> {
  return (leaving ??= new Promise((resolve) => {
    window.addEventListener('beforeunload', () => resolve(), { once: true });
    window.addEventListener('pagehide', () => resolve(), { once: true });
  }));
}

/** Steps in flight, by id: Stop reaches a repeat between its clicks through 'act-cancel'. */
const running = new Map<string, { cancelled: boolean }>();

function inventory(msg: { selector?: string; maxChars?: number }): string {
  const reg = theRegistry();
  let scope: Element | undefined;
  if (msg.selector) {
    const found = resolveSelector(msg.selector, { refOf: reg.refFor });
    if (found.kind === 'found') scope = found.el;
    else {
      // A region can match several times; the first is what "scoped by selector" reads as in a list.
      const first = found.reason === 'several' ? queryEverywhere(msg.selector)[0] : undefined;
      if (!first) return found.message;
      scope = first;
    }
  }
  return operableInventory({ refOf: reg.refFor, ...(scope ? { scope } : {}), ...(msg.maxChars ? { maxChars: msg.maxChars } : {}) });
}

/** find_elements, with a ref on every match, or the inventory when that is what was asked for. */
export function interactQuery(msg: { selector?: string; limit?: number; text?: string; styles?: string[]; overlays?: boolean; operable?: boolean }): string {
  if (msg.operable) {
    const list = inventory({ ...(msg.selector ? { selector: msg.selector } : {}) });
    return msg.overlays ? `${describeElements(undefined, msg.limit, undefined, { overlays: true })}\n\n${list}` : list;
  }
  return describeElements(msg.selector, msg.limit, msg.text, { styles: msg.styles, overlays: msg.overlays, refOf: theRegistry().refFor });
}

/** Returns true when the answer is on its way later, as a chrome.runtime.onMessage listener does. */
export function handleInteractMessage(msg: InteractMessage, sendResponse: (r: unknown) => void): true | undefined {
  switch (msg.type) {
    case 'inventory':
      sendResponse({ text: inventory(msg) });
      return undefined;
    case 'describe':
      sendResponse(describeStep(msg.step, { registry: theRegistry() }));
      return undefined;
    case 'act': {
      const state = { cancelled: false };
      running.set(msg.id, state);
      void runStep(msg.step, msg.expect, {
        registry: theRegistry(),
        isCancelled: () => state.cancelled,
        flash: flashTarget,
        leaving: unloading(),
      }).then(
        (r) => {
          running.delete(msg.id);
          sendResponse(r);
        },
        (e: unknown) => {
          running.delete(msg.id);
          sendResponse({ ok: false, code: 'unsupported', message: e instanceof Error ? e.message : String(e) });
        },
      );
      return true;
    }
    case 'act-cancel': {
      const state = running.get(msg.id);
      if (state) state.cancelled = true;
      sendResponse({ ok: true });
      return undefined;
    }
    case 'highlight': {
      if (msg.mode === 'clear' || !msg.target) {
        clearOutline();
        sendResponse({ ok: true });
        return undefined;
      }
      const found = theRegistry().resolve(msg.target);
      if (found.kind === 'broken') {
        sendResponse({ ok: false, message: found.message });
        return undefined;
      }
      if (msg.mode === 'flash') flashTarget(found.el);
      else holdOutline(found.el, msg.label);
      sendResponse({ ok: true });
      return undefined;
    }
    case 'indicator': {
      const state = msg.state;
      if ('hidden' in state) setBarHidden(state.hidden);
      else if (state.bar) {
        showBar(state.bar, {
          onStop: () => void chrome.runtime.sendMessage({ type: BAR_STOP }).catch(() => {}),
          onDone: () => void chrome.runtime.sendMessage({ type: BAR_DONE }).catch(() => {}),
        });
      } else removeBar();
      // The background reads this before each step: a page that removed the bar for good pauses the
      // run. It is an answer to the background's question, not a message the page can send.
      sendResponse({ ok: true, up: barIsUp() });
      return undefined;
    }
  }
}
