// ==UserScript==
// @name         Hide news sources on Yahoo News
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a hide button next to each publisher name on Yahoo News and the Yahoo homepage, and hides every story from the publishers you block.
// @match        https://www.yahoo.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/yahoo/block-news-sources.user.js
// @updateURL    https://usermods.kennethballenegger.com/yahoo/block-news-sources.user.js
// ==/UserScript==

// Publishers to hide even before you click anything, e.g. ['HuffPost', 'Fox News'].
// Names must match the source line under the headline exactly.
const ALWAYS_HIDE = [];

const KEY = 'usermods-yahoo-blocked-sources';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
const save = (list) => localStorage.setItem(KEY, JSON.stringify(list));

GM_addStyle(`
  .um-hidden-story { display: none !important; }
  .um-block-source { margin-left: 6px; padding: 0 5px; border: 1px solid #ccc; border-radius: 8px;
    background: transparent; color: #666; font: 11px/16px sans-serif; cursor: pointer; }
  .um-block-source:hover { color: #c00; border-color: #c00; }
  #um-blocked-bar { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; padding: 6px 10px;
    background: #fff; color: #333; border: 1px solid #ccc; border-radius: 6px; font: 12px/1.4 sans-serif; }
  #um-blocked-bar button { margin-left: 8px; font: inherit; cursor: pointer; }
`);

// Every story link carries tracking data in data-yga, including the publisher
// ("yContentPartner") and the story id ("yDestinationContentUUID"). That is steadier
// than Yahoo's utility class names.
function info(a) {
  try {
    const d = JSON.parse(a.dataset.yga);
    return d.yContentPartner ? { source: d.yContentPartner, id: d.yDestinationContentUUID } : null;
  } catch { return null; }
}

// The story card is the largest ancestor that holds links to this one story only.
function card(a, id) {
  let el = a;
  while (el.parentElement && el.parentElement !== document.body) {
    const ids = new Set([...el.parentElement.querySelectorAll('a[data-yga*="yDestinationContentUUID"]')]
      .map((l) => (info(l) || {}).id).filter(Boolean));
    if (ids.size > 1 || (ids.size === 1 && !ids.has(id))) break;
    el = el.parentElement;
  }
  return el;
}

function addButton(c, source) {
  if (c.querySelector('.um-block-source')) return;
  // The source name is a small span whose text is exactly the publisher name.
  const label = [...c.querySelectorAll('span, div')].find((e) => e.children.length === 0 && e.textContent.trim() === source);
  if (!label) return;
  const b = document.createElement('button');
  b.className = 'um-block-source';
  b.type = 'button';
  b.textContent = 'hide';
  b.title = `Hide stories from ${source}`;
  b.dataset.source = source;
  b.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const list = load();
    if (!list.includes(source)) save([...list, source]);
    apply();
  });
  label.after(b);
}

function bar(list) {
  let el = document.getElementById('um-blocked-bar');
  if (!list.length) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'um-blocked-bar';
    document.body.append(el);
  }
  const text = `Hidden sources: ${list.join(', ')}`;
  if (el.firstChild && el.firstChild.textContent === text) return;
  el.textContent = text;
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Show all';
  reset.addEventListener('click', () => { save([]); apply(); });
  el.append(reset);
}

function apply() {
  if (!document.body) return;
  const stored = load();
  const blocked = new Set([...ALWAYS_HIDE, ...stored]);
  const seen = new Set();
  for (const a of document.querySelectorAll('a[data-yga*="yContentPartner"]')) {
    const i = info(a);
    if (!i || !i.id) continue;
    const c = card(a, i.id);
    if (!seen.has(c)) { seen.add(c); addButton(c, i.source); }
    c.classList.toggle('um-hidden-story', blocked.has(i.source));
  }
  bar(stored);
}

// Stories load as you scroll, so re-apply after changes, at most once per frame.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; apply(); });
}).observe(document.documentElement, { childList: true, subtree: true });
document.addEventListener('DOMContentLoaded', apply);
