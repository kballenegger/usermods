/**
 * The wrapper around a one-off run (the Try button, and the agent's run_script tool).
 *
 * Moved here out of entrypoints/background.ts unchanged except for one addition: how the result gets
 * back. On Chrome the wrapped code calls `chrome.runtime.sendMessage` from inside the USER_SCRIPT
 * world, which `configureWorld({messaging: true})` made possible. Under the content-script engine
 * there is no such world, and the runner evaluates the code with `chrome` shadowed, so the result
 * comes back through a `__usermodsReport` function the runner passes in. Everything else is
 * byte-for-byte what shipped: the console capture, the MutationObserver DOM counts, the awaited
 * return value, and the line offset mapStack() needs.
 */

export type ReportTransport = 'chrome' | 'bridge';

export interface Wrapped {
  wrapped: string;
  /** Lines the preamble added, so a thrown error is reported at the line the model wrote. */
  lineOffset: number;
}

/**
 * Everything the injected wrapper puts around the model's code, split so the line offset of the
 * user's first line is a computable constant rather than a guess. mapStack() needs that offset to
 * report a thrown error at the line the model wrote, not the line the wrapper landed on.
 *
 * The observer is the answer to "the script reported nothing, did it do anything?": a script whose
 * only effect is `forEach((e) => e.remove())` has no return value, and without a count of what it
 * moved the model has no evidence it worked and goes back to inspecting the page.
 */
export function wrapForExecution(code: string, runId: string, transport: ReportTransport = 'chrome'): Wrapped {
  const report =
    transport === 'bridge'
      ? `try { __usermodsReport({ type: 'usermods:run-result', runId: ${JSON.stringify(runId)}, ...__out }); } catch {}`
      : `try { chrome.runtime.sendMessage({ type: 'usermods:run-result', runId: ${JSON.stringify(runId)}, ...__out }); } catch {}`;
  const preamble = `(async () => {
    const __logs = [];
    const __fmt = (a) => a.map((x) => { try { return typeof x === 'string' ? x : JSON.stringify(x); } catch { return String(x); } }).join(' ');
    const __console = globalThis.console;
    const console = { ...__console, log: (...a) => { __logs.push(__fmt(a)); __console.log(...a); }, info: (...a) => { __logs.push(__fmt(a)); __console.info(...a); }, warn: (...a) => { __logs.push('warn: ' + __fmt(a)); __console.warn(...a); }, error: (...a) => { __logs.push('error: ' + __fmt(a)); __console.error(...a); } };
    const __dom = { added: 0, removed: 0, attributes: 0 };
    let __obs = null;
    try {
      __obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === 'attributes') __dom.attributes++;
          else { __dom.added += r.addedNodes.length; __dom.removed += r.removedNodes.length; }
        }
      });
      __obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    } catch {}
    let __out;
    try {
      const __r = await (async () => {`;
  const epilogue = `
      })();
      // One microtask turn and one frame, so a removal the page does in a rAF callback is counted.
      await new Promise((r) => { try { requestAnimationFrame(() => r()); setTimeout(r, 50); } catch { r(); } });
      try { __obs && __obs.takeRecords().forEach((r) => { if (r.type === 'attributes') __dom.attributes++; else { __dom.added += r.addedNodes.length; __dom.removed += r.removedNodes.length; } }); } catch {}
      let __s; try { __s = typeof __r === 'string' ? __r : JSON.stringify(__r); } catch { __s = String(__r); }
      __out = { ok: true, returnedValue: __r !== undefined, result: __s === undefined ? 'undefined' : String(__s).slice(0, 4000), dom: __dom, logs: __logs };
    } catch (e) {
      __out = { ok: false, error: (e && e.stack) ? String(e.stack).slice(0, 4000) : String(e), dom: __dom, logs: __logs };
    }
    try { __obs && __obs.disconnect(); } catch {}
    ${report}
    return __out;
  })()`;
  // The user's first line begins on the line after the preamble's last newline.
  return { wrapped: `${preamble} ${code}${epilogue}`, lineOffset: preamble.split('\n').length - 1 };
}
