import { useEffect, useMemo, useRef, useState } from 'react';
import { hostFromUrl } from '@/lib/chats';
import { tabletPopupSize } from '@/lib/compactshell';
import { hasConsented } from '@/lib/consent';
import { keyboardInset, popupLayout, targetChip } from '@/lib/mobile';
import { rpc } from '@/lib/rpc';
import { Chat } from './Chat';
import { BackIcon, DashboardIcon, MenuIcon, SettingsIcon } from './components/icons';
import { Sheet, SheetRow } from './components/Sheet';
import { ThemeToggle } from './components/ThemeToggle';
import { Consent } from './Consent';
import { ModsView } from './ModsView';
import { SettingsView } from './SettingsView';
import { PANEL_SHELL, ShellContext, type Shell } from './shell';
import { usePointerEnvironment } from './usePointer';
import { useUpdates } from './useUpdates';

type Tab = 'chat' | 'mods' | 'settings';

/**
 * Which shell the same three views are wearing.
 *
 * 'panel' is Chrome's side panel: a tall column beside a page you can still see, driven by a mouse.
 * 'popup' is Safari's toolbar popup, which on iPhone is a sheet covering the whole screen driven by
 * a thumb, and on a Mac a small window hanging off the toolbar driven by a mouse. They share every
 * view and all the provider logic; what differs is the chrome around them, and that difference is
 * real enough that faking one with the other would be worse than having two.
 *
 * The popup's own two shapes are one shell with a `data-layout` of 'compact' or 'roomy' (see
 * popupLayout in lib/mobile.ts), because there the difference really is only sizes and where the
 * navigation sits.
 */
export type Surface = 'panel' | 'popup';

export interface AppProps {
  surface?: Surface;
}

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

export function App({ surface = 'panel' }: AppProps = {}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [tabId, setTabId] = useState<number | null>(null);
  const [pageUrl, setPageUrl] = useState('');
  const [usStatus, setUsStatus] = useState<{ available: boolean; message: string } | null>(null);
  /** null while the flag is still being read, so the panel never flashes the notice at someone who accepted it. */
  const [consented, setConsented] = useState<boolean | null>(null);
  /** Set when Settings asks to show the notice again, for someone who has already accepted it. */
  const [reviewing, setReviewing] = useState(false);
  /** Mods with a newer version waiting for review: the badge on Mods. Nothing installs by itself. */
  const { count: updateCount } = useUpdates();
  const pointer = usePointerEnvironment();
  const layout = popupLayout(pointer);
  /** The content-first shell: the Safari popup under a thumb. Never the panel, never the Mac. */
  const compact = surface === 'popup' && layout === 'compact';
  /** The compact top bar's slot and the sheets' portal target, as state so their users re-render. */
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  const [sheetHost, setSheetHost] = useState<HTMLElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const shell = useMemo<Shell>(() => (compact ? { compact, barSlot, sheetHost } : PANEL_SHELL), [compact, barSlot, sheetHost]);

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

  /**
   * Keep the popup out from under the on-screen keyboard.
   *
   * iOS shrinks the visual viewport instead of resizing the window, so without this the composer
   * and the bottom navigation sit behind the keyboard the moment a field takes focus. The measured
   * inset goes on the root as a custom property; mobile.css adds it to the popup's bottom padding.
   * lib/mobile.ts holds the arithmetic, and test/mobile.test.ts holds the cases.
   */
  useEffect(() => {
    // Only the phone sheet. A Mac popup is a fixed window with no on-screen keyboard to dodge.
    if (surface !== 'popup' || layout !== 'compact') return;
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      const inset = keyboardInset({ height: vv.height, offsetTop: vv.offsetTop }, window.innerHeight);
      document.documentElement.style.setProperty('--keyboard-inset', `${inset}px`);
      // With the keyboard up the home indicator is underneath it, so the composer must stop
      // padding itself clear of one: env(safe-area-inset-bottom) does not go to zero by itself.
      document.documentElement.toggleAttribute('data-keyboard', inset > 0);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      document.documentElement.style.removeProperty('--keyboard-inset');
      document.documentElement.removeAttribute('data-keyboard');
    };
  }, [surface, layout]);

  /**
   * On an iPad, let the document adopt the viewport the system settled on.
   *
   * popup-size.css gives the iPad popover a size before anything runs, because Safari sizes that
   * popover from the document. This is the second half: once there is a real viewport, fit it, so
   * a popover Safari clamped shorter keeps its composer on screen and an iPad that presents the
   * popup as a sheet (Split View, Slide Over) is filled rather than overflowed. The arithmetic,
   * and why it cannot collapse the popover again, is tabletPopupSize in lib/compactshell.ts.
   */
  useEffect(() => {
    if (!compact || !pointer.tablet) return;
    const root = document.documentElement;
    const box = root.getBoundingClientRect();
    let size = { width: Math.round(box.width), height: Math.round(box.height) };
    const apply = () => {
      const next = tabletPopupSize({ width: window.innerWidth, height: window.innerHeight }, size);
      if (next.width === size.width && next.height === size.height) return;
      size = next;
      root.style.setProperty('--tablet-w', `${next.width}px`);
      root.style.setProperty('--tablet-h', `${next.height}px`);
    };
    apply();
    window.addEventListener('resize', apply);
    return () => {
      window.removeEventListener('resize', apply);
      root.style.removeProperty('--tablet-w');
      root.style.removeProperty('--tablet-h');
    };
  }, [compact, pointer.tablet]);

  useEffect(() => {
    const check = () => rpc({ type: 'userScripts.status' }).then(setUsStatus).catch(() => {});
    void check();
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  const host = hostFromUrl(pageUrl);
  const target = targetChip(pageUrl);
  // The notice stands in for the chat until it is acknowledged, so no message can be sent before it
  // has been read. Mods and Settings stay reachable: neither sends anything to a model.
  const gateChat = consented === false || reviewing;

  const views = (
    <>
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
          <Chat tabId={tabId} pageUrl={pageUrl} host={host} onOpenSettings={() => setTab('settings')} />
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
    </>
  );

  if (surface === 'popup') {
    /*
      Three destinations. On a phone they sit at the bottom, the platform convention and the only
      part of the screen a thumb reaches without a grip change, each a full-width target well over
      the 44px Apple asks for. On a Mac the popup is a small window under the pointer, nothing is
      out of reach, and a row of buttons hanging off the bottom edge of a 380px window looks like a
      phone someone shrank. So the same nav moves under the header there.

      It moves in the DOM rather than with CSS `order`, so that tabbing through the popup follows
      what is on screen.
    */
    const nav = (
      <nav className="tabs popup-nav" aria-label="usermods">
        <button type="button" data-view="chat" aria-current={tab === 'chat' ? 'page' : undefined} className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>Chat</button>
        <button type="button" data-view="mods" aria-current={tab === 'mods' ? 'page' : undefined} className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}>
          Mods
          {updateCount > 0 && (
            <span className="tab-badge" data-testid="mods-update-badge" aria-label={`, ${updateCount} update${updateCount === 1 ? '' : 's'} available`}>
              {updateCount}
            </span>
          )}
        </button>
        <button type="button" data-view="settings" aria-current={tab === 'settings' ? 'page' : undefined} className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>Settings</button>
      </nav>
    );

    /*
      The compact shell (iPhone, iPad): content first.

      The owner's report from a real iPhone was that the chat could not be seen for everything
      stacked around it, and the two rows this shell used to contribute were the worst of it for
      what they did: a header naming the page, and a permanent three-way navigation under the
      composer. Both are now one 44px bar. On the chat view the bar is the chat's own (Chat fills
      the slot with the site, the chat's title and its model); on Mods and Settings it is a back
      button and the view's name. Navigation, the dashboard and the theme are behind the menu
      button, because on a phone you change view a few times a session and read the transcript the
      whole time. There is no bottom bar at all: with the keyboard up, what is on screen is the
      top bar, the conversation and the message box.
    */
    const go = (next: Tab) => {
      setMenuOpen(false);
      setTab(next);
    };
    const compactBar = (
      <header className="cbar" data-testid="compact-bar">
        {tab !== 'chat' && (
          <button type="button" className="cbar-btn cbar-back" data-action="back-to-chat" onClick={() => setTab('chat')} aria-label="Back to chat">
            <BackIcon />
            <span>Chat</span>
          </button>
        )}
        {tab === 'chat' ? (
          <>
            <div className="cbar-slot" ref={setBarSlot} />
            {/* What the bar says while no chat is mounted to fill the slot (the first-run notice,
                the moment before the consent flag is read): the page, which is never optional. */}
            <div className="cbar-site" title={pageUrl}>
              {target.live && <span className="dot" aria-hidden="true" />}
              <span className="cbar-host">{target.live ? target.host : target.fallback}</span>
            </div>
          </>
        ) : (
          <h1 className="cbar-title">{tab === 'mods' ? 'Mods' : 'Settings'}</h1>
        )}
        <button
          ref={menuRef}
          type="button"
          className="cbar-btn"
          data-action="menu"
          aria-label="Menu"
          aria-haspopup="dialog"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(true)}
        >
          <MenuIcon />
        </button>
      </header>
    );

    return (
      <ShellContext.Provider value={shell}>
        <div className="app" data-surface="popup" data-layout={layout} data-device={compact && pointer.tablet ? 'tablet' : undefined} data-view={tab} ref={setSheetHost}>
          {/*
            The popup covers, or sits beside, the page it is about, so the page has to be named on
            screen at all times: the header is the target tab's identity, not a decoration. On a
            Mac everything that is not one of the three views lives up here; on a phone the same
            job is done by the compact bar above.
          */}
          {compact ? (
            compactBar
          ) : (
            <header className="popup-head">
              <div className="popup-target" title={pageUrl}>
                {target.live && <span className="dot" aria-hidden="true" />}
                <span className="popup-target-text">
                  <span className="popup-host">{target.live ? target.host : target.fallback}</span>
                  {target.path && <span className="popup-path">{target.path}</span>}
                </span>
              </div>
              <div className="popup-head-actions">
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
            </header>
          )}
          {layout === 'roomy' && nav}
          <div className="popup-body">{views}</div>
          {compact && menuOpen && (
            <Sheet title="Menu" onClose={() => setMenuOpen(false)} returnFocus={menuRef} testId="sheet-menu">
              <nav className="sheet-list" aria-label="usermods">
                <SheetRow label="Chat" current={tab === 'chat'} onClick={() => go('chat')} action="view-chat" />
                <SheetRow label="Mods" value={updateCount > 0 ? `${updateCount} update${updateCount === 1 ? '' : 's'}` : undefined} current={tab === 'mods'} onClick={() => go('mods')} action="view-mods" />
                <SheetRow label="Settings" current={tab === 'settings'} onClick={() => go('settings')} action="view-settings" />
              </nav>
              <div className="sheet-list">
                <SheetRow
                  label="Open dashboard"
                  icon={<DashboardIcon />}
                  onClick={() => {
                    setMenuOpen(false);
                    void openDashboard();
                  }}
                  action="dashboard"
                  title="Every chat and every mod, in a full tab"
                />
                <ThemeToggle row />
              </div>
            </Sheet>
          )}
        </div>
      </ShellContext.Provider>
    );
  }

  return (
    <div className="app" data-surface="panel">
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
          <button type="button" data-view="mods" aria-current={tab === 'mods' ? 'page' : undefined} className={tab === 'mods' ? 'active' : ''} onClick={() => setTab('mods')}>
          Mods
          {updateCount > 0 && (
            <span className="tab-badge" data-testid="mods-update-badge" aria-label={`, ${updateCount} update${updateCount === 1 ? '' : 's'} available`}>
              {updateCount}
            </span>
          )}
        </button>
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
      {views}
    </div>
  );
}
