import { useEffect, useState } from 'react';
import { hostFromUrl } from '@/lib/chats';
import { hasConsented } from '@/lib/consent';
import { rpc } from '@/lib/rpc';
import { Chat } from './Chat';
import { ThemeToggle } from './components/ThemeToggle';
import { Consent } from './Consent';
import { ModsView } from './ModsView';
import { SettingsView } from './SettingsView';

type Tab = 'chat' | 'mods' | 'settings';

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
      <nav className="tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>Chat</button>
        <button className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}>Mods</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
        <span className="spacer" />
        {/* The page in view. A volt dot means a real page the panel can act on. */}
        {host && <span className="dot" aria-hidden="true" />}
        <span className="status" title={pageUrl}>{host}</span>
        <ThemeToggle />
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
      {tab === 'mods' && <ModsView tabId={tabId} pageUrl={pageUrl} />}
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
