// ==UserScript==
// @name         Jump between messages in long ChatGPT chats
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.1
// @description  Adds a list of your questions at the side of a ChatGPT chat; click one to scroll back to it.
// @match        https://chatgpt.com/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/chatgpt/message-navigator.user.js
// @updateURL    https://usermods.kennethballenegger.com/chatgpt/message-navigator.user.js
// ==/UserScript==

(() => {
  // Each of your messages is an <li data-message-role="user"> with the text in
  // p[data-user-message-copy]. The list is rebuilt whenever that set of messages changes,
  // which also covers switching chats without a page load.
  GM_addStyle(`
    #usermods-nav {
      position: fixed; top: 72px; right: 12px; z-index: 30; width: 150px; max-height: 60vh;
      overflow-y: auto; padding: 6px; border-radius: 10px; font-size: 12px; line-height: 1.3;
      background: rgba(127, 127, 127, 0.1); backdrop-filter: blur(6px);
    }
    #usermods-nav[hidden] { display: none; }
    #usermods-nav button {
      display: block; width: 100%; text-align: start; padding: 5px 6px; border: 0; border-radius: 6px; background: transparent;
      color: inherit; opacity: 0.75; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #usermods-nav button:hover, #usermods-nav button:focus-visible { opacity: 1; background: rgba(127, 127, 127, 0.18); }
    li[data-message-role="user"] { scroll-margin-top: 72px; }
  `);

  let nav = null;
  let shown = '';

  function render() {
    const messages = [...document.querySelectorAll('li[data-message-role="user"]')];
    const key = messages.map((m) => m.id).join(',');
    if (nav && nav.isConnected && key === shown) return;
    shown = key;
    if (!nav || !nav.isConnected) {
      if (!document.body) return;
      nav = document.createElement('nav');
      nav.id = 'usermods-nav';
      nav.setAttribute('aria-label', 'Your messages');
      document.body.append(nav);
    }
    nav.replaceChildren();
    // One question is not worth a list.
    nav.hidden = messages.length < 2;
    messages.forEach((message, i) => {
      const text = (message.querySelector('p[data-user-message-copy]')?.textContent ?? message.textContent).trim();
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = `${i + 1}. ${text}`;
      button.title = text;
      button.addEventListener('click', () => message.scrollIntoView({ block: 'start', behavior: 'smooth' }));
      nav.append(button);
    });
  }

  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      render();
    });
  }).observe(document, { childList: true, subtree: true });
})();
