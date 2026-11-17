// ==UserScript==
// @name         Hide Shorts
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0
// @description  Hide Shorts </script> & <b>
// @match        https://tube.example/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/tube/hide-shorts.user.js
// @updateURL    https://usermods.kennethballenegger.com/tube/hide-shorts.user.js
// ==/UserScript==
GM_addStyle('.thing { display: none !important; }');
