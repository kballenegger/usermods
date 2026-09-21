import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyStoredTheme } from '@/lib/theme';
import { App } from '@/entrypoints/sidepanel/App';

// Same authoritative-but-not-awaited theme read as the panel's entry. theme-boot.js has already put
// the right palette on the document; this corrects a stale mirror and is a no-op almost every time.
void applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App surface="popup" />
  </React.StrictMode>,
);
