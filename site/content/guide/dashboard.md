# The usermods dashboard

The usermods dashboard is a full browser tab with every chat and every mod across every site, plus Settings. Open it from the **Dashboard** button in the side panel, from **Options** in the toolbar icon's menu, or from **Details > Extension options** in `chrome://extensions`.

![The dashboard with the overview strip, chats grouped by site and a transcript preview](/assets/guide/07-dashboard.png)

The side panel shows the chats and mods for the page you are on. The dashboard shows all of them. Opening it twice focuses the tab you already have.

## Chats

- Every chat, grouped by site, most recently used first, with the model each chat uses.
- Search filters by title and site at once, and by message text as transcripts load.
- Rename, archive, delete or open a chat. Clicking one shows its transcript beside the list, read-only.
- Select several to archive or delete them together.
- **Open** takes you back to the page the chat was last used on, with the side panel showing that chat. **Open in new tab** keeps the dashboard where it is.

## Mods

- Every saved script with its version, match patterns, grants, world, size, when it changed and where it came from (a download host, written in chat, or imported).
- Filter by site or by enabled state.
- Toggle, export, update, edit in chat or delete one mod, or select several to enable, disable, delete or export as a zip.
- Select a mod to open its source in an editor. Saving re-reads the header, so changing `@name` or a `@match` line updates the mod.
- **Install from URL**, **Import file** and **Migrate from Tampermonkey** are here too.

## Settings and the overview strip

The Settings view is the same as in the side panel. The strip across the top counts your chats and mods, shows whether **Allow User Scripts** is on, and names the connected providers. Changes made in the side panel show up here without a reload, and the other way round.
