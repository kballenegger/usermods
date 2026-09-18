import { useEffect, useState } from 'react';
import { rpc } from '@/lib/rpc';
import { Chat } from './Chat';
import { ModsView } from './ModsView';
import { SettingsView } from './SettingsView';

type Tab = 'chat' | 'mods' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('chat');
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState('');
  const [usStatus, setUsStatus] = useState<{ available: boolean; message: string } | null>(null);

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
    const check = () => rpc({ type: 'userScripts.status' }).then(setUsStatus).catch(() => {});
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  let host = '';
  try {
    host = pageUrl ? new URL(pageUrl).hostname : '';
  } catch {
    /* chrome:// etc */
  }

  return (
    <div className="app">
      <nav className="tabs">
        <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>Chat</button>
        <button className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}>Mods</button>
        <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
        <span className="spacer" />
        <span className="status" title={pageUrl}>{host}</span>
      </nav>
      {usStatus && !usStatus.available && <div className="notice">{usStatus.message}</div>}
      {tab === 'chat' && <Chat tabId={tabId} pageUrl={pageUrl} />}
      {tab === 'mods' && <ModsView tabId={tabId} pageUrl={pageUrl} />}
      {tab === 'settings' && <SettingsView />}
    </div>
  );
}
