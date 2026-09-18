import { computedStyles, describeElements, selectorFor, snapshot } from '@/lib/snapshot';
import type { ContentEvent, ContentRequest } from '@/lib/types';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    let picking: null | (() => void) = null;

    chrome.runtime.onMessage.addListener((msg: ContentRequest, _sender, sendResponse) => {
      switch (msg.type) {
        case 'ping':
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
     * The picker's highlight and its label, in Volt OS colours.
     *
     * These live on someone else's page, so the values are written inline rather than through a
     * stylesheet: injecting one would leak usermods' rules into the site, and the site's own CSS
     * could reach an injected class. They are the volt tokens spelled out — the extension's CSS
     * custom properties do not reach a content script's elements.
     *
     * This stays volt in both themes, deliberately. It is not part of the panel: it is usermods'
     * mark on a page it does not own, and it has to read the same whatever the site's own palette
     * is — the site may be light, dark, or a photograph, and it does not follow the user's theme.
     *
     * What that costs is that neither a light nor a dark page can be assumed, so a single flat
     * colour cannot do the work. Both elements carry their contrast with them:
     *   - the highlight is a volt line with a dark outer ring, so the edge is visible on white
     *     (where volt alone is ~1.6:1) and on black (where the dark ring simply disappears behind
     *     the volt line);
     *   - the label is a near-black pill with volt text, which is legible against anything, and it
     *     takes a light outer ring so its own edge does not vanish on a dark page.
     */
    function startPicker(): () => void {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        border: '1px solid #c8ff2e', // --volt
        background: 'rgba(200,255,46,0.12)', // --volt-a12
        borderRadius: '12px', // --r-field
        // The glow says "live"; the dark ring outside it is what makes the line findable on white.
        boxShadow: '0 0 0 1px rgba(10,13,11,0.55), 0 0 16px rgba(200,255,46,0.35)',
        transition: 'all 40ms linear',
      } satisfies Partial<CSSStyleDeclaration>);
      const label = document.createElement('div');
      Object.assign(label.style, {
        position: 'fixed',
        zIndex: '2147483647',
        pointerEvents: 'none',
        font: "500 12px/1.5 'IBM Plex Mono', ui-monospace, monospace", // identifiers are mono
        background: '#0e120f', // --surface-lo
        color: '#c8ff2e', // --volt
        border: '1px solid #222b24', // --border-card
        // A hairline of light outside the pill, so its edge survives on a dark page too.
        boxShadow: '0 0 0 1px rgba(232,237,232,0.28)',
        padding: '3px 10px',
        borderRadius: '999px', // --r-pill
        maxWidth: '60vw',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      } satisfies Partial<CSSStyleDeclaration>);
      document.documentElement.append(overlay, label);
      let current: Element | null = null;

      const onMove = (e: MouseEvent) => {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (!el || el === overlay || el === label) return;
        current = el;
        const r = el.getBoundingClientRect();
        Object.assign(overlay.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
        label.textContent = selectorFor(el);
        label.style.left = `${Math.max(0, r.left)}px`;
        // Above the highlight when there is room for the pill, otherwise just below it.
        label.style.top = `${r.top > 28 ? r.top - 26 : r.bottom + 6}px`;
      };
      const finish = (ev?: ContentEvent) => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        label.remove();
        picking = null;
        if (ev) chrome.runtime.sendMessage(ev).catch(() => {});
      };
      const onClick = (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!current) return finish({ type: 'pick-cancelled' });
        const html = current.outerHTML.length > 4000 ? snapshot({ root: current, maxChars: 4000 }) : current.outerHTML;
        finish({ type: 'picked', element: { selector: selectorFor(current), html, label: labelFor(current) } });
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          finish({ type: 'pick-cancelled' });
        }
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('click', onClick, true);
      document.addEventListener('keydown', onKey, true);
      return () => finish();
    }
  },
});
