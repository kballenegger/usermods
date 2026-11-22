// ==UserScript==
// @name         Turn off 60fps video on YouTube
// @namespace    https://usermods.kennethballenegger.com
// @version      1.0.0
// @description  Makes YouTube play 30fps versions of videos instead of 60fps, which uses less CPU and battery.
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @downloadURL  https://usermods.kennethballenegger.com/youtube/disable-60fps.user.js
// @updateURL    https://usermods.kennethballenegger.com/youtube/disable-60fps.user.js
// ==/UserScript==

// Highest frame rate to allow. YouTube encodes most videos at 24, 25 or 30fps and offers
// separate 50 and 60fps streams for some.
const MAX_FPS = 30;

// Before it builds its quality list, YouTube's player asks the browser which formats it can
// play, passing each stream's frame rate. Saying "no" to anything above MAX_FPS makes the
// player leave those streams out, so every quality it offers is a 30fps one. This has to run
// before the player starts, hence document-start and "@grant none" (it patches the page's
// own MediaSource and mediaCapabilities).
if (window.MediaSource) {
  const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = (type) => {
    const fps = /framerate=(\d+)/.exec(type);
    if (fps && Number(fps[1]) > MAX_FPS) return false;
    return isTypeSupported(type);
  };
}

if (navigator.mediaCapabilities) {
  const decodingInfo = navigator.mediaCapabilities.decodingInfo.bind(navigator.mediaCapabilities);
  navigator.mediaCapabilities.decodingInfo = (config) => {
    if (config?.video?.framerate > MAX_FPS) {
      return Promise.resolve({ supported: false, smooth: false, powerEfficient: false });
    }
    return decodingInfo(config);
  };
}
