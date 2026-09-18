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

    function startPicker(): () => void {
      const overlay = document.createElement('div');
      Object.assign(overlay.style, {
        position: 'fixed',
        pointerEvents: 'none',
        zIndex: '2147483647',
        border: '2px solid #f59e0b',
        background: 'rgba(245,158,11,0.15)',
        borderRadius: '3px',
        transition: 'all 40ms linear',
      } satisfies Partial<CSSStyleDeclaration>);
      const label = document.createElement('div');
      Object.assign(label.style, {
        position: 'fixed',
        zIndex: '2147483647',
        pointerEvents: 'none',
        font: '12px/1.4 ui-monospace, monospace',
        background: '#1c1917',
        color: '#fde68a',
        padding: '2px 6px',
        borderRadius: '3px',
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
        label.style.top = `${r.top > 24 ? r.top - 22 : r.bottom + 4}px`;
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
