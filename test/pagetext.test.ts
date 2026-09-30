// get_page with text: true (lib/pagetext.ts): the page's readable text, with its structure, and a
// slice that always says where it is and how to continue.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { pageText, sliceText } from '../lib/pagetext.ts';

Object.assign(globalThis, { CSS: { escape: (s: string) => s.replace(/[^\w-]/g, (c) => `\\${c}`) } });

function load(html: string): Document {
  const d = parseHTML(html).document as unknown as Document;
  Object.assign(globalThis, { document: d, HTMLElement: class {} });
  return d;
}

const shown = (el: Element) => !el.hasAttribute('hidden');

test('page text keeps headings, paragraphs, lists and table rows, and leaves hidden things out', () => {
  const d = load(`<html><body><article>
    <h1>Terms of service</h1><p>By using   the site
    you agree.</p><h2>Cancellation</h2><ul><li>Any time</li><li><div>With a refund</div></li></ul>
    <table><tr><th>Plan</th><th>Price</th></tr><tr><td>Pro</td><td>$5</td></tr></table>
    <div hidden>secret</div><script>x()</script><p>Line one<br>line two</p><pre>  code
    indented</pre><img alt="Logo"></article></body></html>`);
  assert.equal(
    pageText(d.body, {}, shown),
    '# Terms of service\n\nBy using the site you agree.\n\n## Cancellation\n\n- Any time\n- With a refund\n\nPlan | Price\nPro | $5\n\nLine one\nline two\n\n  code\n    indented\n\n[image: Logo]',
  );
});

test('reading the whole page leaves a long nav or footer out with a pointer to it; reading it by selector does not', () => {
  const links = Array.from({ length: 60 }, (_, i) => `<a>Link ${i}</a>`).join(' ');
  const d = load(`<html><body><nav id="menu">${links}</nav><main><h1>Title</h1><p>Body text.</p></main><footer class="f">${links}</footer></body></html>`);
  const whole = pageText(d.body, { skipChrome: true }, shown);
  assert.match(whole, /^\[navigation left out, \d+ characters: "Link 0 Link 1 .*"; get_page with text and selector "#menu" reads it\]\n\n# Title\n\nBody text\.\n\n\[footer left out, /);
  assert.match(pageText(d.querySelector('nav')!, {}, shown), /^Link 0 Link 1 .* Link 59$/);
  const short = load('<html><body><nav><a>Home</a></nav><p>x</p></body></html>');
  assert.equal(pageText(short.body, { skipChrome: true }, shown), 'Home\n\nx', 'a small nav costs less than its summary');
});

test('a text slice says where it is and how to continue; the last one says it is the end', () => {
  const full = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  assert.equal(sliceText('short', 0, 100), 'Page text, complete (5 characters):\nshort');
  const first = sliceText(full, 0, 300);
  const end = Number(/offset: (\d+)\]$/.exec(first)![1]);
  assert.ok(end <= 300 && end > 240 && full[end - 1] === '\n', 'the part ends at a line break near the budget');
  assert.match(first, new RegExp(`^Page text, characters 0-${end} of ${full.length}:\\nline 0\\n`));
  assert.match(first, new RegExp(`\\[${full.length - end} more characters\\. Continue with get_page text: true, offset: ${end}\\]$`));
  const last = sliceText(full, full.length - 10, 300);
  assert.match(last, /\[End of the text\.\]$/);
  assert.equal(sliceText(full, 99999, 300), `(Offset 99999 is past the end: the text is ${full.length} characters.)`);
  assert.equal(sliceText('', 0, 300), '(The page has no visible text.)');
});
