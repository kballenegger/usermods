// The site a run stays on: docs/specs/browser-use.md, section 4.5.
//
// The run pauses when the top frame's URL reaches another host, and the user decides. "Continue
// there" is offered only when the two hosts share their last two labels, is the user's choice each
// time, and lasts for the chat. Nothing is allowed automatically, so no public-suffix list is needed:
// `a.co.uk` and `b.co.uk` count as siblings here, and all that costs is one more button on a question.
//
// Pure, tested under node (test/boundary.test.ts).

/** A page's host, lowercase, without "www."; '' for anything that has no host. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** An address has no sibling: 10.0.0.1 and 192.168.0.1 share their last two labels and nothing else. */
const isAddress = (host: string) => /^\d+(\.\d+){3}$/.test(host) || host.includes(':') || host.startsWith('[');

/** Do two hosts share their last two labels? Two names of one label share nothing. */
export function sharesSite(a: string, b: string): boolean {
  if (a === b) return true;
  if (!a || !b || isAddress(a) || isAddress(b)) return false;
  const tail = (h: string) => h.split('.').slice(-2);
  const [x, y] = [tail(a), tail(b)];
  return x.length === 2 && y.length === 2 && x[0] === y[0] && x[1] === y[1];
}

/** The hosts a run on `start` may be on: that one, and any sibling the user continued onto in this chat. */
export function siteHosts(start: string, continued: readonly string[]): string[] {
  return [start, ...continued.filter((h) => h !== start && sharesSite(h, start))];
}

/** What the question about leaving the site says the page is on: a host, or that it is not on the web. */
export function placeName(url: string): string {
  return /^(https?|file):/i.test(url) && hostOf(url) ? hostOf(url) : 'a browser page';
}
