# GM API compatibility

What an imported or hand-written userscript can count on inside usermods: the `GM_*` and `GM.*`
surface, `@connect`, which world a script runs in, and the `@include` forms Chrome cannot match.

Importing and migrating scripts is in [guide.md](guide.md#importing-scripts-and-migrating-from-tampermonkey).

## GM API compatibility

| Function | Status |
|---|---|
| `GM_info` / `GM.info` | Supported |
| `GM_addStyle`, `GM_addElement` | Supported |
| `GM_getValue`, `GM_setValue`, `GM_deleteValue`, `GM_listValues` (and `GM.*`) | Supported. Reads come from a snapshot taken when the script was registered; writes persist immediately and are pushed live to the script's other open tabs. |
| `GM_getResourceText`, `GM_getResourceURL` | Supported, from `@resource` files fetched at install time |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | Supported, cross-origin, via the background worker, subject to `@connect`. `responseType` `arraybuffer`, `blob`, `json`, `document` and text all work, with `responseXML` for `document`. `onload`, `onerror`, `onloadend` and `abort()` work; streaming and upload progress events do not. |
| `GM_openInTab` / `GM.openInTab` | Supported, with Tampermonkey's focus rules: `GM_openInTab(url)` opens in the foreground, `GM_openInTab(url, true)` and the object form without `active: true` open in the background. The returned handle is a stub: `close()` does nothing. |
| `GM_setClipboard`, `GM_log` | Supported |
| `GM_registerMenuCommand`, `GM_unregisterMenuCommand` | **Stub.** Commands are recorded but there is no menu UI to invoke them. |
| `GM_notification` / `GM.notification` | **Stub.** Logs to the console instead of showing a desktop notification. |
| `GM_getTab`, `GM_saveTab`, `GM_getTabs` | **Stub.** Return empty objects. |
| `GM_addValueChangeListener`, `GM_removeValueChangeListener` | Supported. Fire for this script's own writes and for writes from its other open tabs, with `(key, oldValue, newValue, remote)`. In the page world (`@grant none`) only local writes fire. |
| `GM_download`, `GM_cookie`, `GM_webRequest` | Not implemented |

### `@connect`

`GM_xmlhttpRequest` is cross-origin, so a script may only reach the hosts its header declares. A request is allowed when its host equals or is a subdomain of a `@connect` entry, when the script declared `@connect *`, or when it declared `@connect self` and the host is one the script's own `@match`/`@include` lines cover (a `*://*.example.com/*` pattern covers `example.com` and its subdomains; a script matching every site gains nothing from `self`). Anything else is refused with an error naming the host and the `// @connect <host>` line that would permit it. The install preview lists the `@connect` entries next to the `GM_*` permissions, so you can see what a script intends to talk to before it is saved.

Scripts and their `@require` libraries are evaluated in their own function scopes, not in one shared strict-mode closure, so sloppy-mode libraries and scripts behave as they do under Tampermonkey. A script gets strict mode only from its own `'use strict'` directive.

`@grant none` and `unsafeWindow` scripts run in the page's **MAIN** world, where they share globals with the page — which is what those scripts want. The trade-off is that extension messaging is unavailable there, so `GM_setValue` writes from a MAIN-world script update the in-page copy but **cannot be persisted**. Mod cards and the install preview mark those scripts with a *page world* badge. Everything else runs in Chrome's isolated `USER_SCRIPT` world.

Regex-style `@include` lines (`/^https?:\/\/…$/`) are not supported; Chrome matches on patterns and globs only. The install preview warns when it drops one.
