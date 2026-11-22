// ==UserScript==
// @name         Hide comments
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0
// @description  Hide comments </script> & <b>
// @match        https://tube.example/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/tube/blocked-later.user.js
// @updateURL    https://usermods.kennethballenegger.com/tube/blocked-later.user.js
// ==/UserScript==
GM_addStyle('.thing { display: none !important; }');
