import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyStoredTheme } from '@/lib/theme';
import { App } from './App';

// The authoritative read, deliberately NOT awaited before render. theme-boot.ts (a classic script
// in index.html, ahead of the stylesheet) has already put the right palette on the document, so
// awaiting chrome.storage here would only hold up this module's evaluation — and with it
// DOMContentLoaded — for a case that is already handled. This corrects a stale mirror, which is a
// no-op almost every time.
void applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
