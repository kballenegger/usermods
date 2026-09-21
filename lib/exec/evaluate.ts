/**
 * Evaluating a mod's code under the content-script engine, and knowing when a page refused.
 *
 * Two targets, because a mod names its own:
 *
 *  - **isolated world** (`Mod.world === 'USER_SCRIPT'`, the default): `new Function`, inside the
 *    content script's own world. The mod shares the DOM with the page and shares no JavaScript
 *    globals with it, which is the property Chrome's USER_SCRIPT world provides and the closest
 *    equivalent Safari has.
 *  - **page world** (`Mod.world === 'MAIN'`, what `@grant none` / `unsafeWindow` asks for): an inline
 *    `<script>`, because page globals are the entire point and nothing in an isolated world can reach
 *    them.
 *
 * A page's Content-Security-Policy can refuse the second one, and usermods never rewrites a site's
 * CSP to get around that. See docs/safari.md. What it does instead is notice. A blocked inline
 * script does not throw and does not report: the element is appended, nothing runs, and the only
 * signal is a `securitypolicyviolation` event on a later task. Waiting for that event would mean the
 * mod's own failure is reported after the page has moved on, so the check here is synchronous
 * instead: the injected source sets a one-shot attribute on <html> as its very first statement, and
 * the DOM is the one thing both worlds share. Attribute present after append means the script ran.
 * Absent means the page refused it, and the mod is reported blocked rather than silently skipped.
 *
 * Everything is injected rather than reached for, so node can drive all of it (test/exec-evaluate.test.ts).
 */

/** What the isolated-world evaluation hands the mod besides its own code. */
export interface IsolatedScope {
  /** The GM transport (lib/gm.ts, transport: 'bridge'). */
  bridge: unknown;
  /** Where a one-off run reports its result (lib/exec/wrap.ts, transport: 'bridge'). */
  report: (out: unknown) => void;
}

export type FunctionCtor = (...args: string[]) => (...a: unknown[]) => unknown;

/**
 * Evaluate mod code in the isolated world.
 *
 * `chrome` and `browser` are parameters bound to undefined, so the mod's own scope cannot reach the
 * extension API by name. That is a hardening measure, not the security boundary. An isolated world
 * still has `window.chrome`, and the boundary that actually holds is the capability grant the
 * background checks on every privileged call (lib/exec/grants.ts). Both are documented in
 * docs/safari.md; neither is claimed to be the other.
 */
export function evaluateIsolated(code: string, scope: IsolatedScope, ctor: FunctionCtor = Function as unknown as FunctionCtor): unknown {
  const fn = ctor('__usermodsBridge', '__usermodsReport', 'chrome', 'browser', code);
  return fn(scope.bridge, scope.report, undefined, undefined);
}

/**
 * Can this document evaluate a code string at all?
 *
 * Called once per document and reported to the background, so the failure is named on the page it
 * happened on instead of being predicted as a warning on every page.
 */
export function evalAllowed(ctor: FunctionCtor = Function as unknown as FunctionCtor): boolean {
  try {
    return ctor('return 1')() === 1;
  } catch {
    return false;
  }
}

/** The attribute an injected page script sets to prove it ran. Random per injection. */
export function sentinelAttribute(nonce: string): string {
  return `data-usermods-ran-${nonce}`;
}

/**
 * Page-world source: the sentinel first, then the mod.
 *
 * The sentinel goes FIRST so that a mod which throws still counts as having run. The question this
 * answers is "did the browser execute this script", not "did the script succeed". Getting that order
 * wrong would report every mod with a bug as a CSP block.
 */
export function buildPageInjection(code: string, nonce: string): string {
  const attr = JSON.stringify(sentinelAttribute(nonce));
  return `try{document.documentElement.setAttribute(${attr},'1')}catch(e){}\n${code}`;
}

/** The DOM surface page injection needs, so a fake one can stand in under node. */
export interface InjectDoc {
  documentElement: {
    setAttribute(name: string, value: string): void;
    hasAttribute(name: string): boolean;
    removeAttribute(name: string): void;
    appendChild(node: unknown): unknown;
  };
  head?: { appendChild(node: unknown): unknown } | null;
  createElement(tag: string): { textContent: string; remove(): void; setAttribute?(n: string, v: string): void };
}

/**
 * Run code in the page world. Returns whether the page let it run.
 *
 * The <script> element is removed immediately afterwards: an inline script has already executed by
 * the time `appendChild` returns, so leaving it in the document would only put the mod's whole source
 * into the page's DOM where the site's own code can read it.
 */
export function injectIntoPage(code: string, nonce: string, doc: InjectDoc): boolean {
  const attr = sentinelAttribute(nonce);
  const el = doc.createElement('script');
  el.textContent = buildPageInjection(code, nonce);
  const parent = doc.head ?? doc.documentElement;
  try {
    parent.appendChild(el);
  } finally {
    try {
      el.remove();
    } catch {
      /* already gone */
    }
  }
  const ran = doc.documentElement.hasAttribute(attr);
  if (ran) {
    try {
      doc.documentElement.removeAttribute(attr);
    } catch {
      /* nothing depends on the cleanup succeeding */
    }
  }
  return ran;
}
