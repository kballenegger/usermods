import React from 'react';
import ReactDOM from 'react-dom/client';
import { applyStoredTheme } from '@/lib/theme';
import { App } from './App';

// The document starts on the default (dark) via the attribute in index.html; this corrects it to
// the saved choice. Awaited so the panel settles on one palette before the first React paint.
await applyStoredTheme();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
