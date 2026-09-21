// Which execution primitive a runtime gets, and what the panel says when mods cannot run.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { evalBlockedMessage, execStatus, pickEngine } from '../lib/exec/engine.ts';

const CHROME = 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

test('the engine follows the userScripts namespace, not the permission', () => {
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
