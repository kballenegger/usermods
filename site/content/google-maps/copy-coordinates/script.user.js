// ==UserScript==
// @name         Copy coordinates from Google Maps
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Adds a Copy coordinates button to Google Maps that copies the open place's latitude and longitude, or the map centre's.
// @match        https://www.google.com/maps*
// @run-at       document-idle
// @grant        GM_addStyle
// @downloadURL  https://usermods.kennethballenegger.com/google-maps/copy-coordinates.user.js
// @updateURL    https://usermods.kennethballenegger.com/google-maps/copy-coordinates.user.js
// ==/UserScript==

// Google Maps keeps the position in the address bar. A place page has the place's own
// position as !3d<lat>!4d<lng>; every map view has the map centre as @<lat>,<lng>,<zoom>z.
// The button reads the address when clicked, so it is right after you pan or open a place.
GM_addStyle(`
  #usermods-copy-coords {
    position: fixed;
    bottom: 32px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 1000;
    padding: 6px 14px;
    border: 0;
    border-radius: 999px;
    background: #fff;
    color: #1f1f1f;
    font: 500 13px/1.4 Roboto, Arial, sans-serif;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }
  #usermods-copy-coords:hover { background: #f1f3f4; }
`);

function coordinates() {
  const url = decodeURIComponent(location.href);
  const place = url.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (place) return `${place[1]}, ${place[2]}`;
  const centre = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
  if (centre) return `${centre[1]}, ${centre[2]}`;
  return null;
}

const button = document.createElement('button');
button.id = 'usermods-copy-coords';
button.type = 'button';
button.textContent = 'Copy coordinates';
button.addEventListener('click', async () => {
  const text = coordinates();
  if (!text) {
    button.textContent = 'No coordinates in this view';
  } else {
    await navigator.clipboard.writeText(text);
    button.textContent = `Copied ${text}`;
  }
  setTimeout(() => { button.textContent = 'Copy coordinates'; }, 2000);
});
document.body.append(button);
