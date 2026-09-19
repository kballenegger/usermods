import { useEffect, useState } from 'react';
import { hostFromUrl } from '@/lib/chats';
import { hasConsented } from '@/lib/consent';
import { rpc } from '@/lib/rpc';
import { Chat } from './Chat';
import { DashboardIcon, SettingsIcon } from './components/icons';
import { ThemeToggle } from './components/ThemeToggle';
import { Consent } from './Consent';
import { ModsView } from './ModsView';
import { SettingsView } from './SettingsView';

type Tab = 'chat' | 'mods' | 'settings';

/**
 * Show the dashboard, reusing the tab it is already in rather than stacking up copies of a page
 * there is only ever one useful instance of. The lookup is by URL prefix, not exact match, so a tab
 * sitting on #mods or #settings still counts as "the dashboard tab".
 */
export async function openDashboard(): Promise<void> {
  const url = chrome.runtime.getURL('dashboard.html');
  try {
    const open = await chrome.tabs.query({ url: `${url}*` });
    const existing = open[0];
    if (existing?.id != null) {
      await chrome.tabs.update(existing.id, { active: true });
      if (existing.windowId != null) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
      return;
    }
  } catch {
    // The query failed (no tabs permission in some future build, say); opening a new tab still works.
  }
  await chrome.tabs.create({ url });
}

export function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState('');
  const [usStatus, setUsStatus] = useState<{ available: boolean; message: string } | null>(null);
  /** null while the flag is still being read, so the panel never flashes the notice at someone who accepted it. */
  const [consented, setConsented] = useState<boolean | null>(null);
  /** Set when Settings asks to show the notice again, for someone who has already accepted it. */
  const [reviewing, setReviewing] = useState(false);

  // Track the active tab in this window so every action targets the page the user is looking at.
  useEffect(() => {
    const refresh = async () => {
      const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (t?.id != null) {
        setTabId(t.id);
        setPageUrl(t.url ?? '');
      }
    };
    void refresh();
    const onActivated = () => void refresh();
    const onUpdated = (_id: number, info: chrome.tabs.OnUpdatedInfo) => {
      if (info.url || info.status === 'complete') void refresh();
    };
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onUpdated.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated.removeListener(onActivated);
      chrome.tabs.onUpdated.removeListener(onUpdated);
    };
  }, []);

  useEffect(() => {
    void hasConsented().then(setConsented);
  }, []);

  useEffect(() => {
    const check = () => rpc({ type: 'userScripts.status' }).then(setUsStatus).catch(() => {});
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const host = hostFromUrl(pageUrl);
  // The notice stands in for the chat until it is acknowledged, so no message can be sent before it
  // has been read. Mods and Settings stay reachable: neither sends anything to a model.
  const gateChat = consented === false || reviewing;

  return (
    <div className="app">
      {/*
        The bar is two groups with the host between them.

        Left: the two screens you move between while working — Chat and Mods — as tabs, because
        that is what they are. Right: the controls you reach for occasionally. Settings is still a
        view of this panel — it carries `aria-current="page"` and the same volt active treatment the
        tabs do — it has simply stopped competing with Chat and Mods for the left edge; Dashboard
        leaves the panel, so it is a plain button; the theme toggle is a preference. All three are
        one family: same box, same spacing, same hover.

        Below the container breakpoint (see .tabs in styles.css) Settings and Dashboard drop their
        labels and become their icons alone. The labels stay in the DOM as the accessible name —
        visually hidden, not display:none — and both carry an explicit aria-label and title so the
        icon-only state is never a mystery.
      */}
      <nav className="tabs">
        <div className="tab-group">
          <button type="button" data-view="chat" aria-current={tab === 'chat' ? 'page' : undefined} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>Chat</button>
          <button type="button" data-view="mods" aria-current={tab === 'mods' ? 'page' : undefined} className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}>Mods</button>
        </div>
        {/* The page in view. A volt dot means a real page the panel can act on. It takes the slack
            between the groups and only truncates when the panel is genuinely too narrow. */}
        <span className="status" title={pageUrl || host}>
          {host && <span className="dot" aria-hidden="true" />}
          <span className="status-host">{host}</span>
        </span>
        <div className="tab-group actions">
          <button
            type="button"
            className={`tab-action${tab === 'settings' ? ' active' : ''}`}
            data-view="settings"
            data-action="settings"
            aria-current={tab === 'settings' ? 'page' : undefined}
            aria-label="Settings"
            title="Settings"
            onClick={() => setTab('settings')}
          >
            <SettingsIcon />
            <span className="tab-action-label">Settings</span>
          </button>
          <button
            type="button"
            className="tab-action"
            data-action="dashboard"
            aria-label="Dashboard"
            title="Open the dashboard: every chat and every mod, in a full tab"
            onClick={() => void openDashboard()}
          >
            <DashboardIcon />
            <span className="tab-action-label">Dashboard</span>
          </button>
          <ThemeToggle />
        </div>
      </nav>
      {usStatus && !usStatus.available && <div className="notice">{usStatus.message}</div>}
      {tab === 'chat' &&
        (consented === null ? (
          <div className="view muted">loading…</div>
        ) : gateChat ? (
          <Consent
            onAccept={() => {
              setConsented(true);
              setReviewing(false);
            }}
            onDismiss={consented ? () => setReviewing(false) : undefined}
          />
        ) : (
          <Chat tabId={tabId} pageUrl={pageUrl} host={host} />
        ))}
      {/* "Edit in chat" on a mod row is a move between the two tabs, so the Mods view asks to be
          taken there rather than reaching into the Chat view: the chat it should land on is named
          by a session-storage handoff (the same one the dashboard writes), which Chat reads when it
          mounts on that host. */}
      {tab === 'mods' && <ModsView tabId={tabId} pageUrl={pageUrl} host={host} onEditInChat={() => setTab('chat')} />}
      {tab === 'settings' && (
        <SettingsView
          onReviewNotice={() => {
            setReviewing(true);
            setTab('chat');
          }}
        />
      )}
    </div>
  );
}
