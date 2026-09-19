// The connected providers, as live React state for whichever view needs them: the composer's model
// picker, the Providers section of Settings, the dashboard's overview line.
//
// It is a read model over chrome.storage and nothing else. Every write goes through
// lib/connections.ts (mutateConnections, saveModelChoice) or the background (models.list caches a
// listing, signing in writes a token), and every one of those lands here through the same
// storage.onChanged listener — so two open views, or the panel and the dashboard, cannot disagree
// about which providers exist, and nobody has to remember to tell anybody.
import { useEffect, useState } from 'react';
import {
  EMPTY_CONNECTIONS,
  NOT_SIGNED_IN,
  loadConnections,
  loadModelChoice,
  loadSignedIn,
  touchesConnections,
  type ConnectionsState,
  type ModelSelection,
  type SignedIn,
} from '@/lib/connections';

export interface ConnectionsView {
  /** False until the first read has landed. Nothing should be decided about a selection before it. */
  ready: boolean;
  state: ConnectionsState;
  /** The last model the user picked: a new chat's default. */
  last: ModelSelection | null;
  signedIn: SignedIn;
}

const INITIAL: ConnectionsView = { ready: false, state: EMPTY_CONNECTIONS, last: null, signedIn: NOT_SIGNED_IN };

export function useConnections(): ConnectionsView {
  const [view, setView] = useState<ConnectionsView>(INITIAL);

  useEffect(() => {
    let live = true;
    let seq = 0;
    const read = async () => {
      const mine = ++seq;
      try {
        // Connections first: that read is what migrates a legacy profile, and the migration is
        // what writes the last choice the second read is about to ask for.
        const state = await loadConnections();
        const [last, signedIn] = await Promise.all([loadModelChoice(), loadSignedIn()]);
        // A slower, older read must not overwrite a newer one.
        if (live && mine === seq) setView({ ready: true, state, last, signedIn });
      } catch {
        if (live && mine === seq) setView((v) => ({ ...v, ready: true }));
      }
    };
    void read();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      // 'settings' too: a legacy profile appearing there (an older build, a restored backup) is
      // something loadConnections migrates, and the view should follow.
      if (area === 'local' && (touchesConnections(changes) || 'settings' in changes)) void read();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

  return view;
}
