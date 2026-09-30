// get_page with text: true. The page's readable text, for a question ABOUT the page ("what does
// this policy mean", "why does it say Something went wrong") rather than a change to it.
//
// The HTML view is the wrong tool for that: in the owner's exported chats a terms page was read
// with run_script in two 4,000-character bites of innerText, because get_page spends its budget on
// markup and cuts long text at 200 characters a node. innerText alone is not quite right either: it
// loses which lines are headings, and on a real site the first few thousand characters are the
// navigation. So this walks the rendered DOM itself:
//   - headings become "#"-prefixed lines, list items "- ", table cells are joined by " | ", and
//     paragraphs are separated by a blank line, so the structure a reader relies on survives;
//   - hidden elements, scripts and our own UI are left out, open shadow roots are read;
//   - reading the whole page, the one <main> (or role=main) is read first and the rest after it
//     under a marker, and a large nav or footer outside the content is replaced by one line saying
//     how big it is and which selector reads it. On Wikipedia the menus, the contents list and the
//     appearance panel came to 1,500 characters before the article's first word;
//   - the result is sliced by character offset, and every slice says where it is and how to get the
//     next part. Nothing is cut silently.
// Two pure halves: pageText (DOM in, text out, visibility injectable for node tests) and sliceText.

// The .ts extension: see lib/agent/tools.ts. node's test runner loads this file directly.
import { isVisible, selectorFor, trunc } from './snapshot.ts';

const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'CANVAS', 'IFRAME', 'HEAD', 'LINK', 'META']);
/** Elements that end a line. Tag-based rather than computed display: cheap, and the same in a test. */
const BLOCK = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'FORM', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'OPTION', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE',
  'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'CAPTION', 'LEGEND',
]);
/** Blocks that also get a blank line around them. */
const PARAGRAPH = new Set(['P', 'BLOCKQUOTE', 'PRE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'FIGURE', 'DL', 'UL', 'OL']);

/** A nav or footer at least this long is summarised when reading the whole page. */
export const CHROME_MIN_CHARS = 300;

/** Is this page chrome (navigation, or a footer outside the content) rather than content? */
function isChrome(el: Element): boolean {
  const tag = el.tagName;
  const role = el.getAttribute('role');
  if (tag === 'NAV' || role === 'navigation') return true;
  if (tag === 'FOOTER' || role === 'contentinfo') return !el.closest('main, article, [role="main"]');
  return false;
}

/**
 * The readable text under `root`. `wholePage` puts the main content first and summarises big navs
 * and footers; reading one element by selector prints everything inside it, in order.
 */
export function pageText(root: Element, opts: { wholePage?: boolean } = {}, visible: (el: Element) => boolean = isVisible): string {
  if (!opts.wholePage) return render(root, false, null, visible);
  const mains = [...root.querySelectorAll('main, [role="main"]')].filter((m) => visible(m) && !m.parentElement?.closest('main, [role="main"]'));
  if (mains.length !== 1) return render(root, true, null, visible);
  const main = render(mains[0]!, true, null, visible);
  const rest = render(root, true, mains[0]!, visible);
  return rest ? `${main}

[Outside the main content:]

${rest}` : main;
}

/** One pass of pageText: `root`'s text, with `skip` (the main content, already read) left out. */
function render(root: Element, skipChrome: boolean, skip: Element | null, visible: (el: Element) => boolean): string {
  const lines: string[] = [];
  let line = '';
  let prefix = '';
  // Blank lines wanted before the next text: 0 none, 1 a line break, 2 a paragraph break.
  let gap = 0;
  const flush = () => {
    const t = line.replace(/\s+/g, ' ').trim();
    if (t && t !== prefix.trim()) {
      if (lines.length) for (let i = 0; i < gap; i++) lines.push('');
      lines.push(t);
      gap = 0;
    }
    line = '';
    prefix = '';
  };
  const brk = (n: number) => {
    // Only break a line that has text in it; an empty wrapper must not stack blank lines.
    if (line.replace(/\s+/g, '').length > prefix.trim().length) {
      flush();
      gap = n - 1;
    } else {
      // Nothing written yet: keep a pending "- " or "## " for the text still to come.
      gap = Math.max(gap, n - 1);
    }
  };
  const visit = (node: Node) => {
    if (node.nodeType === 3) {
      line += node.textContent ?? '';
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (el === skip || SKIP.has(el.tagName) || SKIP.has(tag) || el.hasAttribute('data-usermods') || !visible(el)) return;
    if (tag === 'BR') {
      brk(1);
      return;
    }
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) line += ` [image: ${trunc(alt, 80)}] `;
      return;
    }
    if (skipChrome && isChrome(el)) {
      const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t.length >= CHROME_MIN_CHARS) {
        brk(2);
        line = `[${tag === 'NAV' || el.getAttribute('role') === 'navigation' ? 'navigation' : 'footer'} left out, ${t.length} characters: "${trunc(t, 60)}"; get_page with text and selector ${JSON.stringify(selectorFor(el))} reads it]`;
        brk(2);
        return;
      }
    }
    const heading = /^H[1-6]$/.test(tag) ? Number(tag[1]) : 0;
    const block = heading > 0 || BLOCK.has(tag);
    if (block) brk(PARAGRAPH.has(tag) ? 2 : 1);
    if (heading) line = prefix = '#'.repeat(heading) + ' ';
    else if (tag === 'LI') line = prefix = '- ';
    else if ((tag === 'TD' || tag === 'TH') && line.trim()) line += ' | ';
    if (tag === 'PRE') {
      // Preformatted text keeps its own lines; code and poetry are unreadable collapsed.
      flush();
      const raw = (el.textContent ?? '').replace(/\s+$/, '');
      if (raw) {
        if (lines.length) for (let i = 0; i < Math.max(gap, 1); i++) lines.push('');
        lines.push(...raw.split('\n').map((l) => l.replace(/\s+$/, '')));
        gap = 1;
      }
      return;
    }
    if (el.shadowRoot) for (const k of el.shadowRoot.childNodes) visit(k);
    for (const k of el.childNodes) visit(k);
    if (block) brk(PARAGRAPH.has(tag) ? 2 : 1);
  };
  visit(root);
  flush();
  return lines.join('\n');
}

/** The default size of one text read, when max_chars is not given. */
export const TEXT_DEFAULT_CHARS = 20_000;

/**
 * One part of the text, and a line saying where it is and how to get the next part.
 *
 * A part ends at a line break when one is near the end, so a sentence is rarely split. The text is
 * recomputed on every call, so an offset into a page that changed in between may land a little
 * off; a page someone is asking questions about rarely changes under them.
 */
export function sliceText(full: string, offset: number, maxChars: number): string {
  const len = full.length;
  const start = Math.max(0, Math.floor(offset) || 0);
  if (!len) return '(The page has no visible text.)';
  if (start >= len) return `(Offset ${start} is past the end: the text is ${len} characters.)`;
  let end = Math.min(len, start + Math.max(1, maxChars));
  if (end < len) {
    const nl = full.lastIndexOf('\n', end);
    if (nl > start + maxChars * 0.8) end = nl + 1;
  }
  const part = full.slice(start, end);
  const head = start === 0 && end === len ? `Page text, complete (${len} characters):` : `Page text, characters ${start}-${end} of ${len}:`;
  const tail = end < len ? `[${len - end} more characters. Continue with get_page text: true, offset: ${end}]` : start > 0 ? '[End of the text.]' : '';
  return [head, part.replace(/\n+$/, ''), ...(tail ? [tail] : [])].join('\n');
}
