import { useCallback, useEffect, useState } from 'react';
import type { Chat } from '@/lib/chats';
import { overview } from '@/lib/dashboard';
import { rpc } from '@/lib/rpc';
import { loadSettings } from '@/lib/settings';
import type { Mod, Settings } from '@/lib/types';
import { SettingsView } from '../sidepanel/SettingsView';
import { ThemeToggle } from '../sidepanel/components/ThemeToggle';
import { ChatsSection } from './ChatsSection';
import { ModsSection } from './ModsSection';

type Section = 'chats' | 'mods' | 'settings';

/** The section named in the URL fragment, so a dashboard tab can be deep-linked and reloaded in place. */
function sectionFromHash(): Section {
  const h = location.hash.replace(/^#/, '');
  return h === 'mods' || h === 'settings' ? h : 'chats';
}

export function Dashboard() {
  const [section, setSection] = useState<Section>(sectionFromHash);
  const [chats, setChats] = useState<Chat[]>([]);
  const [mods, setMods] = useState<Mod[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [usStatus, setUsStatus] = useState<{ available: boolean; message: string } | null>(null);
  const [error, setError] = useState('');
  /** False until the first load has landed, so the page does not flash "no chats yet" at someone who has plenty. */
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [c, m] = await Promise.all([rpc({ type: 'chats.listAll' }), rpc({ type: 'mods.list' })]);
      setChats(c);
      setMods(m);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    void loadSettings().then(setSettings);
    void rpc({ type: 'userScripts.status' }).then(setUsStatus).catch(() => {});
  }, [refresh]);

  // Stay live while the side panel works: anything it changes lands in chrome.storage.local, and
  // both the chat index and the mod list are single keys there. Settings too, so the overview's
  // provider line does not go stale after a change in the Settings section.
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if ('chats' in changes || 'mods' in changes) void refresh();
      if ('settings' in changes) void loadSettings().then(setSettings);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function go(next: Section) {
    setSection(next);
    // replaceState rather than assigning location.hash: this should not stack up history entries
    // the back button has to walk through to leave the page.
    history.replaceState(null, '', next === 'chats' ? location.pathname : `#${next}`);
  }

  const o = overview(mods, chats);

  return (
    <div className="dash">
      <div className="dash-inner">
        <header className="dash-head">
          <h1>
            <img className="brand-mark" src="/icon/128.png" alt="" width={32} height={32} />
            usermods
          </h1>
          <span className="sub">every chat and every mod, in one place</span>
          <ThemeToggle />
        </header>

        <div className="overview" data-testid="overview">
          <Stat n={`${o.modsEnabled}/${o.modsTotal}`} k="mods enabled" />
          <Stat n={String(o.chatsLive)} k="chats live" />
          <Stat n={String(o.chatsArchived)} k="chats archived" />
          <Stat n={String(o.sitesCustomised)} k="sites customised" />
        </div>

        <div className="overview-notes">
          <span>
            <span className={`dot ${usStatus ? (usStatus.available ? 'ok' : 'bad') : ''}`} />
            {usStatus ? (usStatus.available ? 'User scripts allowed' : 'User scripts blocked') : 'Checking user scripts'}
          </span>
          <span className="sep">·</span>
          <span>
            {settings ? (
              <>
                {providerLabel(settings)} · <span className="muted">{settings.model || 'no model set'}</span>
              </>
            ) : (
              <span className="muted">reading settings</span>
            )}
          </span>
          <span className="sep">·</span>
          <button className="linklike" onClick={() => go('settings')}>
            Settings
          </button>
        </div>

        {usStatus && !usStatus.available && <div className="notice" style={{ marginBottom: 16 }}>{usStatus.message}</div>}
        {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

        <nav className="dash-tabs">
          <button className={section === 'chats' ? 'active' : ''} onClick={() => go('chats')}>
            Chats
          </button>
          <button className={section === 'mods' ? 'active' : ''} onClick={() => go('mods')}>
            Mods
          </button>
          <button className={section === 'settings' ? 'active' : ''} onClick={() => go('settings')}>
            Settings
          </button>
        </nav>

        {section === 'chats' && <ChatsSection chats={chats} loaded={loaded} onChanged={refresh} />}
        {section === 'mods' && <ModsSection mods={mods} loaded={loaded} onChanged={refresh} />}
        {/* The panel's own Settings view, unchanged: it reads and writes lib/settings, which is the
            same storage this page reads, so the overview above follows a change made here. */}
        {section === 'settings' && (
          <div className="install-col">
            <SettingsView />
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ n, k }: { n: string; k: string }) {
  return (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="k">{k}</div>
    </div>
  );
}

function providerLabel(s: Settings): string {
  switch (s.provider) {
    case 'anthropic':
      return 'Anthropic';
    case 'openai-compatible':
      return s.baseUrl ? hostOf(s.baseUrl) : 'OpenAI-compatible';
    case 'chatgpt':
      return 'ChatGPT subscription';
    case 'xai':
      return 'xAI subscription';
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
