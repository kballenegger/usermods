// The content script's install banner: detect (lib/banner.ts), ask the background what it knows
// (installed? dismissed? is this a share in progress?), and draw (lib/pageui.ts).
//
// Nothing here fetches anything. The background answers from storage, and Install opens the
// extension's own install page, which fetches the script, shows what it asks for, and saves nothing
// until the user says so.
import { bannerText, detectUserscripts, worthLooking, type Detection, type InstallState } from './banner';
import { showBanner } from './pageui';

export interface BannerStateReply {
  show: boolean;
  /** One per detected script; null where that script has nothing worth saying (lib/banner.ts bannerWorthShowing). */
  states: Array<InstallState | null>;
}

let lastHref = '';

async function run(): Promise<void> {
  const href = location.href;
  if (href === lastHref) return;
  lastHref = href;
  document.querySelector('[data-usermods="banner"]')?.remove();
  // The cheap gate first: no DOM is read on a page that is not on one of the known hosts and is
  // not a text document.
  if (!worthLooking(href, document.contentType || '')) return;
  const detection: Detection | null = detectUserscripts(document, href);
  if (!detection) return;
  let reply: BannerStateReply | undefined;
  try {
    reply = (await chrome.runtime.sendMessage({ type: 'usermods:banner-state', href, detection })) as BannerStateReply | undefined;
  } catch {
    return; // the extension was reloaded under this page
  }
  if (!reply?.show || location.href !== href) return;
  const rows = detection.scripts
    .map((script, i) => ({ script, state: reply!.states[i] ?? null }))
    .filter((r): r is { script: typeof r.script; state: InstallState } => r.state !== null)
    .slice(0, 3)
    .map(({ script, state }) => {
      const t = bannerText(script, state);
      return {
        message: t.message,
        ...(t.action
          ? {
              action: {
                label: t.action,
                onClick: () => {
                  void chrome.runtime.sendMessage({ type: 'usermods:banner-install', url: script.installUrl }).catch(() => {});
                },
              },
            }
          : { status: 'Installed ✓' }),
      };
    });
  if (!rows.length) return;
  showBanner(rows, () => {
    void chrome.runtime.sendMessage({ type: 'usermods:banner-dismiss', href }).catch(() => {});
  });
}

/**
 * Detect once now, and again when a single-page site changes its URL without a load (GitHub moves
 * between files with Turbo and React routing). The watchers are only installed on the hosts that
 * do that, so an ordinary page carries nothing but the first check.
 */
export function initBanner(): void {
  void run();
  const host = location.hostname;
  if (host !== 'github.com' && host !== 'gist.github.com') return;
  const again = () => setTimeout(() => void run(), 400);
  document.addEventListener('turbo:load', again);
  document.addEventListener('pjax:end', again);
  window.addEventListener('popstate', again);
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  nav?.addEventListener?.('navigatesuccess', again);
}
