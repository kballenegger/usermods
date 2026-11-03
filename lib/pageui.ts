// usermods' own marks on someone else's page: the share hint bubble, the install banner, the bar
// shown while a run operates the page, and the outline on the element it is about to touch.
//
// All live in a shadow root on a host element of their own, so no page CSS reaches in and none of
// ours reaches out; `all: initial` on the host stops inherited properties crossing the boundary
// too. The colours are the brand's (docs/branding.md) spelled out, because the extension's CSS
// custom properties do not exist on a web page, and each follows the OS colour scheme: ink with a
// lime edge in dark, paper with an electric-blue edge in light. Targets are 44px on a touch screen.
//
// DOM only — no chrome.* — so the content script owns every message and this file owns every pixel.

const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.box {
  --bg: #F7F9FF; --fg: #030B16; --muted: #3A4458; --edge: #1008C8; --shadow: #1008C8;
  --btn-bg: #1008C8; --btn-fg: #FFFFFF; --ghost-fg: #1008C8; --ring: #1008C8;
  font: 400 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
  border: 2px solid var(--edge);
  border-radius: 2px;
  box-shadow: 4px 4px 0 var(--shadow);
  -webkit-font-smoothing: antialiased;
}
@media (prefers-color-scheme: dark) {
  .box {
    --bg: #030B16; --fg: #E9F2FF; --muted: #A9B6CC; --edge: #AEFF24; --shadow: rgba(243,67,211,0.9);
    --btn-bg: #AEFF24; --btn-fg: #030B16; --ghost-fg: #AEFF24; --ring: #AEFF24;
  }
}
.mark {
  font: 600 11px/1 "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0.02em;
  color: var(--edge);
  flex: none;
}
.text { flex: 1 1 auto; min-width: 0; }
.muted { color: var(--muted); }
.mono { font-family: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; overflow-wrap: anywhere; }
button {
  font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  letter-spacing: 0.02em;
  min-height: 32px;
  padding: 0 12px;
  border-radius: 2px;
  border: 2px solid var(--btn-bg);
  background: var(--btn-bg);
  color: var(--btn-fg);
  cursor: pointer;
  flex: none;
  -webkit-tap-highlight-color: transparent;
}
button.ghost { background: transparent; color: var(--ghost-fg); }
button.close {
  min-width: 32px; padding: 0; background: transparent; border-color: transparent; color: var(--fg);
  font-size: 18px; line-height: 1;
}
button:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
@media (pointer: coarse) {
  button { min-height: 44px; }
  button.close { min-width: 44px; }
}
.status { font: 600 12px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: var(--edge); flex: none; }
`;

function host(kind: 'hint' | 'banner' | 'bar' | 'outline', mode: ShadowRootMode = 'open'): { el: HTMLElement; root: ShadowRoot } {
  const el = document.createElement('div');
  el.setAttribute('data-usermods', kind);
  // Out of flow and above everything, set inline so no page rule can move it.
  el.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; top: 0; left: 0; width: 0; height: 0;';
  const root = el.attachShadow({ mode });
  const style = document.createElement('style');
  style.textContent = STYLE;
  root.append(style);
  document.documentElement.append(el);
  return { el, root };
}

function button(label: string, cls = '', testId?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  if (testId) b.setAttribute('data-testid', testId);
  return b;
}

export interface HintAction {
  label: string;
  onClick: () => void;
  ghost?: boolean;
  testId?: string;
}

export interface HintOptions {
  text: string;
  /** A second, quieter paragraph: the Greasy Fork sync tip. */
  extra?: string;
  /** The site's button to point at. The hint never presses it. */
  anchor?: Element | null;
  actions?: HintAction[];
  testId?: string;
}

export interface Hint {
  el: HTMLElement;
  remove(): void;
}

let currentHint: Hint | null = null;

/**
 * A dismissible bubble pointing at the site's own save button, with a ring drawn around the button
 * (in the shadow root, over it, never on it: the page's element is not touched). One at a time: a
 * new hint replaces the last.
 */
export function showHint(opts: HintOptions): Hint {
  currentHint?.remove();
  const { el, root } = host('hint');
  const ring = document.createElement('div');
  ring.style.cssText = 'position: fixed; pointer-events: none; display: none; border-radius: 4px;';
  ring.className = 'ring';
  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  if (opts.testId) box.setAttribute('data-testid', opts.testId);
  box.style.cssText = 'position: fixed; width: min(340px, calc(100vw - 24px)); padding: 12px 12px 12px 14px; display: flex; flex-direction: column; gap: 8px;';
  const head = document.createElement('div');
  head.style.cssText = 'display: flex; align-items: center; gap: 8px;';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = 'usermods';
  const spacer = document.createElement('span');
  spacer.style.flex = '1';
  const close = button('×', 'close', 'usermods-hint-close');
  close.setAttribute('aria-label', 'Dismiss the usermods hint');
  head.append(mark, spacer, close);
  const text = document.createElement('div');
  text.className = 'text';
  text.setAttribute('data-testid', 'usermods-hint-text');
  text.textContent = opts.text;
  box.append(head, text);
  if (opts.extra) {
    const extra = document.createElement('div');
    extra.className = 'text muted';
    extra.textContent = opts.extra;
    box.append(extra);
  }
  if (opts.actions?.length) {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';
    for (const a of opts.actions) {
      const b = button(a.label, a.ghost ? 'ghost' : '', a.testId);
      b.addEventListener('click', a.onClick);
      row.append(b);
    }
    box.append(row);
  }
  // The ring takes the box's edge colour, which is only defined inside .box; give it its own.
  const ringColour = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? '#AEFF24' : '#1008C8';
  ring.style.boxShadow = `0 0 0 3px ${ringColour}, 0 0 0 6px rgba(243,67,211,0.55)`;
  root.append(ring, box);

  let frame = 0;
  const place = () => {
    frame = 0;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bw = box.offsetWidth || 340;
    const bh = box.offsetHeight || 120;
    const a = opts.anchor && opts.anchor.isConnected ? opts.anchor.getBoundingClientRect() : null;
    if (!a || (a.width === 0 && a.height === 0)) {
      ring.style.display = 'none';
      box.style.left = `${Math.max(12, vw - bw - 16)}px`;
      box.style.top = '16px';
      return;
    }
    ring.style.display = 'block';
    Object.assign(ring.style, { left: `${a.left - 2}px`, top: `${a.top - 2}px`, width: `${a.width + 4}px`, height: `${a.height + 4}px` });
    const left = Math.min(Math.max(12, a.right - bw), vw - bw - 12);
    const above = a.top - bh - 14;
    const top = above >= 12 ? above : Math.min(a.bottom + 14, vh - bh - 12);
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(12, top)}px`;
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  if (opts.anchor) {
    try {
      opts.anchor.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
    } catch {
      /* an element that cannot scroll is still pointed at */
    }
  }
  place();
  schedule();
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  const hint: Hint = {
    el,
    remove() {
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      if (frame) cancelAnimationFrame(frame);
      el.remove();
      if (currentHint === hint) currentHint = null;
    },
  };
  close.addEventListener('click', () => hint.remove());
  currentHint = hint;
  return hint;
}

export function removeHint(): void {
  currentHint?.remove();
}

export interface BannerRow {
  message: string;
  /** The button; absent when the row is a status ("Installed ✓"). */
  action?: { label: string; onClick: () => void };
  status?: string;
}

/**
 * The install banner: a slim floating bar at the top of the page with a close button. It floats
 * rather than pushing the page down, so it never moves the site's own layout, and closing it is one
 * tap (the caller remembers the dismissal).
 */
export function showBanner(rows: BannerRow[], onClose: () => void): HTMLElement {
  document.querySelector('[data-usermods="banner"]')?.remove();
  const { el, root } = host('banner');
  const box = document.createElement('div');
  box.className = 'box';
  box.setAttribute('role', 'region');
  box.setAttribute('aria-label', 'usermods');
  box.setAttribute('data-testid', 'usermods-banner');
  box.style.cssText =
    'position: fixed; top: 10px; left: 50%; transform: translateX(-50%); width: max-content; max-width: min(760px, calc(100vw - 16px)); padding: 6px 6px 6px 12px; display: flex; flex-direction: column; gap: 4px;';
  rows.forEach((r, i) => {
    const row = document.createElement('div');
    row.style.cssText = 'display: flex; align-items: center; gap: 10px; min-width: 0;';
    row.setAttribute('data-testid', 'usermods-banner-row');
    // No separate "usermods" mark here: the message already starts with the name.
    const text = document.createElement('span');
    text.className = 'text';
    text.setAttribute('data-testid', 'usermods-banner-text');
    text.textContent = r.message;
    row.append(text);
    if (r.action) {
      const b = button(r.action.label, '', 'usermods-banner-action');
      b.addEventListener('click', r.action.onClick);
      row.append(b);
    }
    if (r.status) {
      const s = document.createElement('span');
      s.className = 'status';
      s.setAttribute('data-testid', 'usermods-banner-status');
      s.textContent = r.status;
      row.append(s);
    }
    if (i === 0) {
      const close = button('×', 'close', 'usermods-banner-close');
      close.setAttribute('aria-label', 'Dismiss the usermods banner for this page');
      close.addEventListener('click', () => {
        el.remove();
        onClose();
      });
      row.append(close);
    } else {
      const pad = document.createElement('span');
      pad.style.cssText = 'width: 32px; flex: none;';
      row.append(pad);
    }
    box.append(row);
  });
  root.append(box);
  return el;
}

// ---------------------------------------------------------------------------
// The bar: a run is operating this page
// ---------------------------------------------------------------------------
//
// Status, Stop and "I have done it". It never carries Allow: a page can cover a box's text and leave
// its button showing, so a permission is only ever answered in an extension page. Its root is closed
// so the page has no way in, and its buttons honour only trusted clicks, so neither the page nor a
// script can press them. What the worst forgery could do is stop a run or end a handoff early, both
// harmless, which is why these two are all the background accepts from a page.

/** The messages the bar's two buttons send. Everything a page may say about a run. */
export const BAR_STOP = 'usermods:bar-stop';
export const BAR_DONE = 'usermods:bar-done';

export interface BarState {
  status: string;
  /** Your turn: the step is the user's, so the bar offers "I have done it". */
  handoff?: boolean;
}

export interface BarHandlers {
  onStop: () => void;
  onDone: () => void;
}

/** How many times the bar is put back after the page removes it, before the run is told. */
const BAR_RESTORES = 3;

interface Bar {
  el: HTMLElement;
  root: ShadowRoot;
  text: HTMLElement;
  done: HTMLButtonElement;
  observer: MutationObserver | null;
  restores: number;
}

let bar: Bar | null = null;

/** A listener that does nothing unless a real person pressed. `isTrusted` cannot be forged by a page. */
export function trustedOnly<E extends Pick<Event, 'isTrusted'>>(act: () => void): (e: E) => void {
  return (e) => {
    if (e.isTrusted) act();
  };
}

/** Put the bar up, or change what it says. The handlers of the first call stay for as long as it is up. */
export function showBar(state: BarState, handlers: BarHandlers): HTMLElement {
  if (!bar) {
    const { el, root } = host('bar', 'closed');
    const box = document.createElement('div');
    box.className = 'box';
    box.setAttribute('role', 'region');
    box.setAttribute('aria-label', 'usermods');
    box.style.cssText = 'position: fixed; top: 0; left: 0; right: 0; padding: 6px 12px; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px;';
    const mark = document.createElement('span');
    mark.className = 'mark';
    mark.textContent = 'usermods';
    const text = document.createElement('span');
    text.className = 'text';
    text.setAttribute('role', 'status');
    text.setAttribute('aria-live', 'polite');
    text.style.flexBasis = '160px';
    const done = button('I HAVE DONE IT', '', 'usermods-bar-done');
    done.addEventListener('click', trustedOnly(handlers.onDone));
    const stop = button('STOP', 'ghost', 'usermods-bar-stop');
    stop.addEventListener('click', trustedOnly(handlers.onStop));
    box.append(mark, text, done, stop);
    root.append(box);
    bar = { el, root, text, done, observer: null, restores: 0 };
    watchBar(bar);
  }
  bar.text.textContent = state.status;
  bar.done.style.display = state.handoff ? '' : 'none';
  return bar.el;
}

/** The page removing the bar puts it back, a few times. After that barIsUp says so and the run pauses. */
function watchBar(b: Bar): void {
  if (typeof MutationObserver === 'undefined') return;
  b.observer = new MutationObserver(() => {
    if (b.el.isConnected) return;
    if (b.restores >= BAR_RESTORES) {
      b.observer?.disconnect();
      return;
    }
    b.restores++;
    document.documentElement.append(b.el);
  });
  b.observer.observe(document.documentElement, { childList: true });
}

/** Is the bar on the page? False when no run has raised it or when the page got rid of it. */
export function barIsUp(): boolean {
  return bar?.el.isConnected === true;
}

/** Hide it for the instant of a screenshot, so the model does not see usermods' own mark. */
export function setBarHidden(hidden: boolean): void {
  if (bar) bar.el.style.display = hidden ? 'none' : '';
}

export function removeBar(): void {
  bar?.observer?.disconnect();
  bar?.el.remove();
  bar = null;
}

// ---------------------------------------------------------------------------
// The outline: what the next step is about
// ---------------------------------------------------------------------------
//
// Drawn in a root of its own over the element, never on it: the page's element is not touched. A
// flash before each step, gone in about 300 ms, and a still outline under prefers-reduced-motion. A
// hold stays until the next click or until it is cleared: find_elements with `show`, and for as long
// as an Allow question is up.

const FLASH_MS = 300;

let clearCurrentOutline: (() => void) | null = null;

/** The edge colour of the box, which is only defined inside .box; the same pick the hint's ring makes. */
function edgeColour(): string {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? '#AEFF24' : '#1008C8';
}

function drawOutline(target: Element, label?: string): { box: HTMLElement; remove: () => void } {
  clearCurrentOutline?.();
  const { el, root } = host('outline');
  const box = document.createElement('div');
  box.style.cssText = `position: fixed; pointer-events: none; outline: 2px solid ${edgeColour()}; outline-offset: 1px; border-radius: 2px;`;
  root.append(box);
  let tag: HTMLElement | null = null;
  if (label) {
    tag = document.createElement('div');
    tag.className = 'box mono';
    tag.textContent = label;
    tag.style.cssText = 'position: fixed; pointer-events: none; padding: 2px 6px; max-width: min(320px, calc(100vw - 24px));';
    root.append(tag);
  }
  let frame = 0;
  const place = () => {
    frame = 0;
    const r = target.getBoundingClientRect();
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    if (tag) {
      tag.style.left = `${Math.max(4, r.left)}px`;
      tag.style.top = `${r.top > 32 ? r.top - 28 : r.bottom + 6}px`;
    }
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(place);
  };
  place();
  window.addEventListener('scroll', schedule, true);
  window.addEventListener('resize', schedule);
  const remove = () => {
    window.removeEventListener('scroll', schedule, true);
    window.removeEventListener('resize', schedule);
    if (frame) cancelAnimationFrame(frame);
    el.remove();
    if (clearCurrentOutline === remove) clearCurrentOutline = null;
  };
  clearCurrentOutline = remove;
  return { box, remove };
}

/** About 300 ms around the target, fading out; under reduced motion a still outline for as long. */
export function flashTarget(target: Element): void {
  const { box, remove } = drawOutline(target);
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduced) {
    box.style.transition = `opacity ${FLASH_MS}ms linear`;
    requestAnimationFrame(() => {
      box.style.opacity = '0';
    });
  }
  setTimeout(remove, FLASH_MS);
}

/** Stays until the next real click on the page, or clearOutline. */
export function holdOutline(target: Element, label?: string): void {
  const { remove } = drawOutline(target, label);
  const onClick = trustedOnly<MouseEvent>(() => {
    window.removeEventListener('click', onClick, true);
    remove();
  });
  window.addEventListener('click', onClick, true);
}

export function clearOutline(): void {
  clearCurrentOutline?.();
}
