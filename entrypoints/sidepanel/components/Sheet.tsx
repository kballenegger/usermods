import { useEffect, useId, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useShell } from '../shell';
import { CloseIcon } from './icons';

/**
 * The bottom sheet: the one way the compact shell shows anything that is not the conversation.
 *
 * On a phone the chat view keeps only what reading and sending need. Everything else (the chat
 * list, the model, the draft, navigation) is one tap away in one of these, so they all behave the
 * same way and the behaviour is written once:
 *
 *  - it is a modal dialog: role="dialog", aria-modal, named by its title, and the rest of the
 *    shell is `inert` while it is up, which is what actually keeps VoiceOver and the Tab key out
 *    of the page behind (aria-modal alone is advisory on iOS);
 *  - focus moves to the sheet when it opens, stays inside it, and goes back to the control that
 *    opened it when it closes. It lands on the panel itself rather than on the first field, so
 *    opening a sheet never raises the keyboard uninvited;
 *  - it closes on Escape, on a tap outside, on the close button, and on dragging the grabber down.
 *    The close button is always there: a gesture is a shortcut, never the only way out;
 *  - it is at most 85% of what is visible, its content scrolls inside it, it sits on the keyboard
 *    when there is one, and it pads itself for the home indicator.
 *
 * It renders nothing outside the compact shell. The side panel and the Mac popover never mount one.
 */
export function Sheet({
  title,
  onClose,
  children,
  returnFocus,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * The control to hand focus back to. Tapping a button does not focus it in Safari on iOS, so
   * "whatever had focus when the sheet opened" is usually <body> there and the opener has to be
   * named. Falls back to the focused element when it is not.
   */
  returnFocus?: RefObject<HTMLElement | null>;
  testId?: string;
}) {
  const { sheetHost } = useShell();
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const root = rootRef.current;
    const panel = panelRef.current;
    if (!root || !panel) return;
    const opener = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    // Everything in the shell that is not a sheet goes inert. Siblings only: the sheet is
    // portalled to the shell's root precisely so that it is not inside what goes quiet.
    const silenced: HTMLElement[] = [];
    for (const el of Array.from(root.parentElement?.children ?? [])) {
      if (el instanceof HTMLElement && el !== root && !el.classList.contains('sheet-root') && !el.inert) {
        el.inert = true;
        silenced.push(el);
      }
    }
    panel.focus({ preventScroll: true });
    return () => {
      for (const el of silenced) el.inert = false;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
    // Once per sheet: the opener is whoever opened it, not whoever is current on a later render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the sheet wherever focus is, including nowhere: with the rest of the shell inert,
  // a stray tap on the scrim leaves focus on <body>, and a key handler on the panel would not hear it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  /**
   * Tab is walked by hand rather than left to the browser with a wrap at each end. Safari's
   * default is to Tab between text fields only and skip buttons, so "let it move, catch the ends"
   * walks straight out of a sheet made of buttons into the browser's own toolbar. Moving focus
   * ourselves through every control in the sheet behaves the same in every engine and setting.
   */
  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Tab') return;
    const panel = panelRef.current;
    if (!panel) return;
    e.preventDefault();
    const stops = focusable(panel);
    if (!stops.length) return;
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = e.shiftKey ? (at <= 0 ? stops.length - 1 : at - 1) : at === -1 || at === stops.length - 1 ? 0 : at + 1;
    stops[next]!.focus();
  }

  /**
   * Drag the grabber down to dismiss. Pointer events on the header only, so a scroll inside the
   * content is never mistaken for a dismissal, and the panel follows the finger so the gesture
   * reads as moving the sheet rather than as a hidden trigger.
   */
  const drag = useRef<{ y: number; id: number } | null>(null);
  function onGrabDown(e: React.PointerEvent) {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { y: e.clientY, id: e.pointerId };
    e.currentTarget.setPointerCapture(e.pointerId);
  }
  function onGrabMove(e: React.PointerEvent) {
    const d = drag.current;
    const panel = panelRef.current;
    if (!d || !panel || d.id !== e.pointerId) return;
    const dy = Math.max(0, e.clientY - d.y);
    panel.style.transition = 'none';
    panel.style.transform = `translateY(${dy}px)`;
  }
  function onGrabEnd(e: React.PointerEvent) {
    const d = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!d || !panel) return;
    const dy = e.clientY - d.y;
    panel.style.transition = '';
    panel.style.transform = '';
    if (e.type === 'pointerup' && dy > DISMISS_AFTER_PX) onClose();
  }

  if (!sheetHost) return null;

  return createPortal(
    <div className="sheet-root" ref={rootRef} data-testid={testId} onKeyDown={onKeyDown}>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="sheet" ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="sheet-head" onPointerDown={onGrabDown} onPointerMove={onGrabMove} onPointerUp={onGrabEnd} onPointerCancel={onGrabEnd}>
          <span className="sheet-grabber" aria-hidden="true" />
          <h2 className="sheet-title" id={titleId}>
            {title}
          </h2>
          <button type="button" className="sheet-close" onClick={onClose} aria-label={`Close ${title}`} data-testid="sheet-close">
            <CloseIcon />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    sheetHost,
  );
}

/** How far the grabber has to travel before letting go closes the sheet. */
const DISMISS_AFTER_PX = 90;

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function focusable(within: HTMLElement): HTMLElement[] {
  return Array.from(within.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * One action in a sheet: a full-width row, 48px tall, a label on the left and, optionally, what it
 * is currently set to on the right. Rows rather than a grid of buttons, because a list of plainly
 * worded rows is what a thumb and a screen reader both get through fastest.
 */
export function SheetRow({
  label,
  value,
  icon,
  onClick,
  disabled,
  danger,
  current,
  testId,
  action,
  title,
}: {
  label: string;
  value?: string;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  /** This row is where you already are (the chat on screen, the view you are in). */
  current?: boolean;
  testId?: string;
  action?: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={`sheet-row${danger ? ' danger' : ''}${current ? ' current' : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-current={current ? 'true' : undefined}
      data-testid={testId}
      data-action={action}
      title={title}
    >
      {icon && <span className="sheet-row-icon">{icon}</span>}
      <span className="sheet-row-label">{label}</span>
      {value && <span className="sheet-row-value">{value}</span>}
    </button>
  );
}
