// ==UserScript==
// @name         Remove sidebar
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0
// @description  Remove sidebar </script> & <b>
// @match        https://forum.example/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/forum/only-fails.user.js
// @updateURL    https://usermods.kennethballenegger.com/forum/only-fails.user.js
// ==/UserScript==
GM_addStyle('.thing { display: none !important; }');
