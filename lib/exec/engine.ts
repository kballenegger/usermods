/**
 * Which primitive actually runs a mod's code, and what to tell the user when it cannot.
 *
 * usermods was built on `chrome.userScripts`: one `register()` call per saved mod, an isolated
 * USER_SCRIPT world, and a dedicated `runtime.onUserScriptMessage` channel for the GM bridge.
 * Safari (WebKit) has never shipped any part of that: no `userScripts` namespace, no
 * `onUserScriptMessage`, no `sidePanel` (see docs/browsers.md for the API-by-API check). So the
 * execution layer is split in two behind one decision made here:
 *
 *   'user-scripts'   Chrome / Firefox. What shipped. Untouched.
 *   'content-script' Safari. A declared content script (entrypoints/modrunner.content.ts) asks the
 *                    background which mods belong to the document it is in, and evaluates their
 *                    code in its own isolated world.
 *
 * The choice is a pure function of what the runtime exposes, not of a build flag, so a Chrome build
 * that somehow lost the permission and a Safari build both reach the right answer, and so the whole
 * decision is testable in node (test/exec-engine.test.ts).
 *
 * `scripting.executeScript` is deliberately NOT the Safari primitive. It takes `files` or a
 * serialized `func`, never a code string, so it cannot run source an LLM just wrote; and the `func`
 * form still has to `new Function(src)` at the far end, which lands you back in exactly the same
 * place as the content script with an extra hop. The one thing it is used for stays what it always
 * was: injecting the extension's own bundled content script by file path.
 */

export type ExecEngine = 'user-scripts' | 'content-script';

/** What the host runtime exposes. Gathered by lib/exec/adapter.ts; plain data so this stays pure. */
export interface RuntimeProbe {
  /** The `userScripts` namespace exists at all. */
  api: boolean;
  /** It exists AND is permitted. On Chrome that is the "Allow User Scripts" toggle being on. */
  permitted: boolean;
  /** `sidePanel` exists. False on Safari and Firefox; the popup is the surface there. */
  sidePanel: boolean;
  /** UA string, only used to word Chrome's setup instructions. */
  userAgent: string;
}

export interface ExecStatus {
  available: boolean;
  /** Empty when available. Instructions the panel shows verbatim. */
  message: string;
  engine: ExecEngine;
}

/**
 * The engine for a runtime.
 *
 * Keyed on the namespace EXISTING rather than on it being permitted: a Chrome profile with the
 * toggle off must keep getting Chrome's "turn the toggle on" instructions, not silently fall back
 * to a weaker execution model whose CSP behaviour differs. Falling back there would be the worst
 * kind of helpful. Mods would start working slightly differently and nothing would say why.
 */
export function pickEngine(probe: Pick<RuntimeProbe, 'api'>): ExecEngine {
  return probe.api ? 'user-scripts' : 'content-script';
}

/**
 * Chrome's setup instructions. Pre-138 the API needed Developer Mode; from 138 it is a per-extension
 * "Allow User Scripts" toggle. Unchanged from what shipped, only moved here.
 */
function chromeSetupMessage(userAgent: string): string {
  const version = Number(userAgent.match(/Chrom(?:e|ium)\/(\d+)/)?.[1] ?? 0);
  return version >= 138
    ? 'usermods needs the "Allow User Scripts" toggle.\n1. Open chrome://extensions\n2. Click Details on usermods\n3. Turn on "Allow User Scripts"'
    : 'usermods needs Developer Mode.\n1. Open chrome://extensions\n2. Turn on "Developer mode" (top right)';
}

/**
 * Whether mods can run, and what to say when they cannot.
 *
 * The content-script engine has no permission to ask for: the content script is declared in the
 * manifest and the host permission is granted at install. What it CAN lack is the ability to
 * evaluate a code string at all, which is a property of the page it landed in rather than of the
 * browser, so that failure is reported per document by the runner (see evalBlockedMessage) and not
 * predicted here. Saying "ready" and then naming the one page that refused is more honest than a
 * blanket warning on every page.
 */
export function execStatus(probe: RuntimeProbe): ExecStatus {
  const engine = pickEngine(probe);
  if (engine === 'content-script') return { available: true, message: '', engine };
  if (probe.permitted) return { available: true, message: '', engine };
  return { available: false, message: chromeSetupMessage(probe.userAgent), engine };
}

/**
 * What to say when a document will not evaluate a code string.
 *
 * Arbitrary code needs `new Function` (isolated world) or an inline `<script>` (page world). Both
 * are governed by a Content-Security-Policy, and usermods never rewrites one: stripping `script-src`
 * off a site to make a mod run would disable that site's own defence against script injection for
 * every other script on the page too, which is not a trade a userscript manager gets to make on the
 * user's behalf. So the honest outcome is a named failure on that page.
 */
export function evalBlockedMessage(world: 'USER_SCRIPT' | 'MAIN', host: string): string {
  const where = host || 'this page';
  return world === 'MAIN'
    ? `${where} blocks inline page scripts with a Content-Security-Policy, so a mod that needs page globals (@grant none / unsafeWindow) cannot run here. usermods does not weaken a site's CSP. Remove "@grant none" so the mod runs in the isolated world instead, where the site's policy does not apply.`
    : `${where} would not let usermods evaluate mod code in its isolated world. Nothing was run. This is a Content-Security-Policy on the page, which usermods deliberately does not weaken.`;
}
