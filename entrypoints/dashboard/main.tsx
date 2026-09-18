// The dashboard: every chat and every mod, in a full tab. It is also the extension's options page
// (options_ui, open_in_tab), so it is reachable from chrome://extensions and from the toolbar
// icon's context menu as well as from the side panel's Dashboard button.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyStoredTheme } from '@/lib/theme';
import { Dashboard } from './Dashboard';
import '../sidepanel/styles.css';
import './dashboard.css';

// The authoritative read, correcting the synchronous mirror theme-boot.js already applied. Not
// awaited: see the note in sidepanel/main.tsx.
void applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Dashboard />
  </React.StrictMode>,
);
