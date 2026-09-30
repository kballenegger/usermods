// Which execution primitive a runtime gets, and what the panel says when mods cannot run.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { evalBlockedMessage, execStatus, pickEngine, readProbe, type ProbeSource } from '../lib/exec/engine.ts';

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

/** A Chrome build's manifest, as `chrome.runtime.getManifest()` returns it. */
const CHROME_MANIFEST = { permissions: ['sidePanel', 'storage', 'scripting', 'userScripts', 'declarativeNetRequest'] };
const SAFARI_MANIFEST = { permissions: ['storage', 'scripting', 'tabs', 'declarativeNetRequest'] };

// The three states below are what Chrome 153 actually presents, read from a live profile: with the
// toggle off `chrome.userScripts` is undefined (in the worker and in extension pages), and turning
// it on adds the namespace to the worker that is already running.
test('a fresh Chrome install, toggle off, is a userScripts build that is not yet permitted', () => {
  const fresh: ProbeSource = { runtime: { getManifest: () => CHROME_MANIFEST }, sidePanel: {} };
  const probe = readProbe(fresh, CHROME);
  assert.deepEqual(probe, { api: true, permitted: false, sidePanel: true, userAgent: CHROME });
  // The regression this guards: the missing namespace used to read as "no userScripts here", which
  // picked Safari's engine on Chrome, reported ready, and showed no setup instructions.
  const s = execStatus(probe);
  assert.equal(s.engine, 'user-scripts');
  assert.equal(s.available, false);
  assert.match(s.message, /Allow User Scripts/);
});

test('Chrome with the toggle on is permitted', () => {
  const on: ProbeSource = { runtime: { getManifest: () => CHROME_MANIFEST }, userScripts: { getScripts: () => Promise.resolve([]) }, sidePanel: {} };
  assert.deepEqual(execStatus(readProbe(on, CHROME)), { available: true, message: '', engine: 'user-scripts' });
});

test('a namespace whose call throws is not permitted either', () => {
  const throws: ProbeSource = {
    runtime: { getManifest: () => CHROME_MANIFEST },
    userScripts: {
      getScripts: () => {
        throw new Error("The 'userScripts' API is only available for users in developer mode.");
      },
    },
    sidePanel: {},
  };
  assert.equal(readProbe(throws, CHROME).permitted, false);
});

test('Safari, whose manifest never asks for userScripts, gets the content-script engine', () => {
  const safari: ProbeSource = { runtime: { getManifest: () => SAFARI_MANIFEST } };
  const probe = readProbe(safari, SAFARI);
  assert.deepEqual(probe, { api: false, permitted: false, sidePanel: false, userAgent: SAFARI });
  assert.equal(execStatus(probe).engine, 'content-script');
});

test('a getManifest that throws (the build-time fake browser) does not take the import down', () => {
  const fake: ProbeSource = {
    runtime: {
      getManifest: () => {
        throw new Error('runtime.getManifest not implemented');
      },
    },
  };
  assert.equal(readProbe(fake, '').api, false);
});

test('no chrome object at all (node) reads as nothing available, without throwing', () => {
  assert.deepEqual(readProbe(undefined, ''), { api: false, permitted: false, sidePanel: false, userAgent: '' });
});

test('the engine follows whether the build asks for userScripts, not the permission', () => {
  assert.equal(pickEngine({ api: true }), 'user-scripts');
  // The toggle being off is Chrome's problem to report, not a reason to quietly run a different
  // engine whose CSP behaviour differs from the one the user's mods were written against.
  assert.equal(pickEngine({ api: false }), 'content-script');
});

test('Chrome with the toggle off is unavailable and says which toggle', () => {
  const s = execStatus({ api: true, permitted: false, sidePanel: true, userAgent: CHROME });
  assert.equal(s.engine, 'user-scripts');
  assert.equal(s.available, false);
  assert.match(s.message, /Allow User Scripts/);
});

test('an older Chrome is told about Developer Mode instead', () => {
  const old = CHROME.replace('Chrome/140', 'Chrome/137');
  const s = execStatus({ api: true, permitted: false, sidePanel: true, userAgent: old });
  assert.match(s.message, /Developer mode/);
});

test('Safari is available with no message: there is no permission to ask for', () => {
  const s = execStatus({ api: false, permitted: false, sidePanel: false, userAgent: SAFARI });
  assert.deepEqual(s, { available: true, message: '', engine: 'content-script' });
});

test('a blocked page is named, and neither message offers to weaken the site CSP', () => {
  const main = evalBlockedMessage('MAIN', 'example.com');
  const iso = evalBlockedMessage('USER_SCRIPT', 'example.com');
  for (const m of [main, iso]) {
    assert.match(m, /example\.com/);
    assert.match(m, /Content-Security-Policy/);
    // The one promise these messages must never break.
    assert.doesNotMatch(m, /disable|turn off|allow inline|strip/i);
  }
  // The page-world failure has a way out that does not involve the site: run in the isolated world.
  assert.match(main, /isolated world/);
  assert.match(main, /@grant none/);
});

test('a page with no host still reads as a sentence', () => {
  assert.match(evalBlockedMessage('USER_SCRIPT', ''), /^this page/);
});
