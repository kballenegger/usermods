// ==UserScript==
// @name         Block channels on YouTube
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Block button next to channel names in YouTube results and hides every video from the channels you block.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/youtube/block-channels.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/block-channels.user.js
// ==/UserScript==

// Channels to block without clicking: handles such as '@SomeChannel' or channel names
// exactly as YouTube shows them. Channels blocked with the button are added to a list kept
// in this browser's storage for youtube.com (see STORE below).
const BLOCKED = [];

// The list the Block button writes to. To unblock everything, run
// localStorage.removeItem('usermods.blockedChannels') in the console on youtube.com.
const STORE = 'usermods.blockedChannels';

function readStore() {
  try {
    const list = JSON.parse(localStorage.getItem(STORE) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

// Video tiles across YouTube. Search results and channel grids use the ytd-* renderers,
// which link the channel name to the channel. The newer lockups (the list beside a video)
// show the channel name as plain text, so they are matched by name.
const ITEMS = 'ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model';

function channelOf(item) {
  if (item.matches('yt-lockup-view-model')) {
    const nameEl = item.querySelector('yt-content-metadata-view-model > div:first-child > span');
    const link = item.querySelector('a[href^="/@"]');
    return { nameEl, name: nameEl?.textContent.trim(), handle: link?.getAttribute('href').slice(1) };
  }
  // ytd-video-renderer carries two channel names for different layouts; use the one shown.
  const names = [...item.querySelectorAll('ytd-channel-name')];
  const shown = names.find((n) => n.checkVisibility()) ?? names[0];
  const link = shown?.querySelector('a[href^="/@"], a[href^="/channel/"]');
  return {
    nameEl: shown,
    name: shown?.querySelector('#text')?.textContent.trim(),
    handle: link?.getAttribute('href').slice(1),
  };
}

function isBlocked({ name, handle }, handles, names) {
  return (handle !== undefined && handles.has(handle)) || (name !== undefined && names.has(name));
}

function update() {
  const entries = [...BLOCKED.map((b) => (b.startsWith('@') ? { handle: b } : { name: b })), ...readStore()];
  const handles = new Set(entries.map((e) => e.handle).filter(Boolean));
  const names = new Set(entries.map((e) => e.name).filter(Boolean));
  for (const item of document.querySelectorAll(ITEMS)) {
    // A lockup inside a rich grid item is handled through the outer item.
    if (item.matches('yt-lockup-view-model') && item.closest('ytd-rich-item-renderer')) continue;
    const target = item.matches('ytd-rich-item-renderer') ? (item.querySelector('yt-lockup-view-model') ?? item) : item;
    const channel = channelOf(target);
    if (!channel.name && !channel.handle) continue;
    item.toggleAttribute('data-usermods-blocked', isBlocked(channel, handles, names));
    addButton(channel.nameEl);
  }
}

function addButton(nameEl) {
  if (!nameEl || nameEl.nextElementSibling?.classList.contains('usermods-block-channel')) return;
  const button = document.createElement('button');
  button.className = 'usermods-block-channel';
  button.type = 'button';
  button.textContent = 'Block';
  button.title = 'Hide every video from this channel';
  button.addEventListener('click', (event) => {
    // Tiles are links; keep the click from opening the video.
    event.preventDefault();
    event.stopPropagation();
    const item = button.closest(ITEMS);
    const { name, handle } = channelOf(item);
    const list = readStore();
    list.push(handle ? { handle, name } : { name });
    localStorage.setItem(STORE, JSON.stringify(list));
    update();
  }, true);
  nameEl.after(button);
}

GM_addStyle(`
  [data-usermods-blocked] {
    display: none !important;
  }
  .usermods-block-channel {
    margin-left: 6px;
    padding: 0 6px;
    border: 1px solid currentColor;
    border-radius: 4px;
    background: none;
    color: var(--yt-spec-text-secondary, #606060);
    font: 500 11px/16px Roboto, Arial, sans-serif;
    cursor: pointer;
    opacity: 0.6;
  }
  .usermods-block-channel:hover {
    opacity: 1;
  }
`);

// YouTube builds results after the script starts and keeps adding them as you scroll or
// move between pages, so the list is re-applied whenever the page changes.
let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    update();
  }, 50);
}).observe(document.documentElement, { childList: true, subtree: true });
