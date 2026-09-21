import { createContext, useContext } from 'react';

/**
 * What the views need to know about the shell they are drawn in.
 *
 * Almost nothing, and for two of the three shells exactly nothing: the side panel and the Mac
 * popover get the default below and every view renders as it always has. The compact popup (iPhone
 * and iPad) is the one shell where a view's own chrome has to move: the chat's switcher goes up
 * into the top bar, its draft panel and model picker go into bottom sheets. That is a different
 * tree, not a different stylesheet, so the views ask here which one to build.
 */
export interface Shell {
  /** True in the Safari popup on a touch device. False in the side panel and the Mac popover. */
  compact: boolean;
  /** The part of the compact top bar the current view fills (the chat puts its title there). */
  barSlot: HTMLElement | null;
  /** Where bottom sheets are portalled: the shell's root, so the compact-scoped CSS reaches them. */
  sheetHost: HTMLElement | null;
}

export const PANEL_SHELL: Shell = { compact: false, barSlot: null, sheetHost: null };

export const ShellContext = createContext<Shell>(PANEL_SHELL);

export function useShell(): Shell {
  return useContext(ShellContext);
}
