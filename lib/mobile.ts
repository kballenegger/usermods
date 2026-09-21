/**
 * The decisions the Safari popup makes, as pure functions.
 *
 * The popup is the whole of usermods in Safari: there is no side panel there on either platform.
 * On iPhone it is a sheet covering the screen, driven by a thumb. On a Mac it is a small window
 * hanging off the toolbar, driven by a mouse. Those are different enough to be worth reasoning
 * about rather than styling around, and the reasoning is here so it can be tested in node
 * (test/mobile.test.ts) instead of only being looked at in a screenshot.
 */

/**
 * How much of the viewport the on-screen keyboard is covering, in CSS pixels.
 *
 * iOS does not resize the window when the keyboard opens; it shrinks `window.visualViewport` and
 * leaves the layout viewport alone. A composer pinned to the bottom of `100dvh` therefore sits
 * underneath the keyboard, which is the single most common way a mobile web UI feels broken. The
 * inset computed here is written to a custom property and padded off the bottom of the popup.
 *
 * `offsetTop` is included because the page can also be scrolled within the visual viewport (iOS
 * does this when a focused field would otherwise be hidden); without it the inset is overstated by
 * however far the page was pushed up, and the composer floats above the keyboard with a gap.
 *
 * Small differences are ignored: Safari reports fractional viewport heights that wobble by a pixel
 * during scroll, and reacting to those would repaint the layout continuously.
 */
export const KEYBOARD_EPSILON_PX = 24;

export function keyboardInset(
  viewport: { height: number; offsetTop: number } | null | undefined,
  windowHeight: number,
): number {
  if (!viewport || !Number.isFinite(viewport.height) || !Number.isFinite(windowHeight)) return 0;
  const covered = windowHeight - viewport.height - viewport.offsetTop;
  if (!Number.isFinite(covered) || covered < KEYBOARD_EPSILON_PX) return 0;
  return Math.round(covered);
}

/** The page the popup is pointed at, as the header shows it. */
export interface TargetChip {
  /** Hostname, or '' when there is no page to act on. */
  host: string;
  /** Path and query, trimmed. Empty for a bare origin. */
  path: string;
  /** What to read out when there is no host: why, not a blank. */
  fallback: string;
  /** Whether usermods can do anything here. */
  live: boolean;
}

/**
 * What page the popup is acting on.
 *
 * On a phone this is not decoration. The popup covers the page it is about, so once it is open
 * there is nothing on screen to tell you which tab you opened it from, and "Try this mod" with the
 * wrong tab underneath is a confusing failure rather than an obvious one. The header names the tab
 * at all times, and says plainly when there is no page it can reach.
 */
export function targetChip(url: string): TargetChip {
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed) return { host: '', path: '', fallback: 'No page open', live: false };
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // A browser page, an extension page, a PDF viewer. Content scripts do not run on these, so
    // nothing usermods offers will work, and saying which kind of page it is beats a blank chip.
    return { host: '', path: '', fallback: `usermods cannot run on ${parsed.protocol.replace(':', '')}: pages`, live: false };
  }
  const path = `${parsed.pathname}${parsed.search}`.replace(/^\/$/, '');
  return { host: parsed.hostname.replace(/^www\./, ''), path, fallback: '', live: true };
}

/** Hosts that mean "the machine this browser is running on". */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

export function isLocalBaseUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOCAL_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

/**
 * What a local provider URL means, which is not the same thing on both platforms.
 *
 * On a Mac, "run a model on your own machine" and "point usermods at localhost" are the same
 * sentence, and the note is a one-line confirmation. On iPhone and iPad they are not: the extension
 * runs inside Safari on the phone, so `localhost` is the phone, and the model on the laptop across
 * the room is not reachable at that name. That one looks like a bug in the extension for half an
 * hour before it looks like what it is, so the popup says it next to the field rather than leaving
 * it to be discovered.
 *
 * Which note to show is decided by the pointer rather than by sniffing the user agent. The two
 * answers differ because one device runs the browser and the model and the other does not, and
 * "the primary pointer is a finger" is the closest honest proxy the page has for that. A Mac with
 * a touchscreen would be told the wrong thing; Apple does not sell one.
 */
export function localBaseUrlNote(coarsePointer: boolean): string {
  if (!coarsePointer) {
    return 'localhost is this Mac, which is usually what you want. A model running on another machine needs that machine\'s address instead, for example http://192.168.1.10:1234/v1.';
  }
  return "On iPhone and iPad, localhost is this device. A model running on your computer needs that computer's address on your network instead, for example http://192.168.1.10:1234/v1.";
}

/**
 * Which shell the popup wears.
 *
 * 'compact' is the phone sheet: navigation along the bottom where a thumb reaches, controls at
 * 44px, type at 16px so iOS does not zoom the page when a field takes focus. 'roomy' is the Mac
 * popup: a fixed 420x560 window, navigation under the header where a mouse expects tabs, and the
 * same control sizes the side panel uses.
 *
 * The pointer decides, and ONLY the pointer. The width is not an input, and this is the part that
 * was got wrong once and is worth stating plainly, because the failure was invisible in a diff and
 * obvious on screen.
 *
 * Safari on macOS sizes a toolbar popover FROM its document. There is no window for the page to
 * fill: whatever the document measures at the first layout pass is what the popover becomes. So a
 * width read from `window.innerWidth` inside the popup is not a fact about the user's screen that
 * the layout can react to — it is this function's own output coming back round. An earlier version
 * required `width >= 360` before it would answer 'roomy', and the result was a deadlock: at first
 * paint there was no meaningful width, so the answer was 'compact', whose CSS is `height: 100dvh`
 * with no width — a percentage of a window that is itself waiting for the content to have a size.
 * The document never got a size, the width never reached 360, the layout never flipped, and the
 * popover opened as a ~470px by 90px sliver showing the top edge of the header and nothing else.
 *
 * Hence: fine pointer means 'roomy', at any width, including a width of zero or NaN. The document
 * declares its own 420x560 in entrypoints/popup/popup-size.css before React ever mounts, so the
 * roomy shell always has exactly the room it was drawn for, and there is nothing left for a floor
 * to protect against. A floor could only ever fire on a measurement that the floor itself caused.
 *
 * Coarse pointer means 'compact' at any width, which is the case a floor might have looked like it
 * was serving and is not: iPhone, and iPad including an iPad with a trackpad attached, where
 * iPadOS still reports a coarse primary pointer. That is the answer we want — the popup there is a
 * sheet on a touch screen, sized by the system, and it needs thumb-sized targets whether it is
 * 390px or 1024px across.
 */
export type PopupLayout = 'compact' | 'roomy';

export function popupLayout(env: { coarsePointer: boolean; width?: number }): PopupLayout {
  return env.coarsePointer ? 'compact' : 'roomy';
}
