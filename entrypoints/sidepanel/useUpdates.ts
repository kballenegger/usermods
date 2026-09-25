import { useEffect, useState } from 'react';
import { rpc } from '@/lib/rpc';

export type UpdateSummary = Record<string, { available?: string; error?: string; lastChecked?: number }>;

/**
 * The update offers, per mod, kept live: read from the background (no sources travel), re-read
 * whenever the mod list or the update records change in storage. Mounting it once is what "check
 * when the panel or dashboard opens" means — the background throttles to once a day per mod, so
 * opening the panel repeatedly costs a storage read.
 */
export function useUpdates(): { summary: UpdateSummary; count: number; refresh: () => void } {
  const [summary, setSummary] = useState<UpdateSummary>({});
  const refresh = () => {
    void rpc({ type: 'updates.summary' }).then(setSummary).catch(() => {});
  };
  useEffect(() => {
    refresh();
    void rpc({ type: 'updates.check' }).then(refresh).catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (changes.updates || changes.mods)) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);
  const count = Object.values(summary).filter((s) => s.available).length;
  return { summary, count, refresh };
}

/** Open the review screen for a mod's waiting update: the install page, in update mode. */
export function openUpdateReview(modId: string): void {
  void chrome.tabs.create({ url: `${chrome.runtime.getURL('install.html')}?update=${encodeURIComponent(modId)}` });
}
