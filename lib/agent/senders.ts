// Who may say what to the background, while a build can operate pages.
//
// Permissions are answered only in an extension page, so this is the check that stands behind that
// rule. `sender.tab` alone will not do: the dashboard is a tab too. What tells a page apart is its URL:
// a content script's sender carries the page's, and a page cannot give itself an extension's origin.
//
// From a page the background accepts only Stop and "I have done it" about a run (the BAR_* messages in
// entrypoints/background.ts), both harmless if forged.
//
// Pure, tested under node (test/senders.test.ts).

export interface SenderFacts {
  id?: string;
  url?: string;
  origin?: string;
}

/** Is this one of the extension's own pages? `root` is chrome.runtime.getURL(''). */
export function fromExtensionPage(sender: SenderFacts | undefined, extensionId: string, root: string): boolean {
  if (!sender || sender.id !== extensionId) return false;
  const url = sender.url ?? sender.origin ?? '';
  return !!url && (url === root.replace(/\/$/, '') || url.startsWith(root));
}
