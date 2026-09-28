import { useCallback, useEffect, useState } from 'react';
import type { Chat } from '@/lib/chats';
import { chatOpenUrl, HANDOFF_KEY, modOrigins, overview, type ChatHandoff } from '@/lib/dashboard';
import { rpc } from '@/lib/rpc';
import { isConnected } from '@/lib/connections';
import type { Mod } from '@/lib/types';
import { useConnections } from '../sidepanel/useConnections';
import { useUpdates } from '../sidepanel/useUpdates';
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
  /** Mods with a newer version waiting for review: the badge on the Mods tab. */
  const { count: updateCount } = useUpdates();
  /**
   * Which chat each saved mod came from, for the Mods list's "from chat" line.
   *
   * It is built here rather than in ModsSection because it needs both halves — the chat index and
   * the artifacts — and this is the component that already holds the chats. Only chats carrying an
   * artifactId are read, so a profile of 200 chats with three drafts costs three storage reads
   * rather than 200.
   */
  const [origins, setOrigins] = useState<Map<string, { chat: Chat; versions: number }>>(new Map());
  const providers = useConnections();
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
      const withDrafts = c.filter((chat) => chat.artifactId);
      const artifacts = await Promise.all(
        withDrafts.map(async (chat) => ({
          chat,
          // A draft that will not load is simply a mod with no origin line, not a failed refresh.
          artifact: await rpc({ type: 'artifact.get', chatId: chat.id }).catch(() => null),
        })),
      );
      setOrigins(modOrigins(artifacts.map(({ chat, artifact }) => ({ chat, linkedModId: artifact?.linkedModId, versions: artifact?.versions.length ?? 0 }))));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
    void rpc({ type: 'userScripts.status' }).then(setUsStatus).catch(() => {});
  }, [refresh]);

  /**
   * Open a chat on its page with the side panel pointed at it — the same handoff the Chats list's
   * Open uses, lifted here so the Mods list's "from chat" link can do it too.
   *
   * sidePanel.open must be called synchronously inside the gesture, before any await, or the
   * gesture is gone by the time the promise resolves. See the longer note on ChatsSection.openChat.
   */
  const openChat = useCallback((chat: Chat) => {
    try {
      const p = chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* not a gesture any more: the tab still opens and the panel restores this chat when opened */
    }
    void (async () => {
      const handoff: ChatHandoff = { chatId: chat.id, host: chat.host, at: Date.now() };
      await chrome.storage.session.set({ [HANDOFF_KEY]: handoff }).catch(() => {});
      await chrome.tabs.create({ url: chatOpenUrl(chat), active: true }).catch(() => {});
    })();
  }, []);

  /**
   * Bring a mod into a chat and open that chat on its page — the dashboard's "Edit in chat".
   *
   * It is `openChat` with one step in front of it: the background decides WHICH chat (rpc
   * 'mods.edit', the same decision the side panel's mod rows, empty state, picker and the open_mod
   * tool all go through), and then the existing handoff carries the user there. Nothing about the
   * handoff is duplicated here, which is why "Open" and "Edit in chat" cannot drift apart.
   *
   * sidePanel.open must be called synchronously inside the gesture, and the RPC is an await — so
   * the panel is opened FIRST, before we know which chat it will show. That is safe: the handoff is
   * written before the tab navigates, and the panel reads it when it mounts on that host.
   */
  const editMod = useCallback(
    (mod: Mod) => {
      try {
        const p = chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch {
        /* not a gesture any more: the tab still opens and the panel restores this chat when opened */
      }
      void (async () => {
        try {
          const r = await rpc({ type: 'mods.edit', modId: mod.id, host: '' });
          const handoff: ChatHandoff = { chatId: r.chatId, host: r.host, at: Date.now() };
          await chrome.storage.session.set({ [HANDOFF_KEY]: handoff }).catch(() => {});
          const url = r.likelyUrl || (r.host ? `https://${r.host}` : '');
          if (url) await chrome.tabs.create({ url, active: true }).catch(() => {});
          await refresh();
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        }
      })();
    },
    [refresh],
  );

  // Stay live while the side panel works: anything it changes lands in chrome.storage.local, and
  // both the chat index and the mod list are single keys there. (The overview's provider line keeps
  // itself current: useConnections listens to storage on its own.)
  useEffect(() => {
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      if ('chats' in changes || 'mods' in changes) void refresh();
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
  const connectedLabels = providers.state.list.filter((c) => isConnected(c, providers.signedIn)).map((c) => c.label);

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
            {providers.ready ? (
              <span data-testid="overview-providers">{providersLine(connectedLabels)}</span>
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
            {updateCount > 0 && (
              <span className="tab-badge" data-testid="mods-update-badge" aria-label={`, ${updateCount} update${updateCount === 1 ? '' : 's'} available`}>
                {updateCount}
              </span>
            )}
          </button>
          <button className={section === 'settings' ? 'active' : ''} onClick={() => go('settings')}>
            Settings
          </button>
        </nav>

        {section === 'chats' && <ChatsSection chats={chats} loaded={loaded} onChanged={refresh} />}
        {section === 'mods' && <ModsSection mods={mods} loaded={loaded} onChanged={refresh} origins={origins} onOpenChat={openChat} onEditMod={editMod} />}
        {/* The panel's own Settings view, unchanged: it reads and writes lib/settings, which is the
            same storage this page reads, so the overview above follows a change made here. */}
        {section === 'settings' && (
          <div className="install-col">
            <SettingsView />
          </div>
        )}

        <StyleGuideLink />
      </div>
    </div>
  );
}

/**
 * The way into the living specimen (entrypoints/styleguide), which documents the design system.
 *
 * It is unlisted on purpose: it is a contributor's tool, not a product surface, so it appears only
 * in a dev build or when someone asks for it with ?styleguide=1. The page itself always ships —
 * a specimen kept out of the bundle is a specimen that silently goes stale.
 */
function StyleGuideLink() {
  const asked =
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('styleguide');
  if (!import.meta.env.DEV && !asked) return null;
  return (
    <footer className="dash-footer">
      <a href="/styleguide.html">Design system — the living style guide</a>
    </footer>
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

/** The overview's provider line: who is connected, by name while that is short enough to read. */
function providersLine(labels: string[]): string {
  if (!labels.length) return 'No provider connected';
  if (labels.length <= 2) return `${labels.join(' and ')} connected`;
  return `${labels.length} providers connected`;
}
