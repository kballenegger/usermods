# GM API support

usermods supports the `GM_*` and `GM.*` functions most userscripts use: storage, styles, resources, cross-origin requests through `GM_xmlhttpRequest` (limited to the script's `@connect` hosts), opening tabs and the clipboard. Menu commands, notifications and tab storage are stubs, and `GM_download`, `GM_cookie` and `GM_webRequest` are not implemented.

## Compatibility table

| Function | Status |
|---|---|
| `GM_info` / `GM.info` | Supported |
| `GM_addStyle`, `GM_addElement` | Supported |
| `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues` (and `GM.*`) | Supported. Writes persist immediately and reach the script's other open tabs. |
| `GM_getResourceText`, `GM_getResourceURL` | Supported, from `@resource` files fetched at install time |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | Supported, cross-origin, subject to `@connect`. `arraybuffer`, `blob`, `json`, `document` and text responses work. No streaming or upload progress events. |
| `GM_openInTab` / `GM.openInTab` | Supported, with Tampermonkey's focus rules. The returned handle's `close()` does nothing. |
| `GM_setClipboard`, `GM_log` | Supported |
| `GM_addValueChangeListener`, `GM_removeValueChangeListener` | Supported |
| `GM_registerMenuCommand`, `GM_unregisterMenuCommand` | Stub: recorded, but there is no menu to run them from |
| `GM_notification` / `GM.notification` | Stub: logs to the console |
| `GM_getTab`, `GM_saveTab`, `GM_getTabs` | Stub: return empty objects |
| `GM_download`, `GM_cookie`, `GM_webRequest` | Not implemented |

## @connect

A script may only send `GM_xmlhttpRequest` to hosts its header declares. A request is allowed when its host equals or is a subdomain of a `@connect` entry, when the script declares `@connect *`, or when it declares `@connect self` and the host is one its own `@match` lines cover. Anything else is refused with an error naming the host and the `// @connect` line that would allow it. The install preview lists the `@connect` entries before you save.

## Which world a script runs in

- `@grant none` and `unsafeWindow` scripts run in the page's own world and share its globals. There, `GM_setValue` writes update the in-page copy but cannot be saved. Mod cards and the install preview mark these with a **page world** badge.
- Everything else runs in Chrome's isolated user-script world.
- `@inject-into content` (Violentmonkey) and `@sandbox DOM` (Tampermonkey) move any script to the isolated world. Mods written in chat carry these markers.

Each script and each `@require` library runs in its own function scope, so sloppy-mode code behaves as it does under Tampermonkey.

## @include

Regex-style `@include` lines (`/^https?:\/\/...$/`) are not supported, because Chrome matches on patterns and globs only. The install preview warns when it drops one.
