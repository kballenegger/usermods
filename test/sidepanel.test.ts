// The side panel's scope: on the tab you opened it from, or on every tab in the window.
//   npm test
//
// Everything asserted here is a pure decision from lib/sidepanel.ts. The browser half — that Chrome
// really does keep a tab-specific panel off the other tabs, and that a per-tab panel survives the
// tab navigating — is covered by `npm run smoke:panelscope`.
import assert from 'node:assert/strict';
import test from 'node:test';
import { actionClickPlan, openChatPlan, PANEL_PATH, resolveScope, windowPanelPlan } from '../lib/sidepanel.ts';
import { DEFAULT_SETTINGS } from '../lib/types.ts';

// ---------- which scope a stored profile runs under ----------

test('a profile that stored nothing gets tab scope — new install and old alike', () => {
  // Deliberately unlike the theme, which pins old profiles to the old default: per-tab is the fix
  // the owner asked for, so an existing profile gets it too rather than keeping the old behaviour.
  assert.equal(resolveScope(undefined), 'tab');
  assert.equal(resolveScope(null), 'tab');
  assert.equal(resolveScope({}), 'tab');
  assert.equal(resolveScope({ provider: 'anthropic', theme: 'dark' }), 'tab');
  assert.equal(DEFAULT_SETTINGS.sidePanelScope, 'tab');
});

test('only an explicit "window" opts back into the panel that follows you everywhere', () => {
  assert.equal(resolveScope({ sidePanelScope: 'window' }), 'window');
  assert.equal(resolveScope({ sidePanelScope: 'tab' }), 'tab');
});

test('a stored value outside the two choices falls back to tab, not to no panel at all', () => {
  assert.equal(resolveScope({ sidePanelScope: 'everywhere' } as never), 'tab');
  assert.equal(resolveScope({ sidePanelScope: null } as never), 'tab');
  assert.equal(resolveScope({ sidePanelScope: '' } as never), 'tab');
});

// ---------- the window-level configuration ----------

test('tab scope disables the window-level panel, which is what keeps it off every other tab', () => {
  // A tab with no options of its own inherits the window default. Disabled there means no panel
  // anywhere except the tabs that asked for one.
  const plan = windowPanelPlan('tab');
  assert.equal(plan.options.enabled, false);
  assert.equal(plan.options.path, PANEL_PATH);
});

test('tab scope also turns off openPanelOnActionClick, or the icon would open the window panel', () => {
  // openPanelOnActionClick binds the icon to the WINDOW panel and suppresses action.onClicked, so
  // leaving it on would both defeat the fix and stop the per-tab listener ever running.
  assert.equal(windowPanelPlan('tab').openPanelOnActionClick, false);
});

test('window scope restores exactly what usermods did before the setting existed', () => {
  const plan = windowPanelPlan('window');
  assert.deepEqual(plan, { options: { path: PANEL_PATH, enabled: true }, openPanelOnActionClick: true });
});

// ---------- the toolbar click, under tab scope ----------

test('a toolbar click configures the clicked tab and then opens it, in that order', () => {
  const plan = actionClickPlan('tab', 42);
  assert.deepEqual(plan.setOptions, { tabId: 42, path: PANEL_PATH, enabled: true });
  assert.deepEqual(plan.open, { tabId: 42 });
});

test('the click never names a tab other than the one clicked', () => {
  assert.equal(actionClickPlan('tab', 7).open?.tabId, 7);
  assert.equal(actionClickPlan('tab', 7).setOptions?.tabId, 7);
});

test('under window scope the listener does nothing: Chrome opens the panel itself', () => {
  const plan = actionClickPlan('window', 42);
  assert.equal(plan.setOptions, null);
  assert.equal(plan.open, null);
});

test('a click Chrome could not attribute to a tab opens nothing rather than guessing', () => {
  assert.deepEqual(actionClickPlan('tab', undefined), { setOptions: null, open: null });
});

// ---------- the dashboard's Open button ----------

test('tab scope opens the panel on the dashboard tab and navigates that same tab', () => {
  // The whole point of (c): the tab keeps its id across the navigation, so the panel opened inside
  // the click's gesture ends up attached to the tab the site loads in.
  const plan = openChatPlan('tab', 99, false);
  assert.deepEqual(plan.tabPanel, { tabId: 99 });
  assert.equal(plan.windowPanel, false);
  assert.equal(plan.navigation, 'navigate');
});

test('tab scope never falls back to the window panel, which would flash onto every tab', () => {
  for (const tabId of [99, undefined]) {
    assert.equal(openChatPlan('tab', tabId, false).windowPanel, false, `tabId=${tabId}`);
    assert.equal(openChatPlan('tab', tabId, true).windowPanel, false, `tabId=${tabId}, newTab`);
  }
});

test('"Open in new tab" keeps the dashboard where it is and attaches no panel', () => {
  const plan = openChatPlan('tab', 99, true);
  assert.equal(plan.tabPanel, null);
  assert.equal(plan.navigation, 'create');
});

test('a dashboard that cannot name its own tab still opens the page, in a new tab', () => {
  const plan = openChatPlan('tab', undefined, false);
  assert.equal(plan.tabPanel, null);
  assert.equal(plan.navigation, 'create');
});

test('window scope keeps the old shape: a window-level open and a brand new tab', () => {
  assert.deepEqual(openChatPlan('window', 99, false), { tabPanel: null, windowPanel: true, navigation: 'create' });
  assert.deepEqual(openChatPlan('window', 99, true), { tabPanel: null, windowPanel: true, navigation: 'create' });
});
