# usermods vs Tampermonkey

Both usermods and Tampermonkey are browser extensions that run userscripts. usermods adds a chat with a model of your choice that inspects the page and writes, tests and edits scripts for you; Tampermonkey has the wider `GM_*` API and runs in more browsers. usermods can import a Tampermonkey backup in one file.

## What they share

- Both run standard userscripts with a `==UserScript==` header, from Greasy Fork, OpenUserJS, gists or your own files.
- Both open their own install page when you click a `.user.js` link.
- In Chrome, both need **Allow User Scripts** turned on for the extension in `chrome://extensions`.
- A mod saved in usermods is a plain `.user.js` file that Tampermonkey can install, and the reverse.

## Side by side

| | usermods | Tampermonkey |
|---|---|---|
| Write and edit scripts | By describing the change in a chat with a model of your choice, or in the dashboard's code editor | In its code editor |
| Browsers | Chrome; Safari on Mac, iPhone and iPad (built from source) | Chrome, Edge, Firefox, Safari, Opera |
| `GM_*` API | Most of it; menu commands, notifications and tab storage are stubs; no `GM_download`, `GM_cookie`, `GM_webRequest` | Full |
| Update checks | Never automatic; review screen with permission changes, a diff and an optional model review | Automatic by default |
| Import the other's library | Imports a Tampermonkey backup, with on/off state and stored values | Installs usermods mods as ordinary userscripts |
| Share | Fills a gist or Greasy Fork form in your own tab | Export and cloud sync |
| Source | Open source, MIT | Not open source |

The usermods column comes from its [code and docs](https://github.com/kballenegger/usermods). See [GM API support](/guide/gm-api) for the exact table.

## Which to use

If you write or tweak scripts and want a model to do the inspecting and testing, usermods does that. If you rely on menu commands, `GM_download` or browsers other than Chrome and Safari, keep Tampermonkey for those scripts. You can [migrate](/guide/migrate-from-tampermonkey) and run both, as long as the same script is not enabled in both.
