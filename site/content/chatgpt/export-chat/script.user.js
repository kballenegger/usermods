// ==UserScript==
// @name         Export a ChatGPT conversation
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Adds an "Export .md" button to ChatGPT that downloads the open conversation as a Markdown file.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/export-chat.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/export-chat.user.js
// ==/UserScript==

// ChatGPT marks each message with its author in two ways: li[data-message-role] in the
// logged-out app and [data-message-author-role] for signed-in accounts. The script reads
// the messages already on the page; nothing is sent anywhere.
const MESSAGE = 'li[data-message-role], [data-message-author-role]';
const BODY = '[data-assistant-markdown-root], [data-user-message-copy], .markdown, .whitespace-pre-wrap';

GM_addStyle(`
  #usermods-export {
    position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 1000;
    padding: 6px 12px; border-radius: 8px; border: 1px solid #8884;
    background: Canvas; color: CanvasText; font: 13px/1.2 system-ui, sans-serif; cursor: pointer;
  }
  #usermods-export[hidden] { display: none; }
`);

// HTML to Markdown for what ChatGPT renders: paragraphs, headings, lists, emphasis,
// inline code, code blocks, links, quotes and tables.
function md(node, listDepth = 0) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent;
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node;
  if (el.hidden || el.getAttribute('aria-hidden') === 'true' || el.matches('button, svg, [role="status"]')) return '';
  const inner = () => [...el.childNodes].map((c) => md(c, listDepth)).join('');
  switch (el.tagName) {
    case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
      return `\n\n${'#'.repeat(Number(el.tagName[1]))} ${inner().trim()}\n\n`;
    case 'P': return `\n\n${inner().trim()}\n\n`;
    case 'BR': return '\n';
    case 'HR': return '\n\n---\n\n';
    case 'STRONG': case 'B': return `**${inner()}**`;
    case 'EM': case 'I': return `*${inner()}*`;
    case 'A': return `[${inner()}](${el.href})`;
    case 'PRE': {
      const code = el.querySelector('code');
      const lang = code ? (code.className.match(/language-(\S+)/) || [])[1] || '' : '';
      return `\n\n\`\`\`${lang}\n${(code || el).textContent.replace(/\n$/, '')}\n\`\`\`\n\n`;
    }
    case 'CODE': return `\`${el.textContent}\``;
    case 'BLOCKQUOTE': return `\n\n${inner().trim().replace(/^/gm, '> ')}\n\n`;
    case 'UL': case 'OL': {
      const ordered = el.tagName === 'OL';
      const items = [...el.children].filter((c) => c.tagName === 'LI').map((li, i) => {
        const text = [...li.childNodes].map((c) => md(c, listDepth + 1)).join('').trim().replace(/\n{2,}/g, '\n');
        return `${'  '.repeat(listDepth)}${ordered ? `${i + 1}.` : '-'} ${text}`;
      });
      return `\n\n${items.join('\n')}\n\n`;
    }
    case 'TABLE': {
      const rows = [...el.querySelectorAll('tr')].map((tr) =>
        `| ${[...tr.children].map((c) => md(c).trim().replace(/\|/g, '\\|')).join(' | ')} |`);
      if (rows.length) rows.splice(1, 0, `|${' --- |'.repeat(el.querySelector('tr').children.length)}`);
      return `\n\n${rows.join('\n')}\n\n`;
    }
    case 'SPAN': {
      // The logged-out app styles bold, italic and inline code on plain spans, so read
      // the computed style and mark only where it changes from the parent.
      const text = inner();
      if (!text.trim()) return text;
      const own = getComputedStyle(el);
      const parent = getComputedStyle(el.parentElement);
      if (/mono/i.test(own.fontFamily) && !/mono/i.test(parent.fontFamily)) return `\`${el.textContent}\``;
      let out = text;
      if (Number(own.fontWeight) >= 600 && Number(parent.fontWeight) < 600) out = `**${out}**`;
      if (own.fontStyle === 'italic' && parent.fontStyle !== 'italic') out = `*${out}*`;
      return out;
    }
    default: return inner();
  }
}

function messages() {
  return [...document.querySelectorAll(MESSAGE)].map((m) => {
    const role = m.dataset.messageRole || m.dataset.messageAuthorRole;
    const body = m.querySelector(BODY) || m;
    return { role, text: md(body).replace(/\n{3,}/g, '\n\n').trim() };
  }).filter((m) => m.text && (m.role === 'user' || m.role === 'assistant'));
}

function exportChat() {
  // Signed-in chats have their own title; the logged-out page keeps ChatGPT's generic one.
  const title = /^ChatGPT\b/.test(document.title) || !document.title.trim() ? 'ChatGPT conversation' : document.title.trim();
  const parts = messages().map((m) => `## ${m.role === 'user' ? 'You' : 'ChatGPT'}\n\n${m.text}`);
  const text = `# ${title}\n\n${location.href}\n\n${parts.join('\n\n')}\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80).trim()}.md`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const button = document.createElement('button');
button.id = 'usermods-export';
button.type = 'button';
button.textContent = 'Export .md';
button.hidden = true;
button.addEventListener('click', exportChat);

// ChatGPT swaps pages without reloading, so the button is re-attached if it gets removed
// and is shown only while a conversation is on screen.
function update() {
  if (!button.isConnected) document.body.append(button);
  const show = document.querySelector(MESSAGE) !== null;
  if (button.hidden === show) button.hidden = !show;
}
new MutationObserver(update).observe(document.body, { childList: true, subtree: true });
update();
