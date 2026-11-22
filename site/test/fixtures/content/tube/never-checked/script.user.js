// ==UserScript==
// @name         Hide footer
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0
// @description  Hide footer </script> & <b>
// @match        https://tube.example/*
// @run-at       document-start
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/tube/never-checked.user.js
// @updateURL    https://usermods.kennethballenegger.com/tube/never-checked.user.js
// ==/UserScript==
GM_addStyle('.thing { display: none !important; }');
