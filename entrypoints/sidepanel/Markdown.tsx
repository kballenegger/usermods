import { memo, useMemo, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { prepareMarkdown, safeUrl } from '@/lib/markdown';

/**
 * Assistant prose, rendered as markdown.
 *
 * Every model writes markdown whether or not it was asked to, so a transcript that renders text
 * verbatim shows `**bold**` with its asterisks and a code snippet as a wall of unindented prose.
 * This is the one place that turns it into a document, and it is used by the side panel and the
 * dashboard's transcript preview alike so the two cannot disagree.
 *
 * ## Why react-markdown
 *
 * It renders to REACT ELEMENTS. There is no HTML string anywhere in the path, so there is no
 * `dangerouslySetInnerHTML` to get wrong and nothing for a sanitiser to miss — the alternative,
 * marked + DOMPurify, produces a string and then spends a second library making it safe again. In
 * an MV3 extension that distinction is also a CSP one: no eval, no `new Function`, no Trusted Types
 * escape hatch, nothing that a stricter policy later would break.
 *
 * Embedded HTML is not parsed (rehype-raw is deliberately absent) AND is stripped from the source
 * before parsing, so it is neither rendered nor shown as literal tags. See lib/markdown.ts for the
 * three rules and what each one is defending against.
 *
 * ## The component overrides below
 *
 * Each `components` entry exists for a reason that is not styling — styling is markdown.css:
 *
 *   - `a`     — a model-chosen URL. Scheme-checked, opened in a new tab (a side panel that
 *               navigates away takes the conversation with it), `rel` set against tabnabbing.
 *   - `img`   — never an <img>. A model that can read the page can put what it read into an image
 *               URL, and rendering one makes the panel fetch it. Shown as a link instead.
 *   - `pre`   — the Copy button and the language label. Snippets are what the model writes most.
 *   - `h1-h6` — demoted, so a heading in a reply cannot out-shout the panel's own title.
 *   - `table` — wrapped in a scroller, because the panel is 320px wide on a phone.
 */
export const Markdown = memo(function Markdown({
  text,
  streaming = false,
  className = 'md',
}: {
  text: string;
  /** True only for the row still being streamed into: repairs unterminated `**` and fences. */
  streaming?: boolean;
  className?: string;
}) {
  // Parsing is the expensive half and a transcript can hold hundreds of rows, so the source is
  // memoised per row and the component is memo()'d on its props. A delta re-parses the ONE row it
  // landed in; every other row is untouched.
  const src = useMemo(() => prepareMarkdown(text, streaming), [text, streaming]);
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS} skipHtml>
        {src}
      </ReactMarkdown>
    </div>
  );
});

const COMPONENTS: Components = {
  a({ href, children, ...rest }) {
    const safe = safeUrl(href);
    // No href at all when the scheme was refused — not '#', which is still a link and still looks
    // like one. The text stays, so the reader sees what the model wrote and simply cannot click it.
    if (!safe) return <span className="md-deadlink">{children}</span>;
    return (
      <a {...rest} href={safe} target="_blank" rel="noopener noreferrer nofollow">
        {children}
      </a>
    );
  },

  // An image is a request the panel would make on the model's behalf, to a URL the model chose.
  // That is a tracking pixel with extra steps, so it is rendered as something the reader decides
  // about: a link, labelled as an image, carrying the alt text the model wrote.
  img({ src, alt }) {
    const safe = safeUrl(typeof src === 'string' ? src : '');
    const label = alt?.trim() || 'image';
    if (!safe) return <span className="md-deadlink">🖼 {label}</span>;
    return (
      <a className="md-imglink" href={safe} target="_blank" rel="noopener noreferrer nofollow" title={safe}>
        🖼 {label}
      </a>
    );
  },

  code({ className, children, ...rest }) {
    // react-markdown gives inline code and a fence's body the same tag; only the fence carries a
    // language class, and only a fence is wrapped in <pre>. `node.position` is unreliable
    // mid-stream, so the presence of a newline settles the rest.
    const text = String(children ?? '');
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    if (!lang && !text.includes('\n')) {
      return (
        <code className="md-inline" {...rest}>
          {children}
        </code>
      );
    }
    return <code className={className}>{children}</code>;
  },

  pre({ children }) {
    return <CodeBlock>{children}</CodeBlock>;
  },

  // Headings are demoted two levels: the panel's own title is 15px, and a model that opens its
  // reply with `# Done` must not draw a line bigger than the thing it is inside. The tags stay
  // semantic-ish (an h1 becomes an h3) so the document outline still descends.
  h1: (p) => <h3 className="md-h md-h1" {...p} />,
  h2: (p) => <h4 className="md-h md-h2" {...p} />,
  h3: (p) => <h5 className="md-h md-h3" {...p} />,
  h4: (p) => <h6 className="md-h md-h4" {...p} />,
  h5: (p) => <h6 className="md-h md-h5" {...p} />,
  h6: (p) => <h6 className="md-h md-h6" {...p} />,

  // A GFM table is the one construct that cannot be made to fit 320px by wrapping — a three-column
  // table of selectors is wider than the panel no matter what. It gets its own scroller so it
  // scrolls instead of stretching the whole transcript sideways.
  table: (p) => (
    <div className="md-tablewrap">
      <table {...p} />
    </div>
  ),
};

/**
 * A fenced code block: the language, a Copy button, and the code.
 *
 * Copy earns its place here more than anywhere else in the panel. The model routinely shows a
 * snippet before proposing it as a mod, and the alternative to a button is selecting text inside a
 * scrolling transcript that is still growing under the cursor.
 */
function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  // The <code> element react-markdown put inside this <pre>: its className carries the language and
  // its children are the text to copy. Read off the element rather than re-deriving from the
  // source, so what the button copies is exactly what is on screen.
  const el = Array.isArray(children) ? children[0] : children;
  const props = (el && typeof el === 'object' && 'props' in el ? el.props : {}) as {
    className?: string;
    children?: React.ReactNode;
  };
  const code = toText(props.children);
  const lang = /language-(\w+)/.exec(props.className ?? '')?.[1];

  return (
    <div className="md-code">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang ?? 'code'}</span>
        <button
          className="md-copy"
          type="button"
          data-testid="md-copy"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(
              () => {
                setCopied(true);
                // Long enough to be read, short enough that the button is ready again before a
                // reader who is copying two snippets in a row reaches the second.
                setTimeout(() => setCopied(false), 1400);
              },
              // A clipboard write can be refused (no permission, not focused). Saying nothing and
              // leaving the label at "Copy" is honest: nothing was copied.
              () => {},
            );
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

/** The plain text under a React subtree, for the clipboard. */
function toText(node: React.ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(toText).join('');
  if (typeof node === 'object' && 'props' in node) {
    return toText((node.props as { children?: React.ReactNode }).children);
  }
  return '';
}
