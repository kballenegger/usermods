import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

/**
 * A button that opens a small menu of actions, anchored to itself.
 *
 * The side panel's and the Mac popover's answer to the compact shell's "+" sheet: the things you do
 * to a message now and then (point at an element, attach an image, start a new chat) live behind
 * one button so the composer stays one row, and on a pointer a sheet would be the wrong size of
 * thing — this is a popover the width of its words, opening from the button it belongs to.
 *
 * It is the ARIA menu-button pattern:
 *
 *   trigger        `aria-haspopup="menu"`, `aria-expanded`, `aria-controls` the menu
 *   Enter / Space / ↓  open, focus the first item        ↑   open, focus the last
 *   ↑ / ↓          move, wrapping                        Home / End   first / last
 *   Enter / Space  choose (a native button click)
 *   Escape         close, focus returns to the trigger   Tab   close, and move on as usual
 *   click outside  close
 *
 * Choosing an item closes the menu, returns focus to the trigger and then runs the action, in that
 * order, so an action that moves focus somewhere else (a file chooser, the element picker) is not
 * fought by the menu's own clean-up. The action runs inside the click's own event, which is what a
 * file input's `click()` needs to count as a user gesture.
 *
 * It renders nothing beyond the button while closed, and it draws no scrim: it is a menu, not a
 * dialog, so the transcript behind it stays readable and clickable.
 */
export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  /** Shown beside the label, e.g. "⌘⇧K". Purely informative: the item does not bind the key. */
  shortcut?: string;
  disabled?: boolean;
  title?: string;
  onSelect: () => void;
  testId?: string;
}

export function MenuButton({
  label,
  title,
  icon,
  children,
  items,
  menuLabel,
  className = '',
  disabled,
  testId,
  action,
  placement = 'up',
}: {
  /** The trigger's accessible name; the visible part is `icon` and/or `children`. */
  label: string;
  title?: string;
  icon?: ReactNode;
  children?: ReactNode;
  items: MenuItem[];
  /** The menu's accessible name. Defaults to the trigger's. */
  menuLabel?: string;
  className?: string;
  disabled?: boolean;
  testId?: string;
  action?: string;
  /**
   * Which way it opens. Up by default, for the composer, the last thing in the panel. A menu on a
   * card or a row (the mod's Export) opens down instead, from its button's left edge.
   */
  placement?: 'up' | 'down';
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  /** Which item to land on when the menu opens: first for Enter/Space/↓, last for ↑. */
  const landOn = useRef<'first' | 'last'>('first');

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function openMenu(where: 'first' | 'last') {
    if (disabled) return;
    landOn.current = where;
    setOpen(true);
  }

  const enabledItems = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? []);

  // Focus moves into the menu the moment it opens: an opened menu that leaves focus on its button
  // is invisible to a screen reader and to the arrow keys.
  useEffect(() => {
    if (!open) return;
    const stops = enabledItems();
    const target = landOn.current === 'last' ? stops[stops.length - 1] : stops[0];
    (target ?? menuRef.current)?.focus();
  }, [open]);

  // A press anywhere outside closes it. Mousedown rather than click, so the press that lands on the
  // textarea both closes the menu and places the caret, as one gesture.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    const stops = enabledItems();
    const at = stops.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => stops[(i + stops.length) % stops.length]?.focus();
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        go(at + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        go(at - 1);
        break;
      case 'Home':
        e.preventDefault();
        go(0);
        break;
      case 'End':
        e.preventDefault();
        go(stops.length - 1);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Not prevented: focus moves on as it normally would, and the menu is simply gone.
        close(false);
        break;
    }
  }

  function choose(item: MenuItem) {
    close(true);
    item.onSelect();
  }

  return (
    <div
      className="menu-anchor"
      ref={rootRef}
      onBlur={(e) => {
        if (open && !e.currentTarget.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        className={className}
        data-testid={testId}
        data-action={action}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
        onClick={() => (open ? close(true) : openMenu('first'))}
        onKeyDown={(e) => {
          if (open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            openMenu('first');
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            openMenu('last');
          }
        }}
      >
        {icon}
        {children}
      </button>
      {open && (
        <div className={placement === 'down' ? 'menu down' : 'menu'} id={menuId} ref={menuRef} role="menu" aria-label={menuLabel ?? label} tabIndex={-1} onKeyDown={onMenuKeyDown} data-testid={testId ? `${testId}-menu` : undefined}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="menu-item"
              disabled={item.disabled}
              title={item.title}
              data-testid={item.testId}
              onClick={() => choose(item)}
            >
              {item.icon && <span className="menu-item-icon">{item.icon}</span>}
              <span className="menu-item-label">{item.label}</span>
              {item.shortcut && (
                <span className="menu-item-shortcut" aria-hidden="true">
                  {item.shortcut}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
