import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyMirroredTheme, applyStoredTheme } from '@/lib/theme';
import { App } from './App';

// Two steps, because chrome.storage cannot answer before the first paint.
//
// The synchronous mirror goes on first and is what makes the first frame correct: it reads
// localStorage, so a panel whose saved theme differs from the OS never shows the wrong palette.
//
// The authoritative read then follows, deliberately NOT awaited before render. Awaiting it would
// make this module's evaluation — and with it DOMContentLoaded, since a module script blocks it —
// wait on chrome.storage, which delays the whole page for the one case the mirror already covers.
// It corrects the theme if the mirror was stale, which is a no-op almost every time.
applyMirroredTheme();
void applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
