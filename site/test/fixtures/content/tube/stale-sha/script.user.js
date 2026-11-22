// ==UserScript==
// @name         Disable autoplay
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0
// @description  Disable autoplay </script> & <b>
// @match        https://tube.example/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/tube/stale-sha.user.js
// @updateURL    https://usermods.kennethballenegger.com/tube/stale-sha.user.js
// ==/UserScript==
GM_addStyle('.thing { display: none !important; }');
