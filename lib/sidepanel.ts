/**
 * Where the side panel opens: on the one tab you opened it from, or on every tab in the window.
 *
 * Chrome models the side panel in two layers (see
 * https://developer.chrome.com/docs/extensions/reference/api/sidePanel):
 *
 *  - a WINDOW-level panel, configured by `setOptions({path, enabled})` with no tabId — "the default
 *    behavior (used for any tab that doesn't have specific settings)". Once open it stays open as
 *    you move between tabs, which is the behaviour usermods shipped with and what this module
 *    exists to make optional;
 *  - a TAB-specific panel, configured by `setOptions({tabId, path, enabled})` — options that "only
 *    apply to the tab with this id", overriding the window default. `open({tabId})` opens it, and
 *    Chrome hides it whenever another tab is in front: "If the user temporarily switches to a tab
 *    where the side panel is not enabled, the side panel will be hidden. It will automatically show
 *    again when the user switches to a tab where it was previously open."
 *
 * Tab scope therefore needs BOTH halves: per-tab options on the tab being opened, and the window
 * default turned OFF. Leaving the window default enabled would put a panel on every other tab too,
 * which is exactly what the user asked to stop.
 *
 * Everything here is a pure decision, taking the setting and returning the calls to make, so the
 * rules are tested in node (test/sidepanel.test.ts) rather than only in a browser.
 */
import type { Settings, SidePanelScope } from './types';

/** The panel document. One constant so no call site can configure a path that does not exist. */
export const PANEL_PATH = 'sidepanel.html';

/**
 * Does this browser have a side panel at all?
 *
 * Safari has none, and the extension is built for both: sidepanel.html is not even packaged in the
 * Safari build (see the note in entrypoints/sidepanel/index.html). Every side-panel call therefore
 * has to ask first. `chrome.sidePanel` is simply absent there, so reading a method off it throws a
 * TypeError, and a TypeError at the top of a user gesture takes the rest of the handler with it.
 *
 * What replaces the panel on Safari is the popup, and the chat handoff both surfaces read is written
 * either way, so the calls this guards are skipped, not substituted for.
 */
export function sidePanelAvailable(): boolean {
  return typeof chrome !== 'undefined' && typeof (chrome as { sidePanel?: unknown }).sidePanel !== 'undefined';
}

/**
 * Which scope a stored profile runs under.
 *
 * Unlike the theme, an existing profile is NOT pinned to the old behaviour: per-tab is what the
 * owner asked for, and a panel that stops following you between tabs is the fix, not a surprise.
 * So a profile with no stored value — new install or old — reads as 'tab', and only an explicit
 * 'window' opts back into the window-wide panel. An unrecognised stored value (hand-edited storage,
 * a future build's setting read by an older one) falls back to the default rather than disabling
 * the panel outright.
 */
export function resolveScope(stored: Partial<Settings> | null | undefined): SidePanelScope {
  return stored?.sidePanelScope === 'window' ? 'window' : 'tab';
}

/** What the background should have configured for the WINDOW-level panel, given the scope. */
export interface WindowPanelPlan {
  /** `setOptions({path, enabled})` with no tabId. */
  options: { path: string; enabled: boolean };
  /** `setPanelBehavior({openPanelOnActionClick})`. */
  openPanelOnActionClick: boolean;
}

/**
 * The window-level configuration for a scope.
 *
 * 'window' restores what usermods did before this setting existed: the window panel enabled and
 * `openPanelOnActionClick` on, so Chrome itself opens the panel when the toolbar icon is clicked
 * and the extension needs no onClicked listener at all.
 *
 * 'tab' turns both off. `openPanelOnActionClick` opens the WINDOW-level panel, so it has to go —
 * with it on, Chrome would open the window panel on the icon click and the extension's own
 * `onClicked` listener would never run (Chrome does not fire onClicked when the click is bound to
 * the panel). The path is still set alongside `enabled: false` so that flipping the setting back to
 * 'window' is a single enable, and so the manifest-less default never points at nothing.
 */
export function windowPanelPlan(scope: SidePanelScope): WindowPanelPlan {
  const windowWide = scope === 'window';
  return {
    options: { path: PANEL_PATH, enabled: windowWide },
    openPanelOnActionClick: windowWide,
  };
}

/**
 * What to do when the toolbar icon is clicked, under tab scope.
 *
 * Both calls have to happen inside the click's own gesture — `open()` "may only be called in
 * response to a user action" — and `setOptions` must come first so the tab has a panel to open.
 * Returning the plan rather than making the calls keeps the ordering testable.
 *
 * There is no close(): the API exposes no way to close a panel it opened, so a second click cannot
 * toggle it shut. The user closes the panel with its own X. Nothing here pretends otherwise — a
 * fake close (disabling the tab's options) would make the panel vanish but also make the NEXT click
 * a no-op until the options were restored, which is worse than one honest direction.
 */
export function actionClickPlan(scope: SidePanelScope, tabId: number | undefined): {
  setOptions: { tabId: number; path: string; enabled: boolean } | null;
  open: { tabId: number } | null;
} {
  // Window scope is handled by Chrome itself through openPanelOnActionClick, so onClicked does not
  // even fire; a tabless click (no tab id, which Chrome does deliver on some internal pages) has
  // nothing to attach a panel to.
  if (scope !== 'tab' || tabId == null) return { setOptions: null, open: null };
  return {
    setOptions: { tabId, path: PANEL_PATH, enabled: true },
    open: { tabId },
  };
}

/**
 * How the dashboard's "Open with sidebar" should reach the chat's page, per scope.
 *
 * The constraint that shapes this: `sidePanel.open()` needs a user gesture, and the tab the chat is
 * going to live in does not exist at click time. Three ways out were considered, and the browser
 * flow (scripts/screenshots.mjs --panelscope) exercises the one chosen:
 *
 *  (a) create the tab and open the panel in the create callback — the new tab's id would be right,
 *      but it stakes the feature on a gesture surviving an async hop, which is not something the
 *      docs promise;
 *  (b) open the WINDOW panel synchronously as before, then re-scope it to the new tab afterwards —
 *      that flashes a window-wide panel onto every tab for as long as the re-scope takes, which is
 *      the bug being fixed;
 *  (c) open a TAB-specific panel on the dashboard's own tab synchronously, then navigate that same
 *      tab to the chat's page. A tab keeps its id across navigation, and per-tab panel options ride
 *      along with it — measured, not assumed: the probe behind this shows getOptions({tabId}) still
 *      reporting `enabled: true` for that id after the tab has gone from dashboard.html to a live
 *      website, with the panel still open.
 *
 * (c) wins: the panel is attached to a real tab inside the real gesture, no other tab is ever
 * touched, and reusing the dashboard tab means "open this chat" costs no extra tab. The dashboard
 * stays reachable — it is the options page, one click from the toolbar icon, and the Open button
 * has "Open in new tab" beside it for keeping the dashboard where it is.
 *
 * Window scope keeps the old shape exactly: a window-level open and a new tab.
 */
export function openChatPlan(scope: SidePanelScope, dashboardTabId: number | undefined, newTab: boolean): {
  /** Per-tab options + open, on the tab named here. Null when the window panel is used instead. */
  tabPanel: { tabId: number } | null;
  /** Open the window-level panel. */
  windowPanel: boolean;
  /** 'navigate' reuses the dashboard's tab; 'create' makes a new one. */
  navigation: 'navigate' | 'create';
} {
  // "Open in new tab", or window scope, or a dashboard that cannot name its own tab: no per-tab
  // panel to attach, so fall back to the window panel the old code used. Under tab scope the window
  // panel is disabled, so that open is a no-op rather than a panel on every tab — the handoff is
  // still written, and the panel the user opens by hand on the new tab picks the chat up.
  if (scope !== 'tab' || dashboardTabId == null || newTab) {
    return { tabPanel: null, windowPanel: scope === 'window', navigation: 'create' };
  }
  return { tabPanel: { tabId: dashboardTabId }, windowPanel: false, navigation: 'navigate' };
}
