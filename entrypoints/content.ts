import { computedStyles, describeElements, selectorFor, snapshot } from '@/lib/snapshot';
import { waitForDom } from '@/lib/waitdom';
import type { ContentEvent, ContentRequest } from '@/lib/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    let picking: null | (() => void) = null;

    /**
     * Waits currently running in this page, by id.
     *
     * A wait is the one content-script request that does not answer immediately, so it is also the
     * only one that can need cancelling: Stop aborts the run in the background, but the message
     * already in flight here has no notion of an AbortSignal. The background therefore sends a
     * second message — 'wait-cancel' with the same id — and this map is what it reaches.
     */
    const waits = new Map<string, (reason?: string) => void>();

    chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
      switch (msg.type) {
        case 'ping':
          sendResponse({ ok: true });
          return;
        case 'wait': {
          const { promise, cancel } = waitForDom(msg.condition, msg.timeoutMs);
          waits.set(msg.id, cancel);
          void promise.then(
            (outcome) => {
              waits.delete(msg.id);
              sendResponse(outcome);
            },
            (e: unknown) => {
              waits.delete(msg.id);
              sendResponse({ matched: false, elapsedMs: 0, failure: e instanceof Error ? e.message : String(e) });
            },
          );
          // Keeps the message channel open for the async sendResponse above.
          return true;
        }
        case 'wait-cancel':
          waits.get(msg.id)?.('The wait was stopped.');
          waits.delete(msg.id);
          sendResponse({ ok: true });
          return;
        case 'wait-debug':
          // Test flag only: lib/waitdom.ts keeps a live observer count on window when this is set,
          // so the browser flow can prove a finished or cancelled wait left nothing behind.
          (globalThis as unknown as { __usermodsWaitDebug?: boolean }).__usermodsWaitDebug = true;
          sendResponse({ ok: true });
          return;
        case 'snapshot': {
          let root: Element | null = document.body;
          if (msg.selector) {
            try {
              root = document.querySelector(msg.selector);
            } catch (e) {
              sendResponse({ error: `Invalid selector: ${String(e)}` });
              return;
            }
            if (!root) {
              sendResponse({ error: `No element matches "${msg.selector}".` });
              return;
            }
          }
          sendResponse({
            url: location.href,
            title: document.title,
            html: snapshot({ root, maxChars: msg.maxChars }),
          });
          return;
        }
        case 'query':
          sendResponse({ text: describeElements(msg.selector, msg.limit) });
          return;
        case 'styles':
          sendResponse({ text: computedStyles(msg.selector, msg.properties) });
          return;
        case 'pick':
          picking?.();
          picking = startPicker();
          sendResponse({ ok: true });
          return;
      }
    });

    function labelFor(el: Element): string {
      const tag = el.tagName.toLowerCase();
      const text = (el.getAttribute('aria-label') ?? (el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      const short = text.length > 30 ? text.slice(0, 30) + '…' : text;
      return short ? `${tag} "${short}"` : tag;
    }

    /**
     * The picker's highlight and its label, in the usermods brand colours.
     *
     * These live on someone else's page, so the values are written inline rather than through a
     * stylesheet: injecting one would leak usermods' rules into the site, and the site's own CSS
     * could reach an injected class. They are the brand tokens spelled out — the extension's CSS
     * custom properties do not reach a content script's elements.
     *
     * This does NOT follow the user's theme, deliberately. It is not part of the panel: it is
     * usermods' mark on a page it does not own, and it has to read the same whatever the site's own
     * palette is — the site may be light, dark, or a photograph.
     *
     * What that costs is that neither a light nor a dark page can be assumed, so a single flat
     * colour cannot do the work. Both elements carry their contrast with them, and the device that
     * makes that possible is the brand's own: a bright line with a hard ink edge outside it.
     *   - the highlight is a lime line (the "this is alive" colour, and the thing under the cursor
     *     is the liveliest thing on the page) with an ink ring outside it, so the edge is visible on
     *     white — where lime alone is ~1.4:1 — and on black, where the ink ring simply disappears
     *     behind the lime;
     *   - the label is an ink block with lime text at 16.1:1, which is legible against anything, and
     *     it takes a hard lime offset shadow so its own edge does not vanish on a dark page.
     */
    /**
     * Is this a screen you point at with a finger?
     *
     * `(pointer: coarse)` asks about the PRIMARY pointer, so a laptop with a touchscreen still reads
     * as fine and keeps the mouse picker exactly as it was. A phone reads as coarse, and gets the
     * two-step picker below. The check is also re-made on the first real touch, so a device that
     * reports itself oddly still ends up with a way to cancel.
     */
    function touchPrimary(): boolean {
      try {
        return window.matchMedia('(pointer: coarse)').matches;
      } catch {
        return false;
      }
    }

    function startPicker(): () => void {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        border: '2px solid #AEFF24', // --brand-lime
        background: 'rgba(174,255,36,0.14)', // --live-tint
        borderRadius: '2px', // --r-field
        // The glow says "live"; the ink ring outside it is what makes the line findable on white.
        boxShadow: '0 0 0 2px rgba(3,11,22,0.65), 0 0 14px rgba(174,255,36,0.4)',
        transition: 'all 40ms linear',
      } satisfies Partial<CSSStyleDeclaration>);
      const label = document.createElement('div');
      Object.assign(label.style, {
        position: 'fixed',
        zIndex: '2147483647',
        pointerEvents: 'none',
        font: "500 12px/1.5 'IBM Plex Mono', ui-monospace, monospace", // identifiers are mono
        background: '#030B16', // --brand-ink
        color: '#AEFF24', // --brand-lime, 16.1:1 on the ink
        border: '2px solid #AEFF24', // --brand-lime
        // The brand's hard offset, which doubles as the edge that survives on a dark page.
        boxShadow: '3px 3px 0 rgba(243,67,211,0.9)',
        padding: '3px 8px',
        borderRadius: '2px', // --r-field
        maxWidth: '60vw',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      } satisfies Partial<CSSStyleDeclaration>);
      /*
       * The touch bar: what replaces hover and the Escape key.
       *
       * On a mouse the picker is one gesture, move to preview and click to take it, and neither half
       * has an equivalent on a touch screen. There is no hover, so a tap would have to both preview
       * and confirm, which means picking whatever your finger happened to land on with no chance to
       * look at it first. And there is no Escape key, so a picker started by accident on a phone
       * would have no way out at all.
       *
       * So on touch the gesture splits: tap (or drag) to preview, then confirm here. The bar sits at
       * the bottom, where a thumb reaches, carries the selector it is about to take, and is the exit
       * as well as the confirmation. Built here rather than in the popup because the popup is not on
       * screen while you are picking: the sheet closes as soon as you touch the page.
       *
       * It exists on touch only. A mouse never sees it and its behaviour is untouched.
       */
      const bar = document.createElement('div');
      Object.assign(bar.style, {
        position: 'fixed',
        left: '0',
        right: '0',
        bottom: '0',
        zIndex: '2147483647',
        display: touchPrimary() ? 'flex' : 'none',
        alignItems: 'center',
        gap: '8px',
        boxSizing: 'border-box',
        padding: '10px 12px calc(10px + env(safe-area-inset-bottom))',
        background: '#030B16', // --brand-ink
        borderTop: '2px solid #AEFF24', // --brand-lime
        font: "500 13px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
        color: '#AEFF24',
      } satisfies Partial<CSSStyleDeclaration>);
      const barText = document.createElement('span');
      Object.assign(barText.style, {
        flex: '1 1 auto',
        minWidth: '0',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        font: "500 13px/1.4 'IBM Plex Mono', ui-monospace, monospace",
      } satisfies Partial<CSSStyleDeclaration>);
      barText.textContent = 'Tap an element on the page';
      // 44px tall, Apple's minimum, and both buttons are the same size so neither is the easy one to
      // hit by mistake. Cancel is the quieter of the two but not smaller.
      const barButton = (text: string, primary: boolean) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        Object.assign(b.style, {
          flex: 'none',
          minHeight: '44px',
          minWidth: '72px',
          padding: '0 14px',
          borderRadius: '2px',
          border: '2px solid #AEFF24',
          background: primary ? '#AEFF24' : 'transparent',
          color: primary ? '#030B16' : '#AEFF24',
          font: "600 13px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          cursor: 'pointer',
        } satisfies Partial<CSSStyleDeclaration>);
        // Set apart because TypeScript's CSSStyleDeclaration has no name for it: without it, Safari
        // paints a grey box over the button on every tap.
        b.style.setProperty('-webkit-tap-highlight-color', 'transparent');
        return b;
      };
      const useButton = barButton('Use', true);
      useButton.disabled = true;
      useButton.style.opacity = '0.45';
      const cancelButton = barButton('Cancel', false);
      bar.append(barText, useButton, cancelButton);

      document.documentElement.append(overlay, label, bar);
      let current: Element | null = null;

      /** Move the highlight to whatever is at this point. Shared by the mouse and the finger. */
      const preview = (x: number, y: number) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el === overlay || el === label || bar.contains(el)) return;
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        const sel = selectorFor(el);
        label.textContent = sel;
        label.style.left = `${Math.max(0, r.left)}px`;
        // Above the highlight when there is room for the pill, otherwise just below it.
        label.style.top = `${r.top > 28 ? r.top - 26 : r.bottom + 6}px`;
        barText.textContent = sel;
        useButton.disabled = false;
        useButton.style.opacity = '1';
      };
      const onMove = (e: MouseEvent) => preview(e.clientX, e.clientY);
      const finish = (ev?: ContentEvent) => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        document.removeEventListener('touchstart', onTouch, true);
        document.removeEventListener('touchmove', onTouch, true);
        overlay.remove();
        label.remove();
        bar.remove();
        picking = null;
        if (ev) chrome.runtime.sendMessage(ev).catch(() => {});
      };
      /** Take what is highlighted. Reached by a mouse click, or by the Use button on touch. */
      const take = () => {
        if (!current) return finish({ type: 'pick-cancelled' });
        const html = current.outerHTML.length > 4000 ? snapshot({ root: current, maxChars: 4000 }) : current.outerHTML;
        finish({ type: 'picked', element: { selector: selectorFor(current), html, label: labelFor(current) } });
      };
      const onClick = (e: MouseEvent) => {
        // The bar is the picker's own UI, so its buttons handle their own clicks.
        if (e.target instanceof Node && bar.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        // A tap fires a click too, and on touch a click must not confirm: the whole point of the bar
        // is that you see what you are about to take before you take it. The tap has already moved
        // the highlight, so swallowing the click here costs nothing and prevents the page's own
        // handler from running, which is what the mouse path swallows it for as well.
        if (touched) return;
        take();
      };
      /*
       * Drag to aim. Non-passive, because the preview is useless if the page scrolls out from under
       * the finger while you are choosing, so the scroll is prevented for as long as the picker is
       * up, and the picker is up only when the user asked for it.
       */
      let touched = false;
      const onTouch = (e: TouchEvent) => {
        if (e.target instanceof Node && bar.contains(e.target)) return;
        const t = e.touches[0];
        if (!t) return;
        touched = true;
        bar.style.display = 'flex';
        e.preventDefault();
        preview(t.clientX, t.clientY);
      };
      useButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        take();
      });
      cancelButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        finish({ type: 'pick-cancelled' });
      });
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish({ type: 'pick-cancelled' });
        }
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('touchstart', onTouch, { capture: true, passive: false });
      document.addEventListener('touchmove', onTouch, { capture: true, passive: false });
      return () => finish();
    }
  },
});
