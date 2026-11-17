// ==UserScript==
// @name         Use dark mode on Hugging Face without logging in
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Keeps huggingface.co in its own dark theme for logged-out visitors, whatever the system light or dark setting.
// @match        https://huggingface.co/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/huggingface/dark-mode.user.js
// @updateURL    https://usermods.kennethballenegger.com/huggingface/dark-mode.user.js
// ==/UserScript==

// Hugging Face ships a full dark theme, switched on by a "dark" class on <html>. For guests an
// inline script sets that class from the system colour scheme, and nothing offers a switch.
// Add the class now and put it back whenever the page removes it.
const root = document.documentElement;
const force = () => { if (!root.classList.contains('dark')) root.classList.add('dark'); };
force();
new MutationObserver(force).observe(root, { attributes: true, attributeFilter: ['class'] });
