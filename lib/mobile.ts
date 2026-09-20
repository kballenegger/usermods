/**
 * The decisions the mobile popup makes, as pure functions.
 *
 * The popup is the whole of usermods on iOS: there is no side panel, no second window, and no
 * pointer. That changes three things enough to be worth reasoning about rather than styling around,
 * and all three are here so they can be tested in node (test/mobile.test.ts) instead of only being
 * looked at in a screenshot.
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
 * Why a local provider URL usually does not work on a phone.
 *
 * On a desktop, "run a model on your own machine" and "point usermods at localhost" are the same
 * sentence. On iOS they are not: the extension runs inside Safari on the phone, so `localhost` is
 * the phone, and the model on the laptop across the room is not reachable at that name. This is the
 * kind of thing that looks like a bug in the extension for half an hour before it looks like what
 * it is, so the popup says it next to the field rather than leaving it to be discovered.
 */
export function localBaseUrlNote(): string {
  return "On iPhone and iPad, localhost is this device. A model running on your computer needs that computer's address on your network instead, for example http://192.168.1.10:1234/v1.";
}
