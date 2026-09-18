/*
 * Applies the saved theme before the stylesheet is applied, let alone painted.
 *
 * chrome.storage is async and cannot answer before the first paint, so for anyone whose saved
 * choice differs from their OS there is a frame of the wrong palette — measured at roughly 5ms of
 * dark on a light panel — every single time a page is opened. lib/theme.ts therefore mirrors every
 * applied choice into localStorage, which IS synchronous, and this reads that mirror.
 *
 * Three constraints decide the unusual shape of this file, and all three matter:
 *
 *   1. It is a CLASSIC script, not a module. A module script is deferred by definition: it runs
 *      after the browser is already free to paint, and no amount of import ordering changes that.
 *      A classic script blocks the parser where it sits, which is the only way to be sure.
 *   2. It is loaded BEFORE the stylesheet link in each page's <head>, so the attribute is on <html>
 *      before any CSS has been applied.
 *   3. It lives in public/ as plain .js rather than in entrypoints/ as .ts, because the bundler
 *      only processes module scripts — a classic <script src> pointing at a .ts file is simply not
 *      emitted. public/ is copied verbatim, so what is written here is what ships.
 *
 * MV3's content security policy forbids an inline script, which is why this is a file at all. It
 * imports nothing and must stay that way: pulling in the module graph is the cost it exists to
 * avoid. The localStorage key is duplicated from lib/theme.ts, and test/theme.test.ts asserts the
 * two stay equal.
 *
 * An empty mirror (a fresh profile, cleared storage) writes nothing and leaves the document on the
 * CSS default — which is System, the right answer for a profile with no choice saved.
 */
try {
  var saved = localStorage.getItem('usermods.theme');
  var root = document.documentElement;
  if (saved === 'dark' || saved === 'light') {
    root.setAttribute('data-theme', saved);
    root.style.colorScheme = saved;
  } else if (saved === 'system') {
    root.removeAttribute('data-theme');
    root.style.colorScheme = 'light dark';
  }
} catch (e) {
  // Storage partitioned or disabled: the async read in the entry module still settles the theme,
  // at the cost of the one frame this exists to save.
}
