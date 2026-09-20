// The popup's shell decisions: the keyboard inset, the target-tab chip, the localhost note and
// which of the two layouts to draw. Pure functions, so the arithmetic and the wording are checked
// here and the screenshots only have to prove the layout.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { KEYBOARD_EPSILON_PX, ROOMY_MIN_WIDTH_PX, isLocalBaseUrl, keyboardInset, localBaseUrlNote, popupLayout, targetChip } from '../lib/mobile.ts';

test('a closed keyboard is no inset', () => {
  // The state this is in almost all the time: the visual viewport is the window.
  assert.equal(keyboardInset({ height: 800, offsetTop: 0 }, 800), 0);
});

test('an open keyboard is the part of the window it covers', () => {
  assert.equal(keyboardInset({ height: 460, offsetTop: 0 }, 800), 340);
});

test('a viewport scrolled by iOS does not overstate the inset', () => {
  // iOS scrolls within the visual viewport to keep a focused field visible. Ignoring offsetTop would
  // count that scroll as more keyboard and leave the composer floating above it.
  assert.equal(keyboardInset({ height: 460, offsetTop: 120 }, 800), 220);
});

test('a pixel of wobble is not a layout change', () => {
  assert.equal(keyboardInset({ height: 799.5, offsetTop: 0 }, 800), 0);
  assert.equal(keyboardInset({ height: 800 - KEYBOARD_EPSILON_PX + 1, offsetTop: 0 }, 800), 0);
  assert.equal(keyboardInset({ height: 800 - KEYBOARD_EPSILON_PX, offsetTop: 0 }, 800), KEYBOARD_EPSILON_PX);
});

test('a missing or nonsense viewport is no inset, never a NaN in the stylesheet', () => {
  assert.equal(keyboardInset(null, 800), 0);
  assert.equal(keyboardInset(undefined, 800), 0);
  assert.equal(keyboardInset({ height: Number.NaN, offsetTop: 0 }, 800), 0);
  assert.equal(keyboardInset({ height: 400, offsetTop: Number.NaN }, 800), 0);
  assert.equal(keyboardInset({ height: 400, offsetTop: 0 }, Number.NaN), 0);
  assert.equal(keyboardInset({ height: Number.POSITIVE_INFINITY, offsetTop: 0 }, 800), 0);
});

test('a keyboard taller than the window still yields a whole number', () => {
  const inset = keyboardInset({ height: 100.4, offsetTop: 0 }, 800.2);
  assert.equal(Number.isInteger(inset), true);
});

test('a normal page names its host and path', () => {
  const t = targetChip('https://en.wikipedia.org/wiki/Cat?action=view');
  assert.deepEqual(t, { host: 'en.wikipedia.org', path: '/wiki/Cat?action=view', fallback: '', live: true });
});

test('www is dropped and a bare origin has no path to show', () => {
  assert.equal(targetChip('https://www.example.com/').host, 'example.com');
  assert.equal(targetChip('https://www.example.com/').path, '');
  assert.equal(targetChip('https://example.com').path, '');
});

test('a page usermods cannot reach says so instead of showing a blank', () => {
  // The header is the only thing on screen naming the target, so "nothing here" has to be a sentence.
  for (const url of ['chrome://extensions', 'about:blank', 'file:///Users/x/page.html']) {
    const t = targetChip(url);
    assert.equal(t.live, false);
    assert.equal(t.host, '');
    assert.match(t.fallback, /usermods cannot run on/);
  }
  assert.match(targetChip('chrome://extensions').fallback, /chrome: pages/);
});

test('no page at all is its own message', () => {
  for (const url of ['', 'not a url', 'example.com']) {
    assert.deepEqual(targetChip(url), { host: '', path: '', fallback: 'No page open', live: false });
  }
});

test('the local hosts are the ones that mean this phone', () => {
  for (const url of ['http://localhost:1234/v1', 'http://127.0.0.1:8080', 'http://[::1]:11434', 'http://0.0.0.0:5000', 'http://ollama.localhost/v1']) {
    assert.equal(isLocalBaseUrl(url), true, `${url} is local`);
  }
  for (const url of ['https://api.openai.com/v1', 'http://192.168.1.10:1234/v1', 'http://my-laptop.local:1234', '', 'localhost:1234']) {
    assert.equal(isLocalBaseUrl(url), false, `${url} is not local`);
  }
});

test('the localhost note says what to type instead, not just what is wrong', () => {
  for (const coarse of [true, false]) {
    const note = localBaseUrlNote(coarse);
    // An example address, because "use your machine's IP" is advice and "http://192.168…" is an answer.
    assert.match(note, /192\.168\./);
    // Straight quotes only: the whole codebase is checked for this and a curly one in a string is the
    // easiest place for it to hide.
    assert.doesNotMatch(note, /[‘’“”—]/);
  }
});

test('the localhost note means a different machine on a phone than on a Mac', () => {
  // On iOS localhost is the phone, and a model is almost never running there, so the note is a
  // warning. On a Mac localhost is the Mac, which is where LM Studio and Ollama actually run, so
  // the same wording would be telling someone their working setup is wrong.
  assert.match(localBaseUrlNote(true), /localhost is this device/);
  assert.match(localBaseUrlNote(false), /localhost is this Mac/);
  assert.match(localBaseUrlNote(false), /usually what you want/);
});

test('a thumb gets the compact layout at any width', () => {
  // iPadOS reports a coarse pointer even with a keyboard attached, and its popover is wide enough
  // for the roomy shell. The pointer is what decides, because the targets are what change.
  for (const width of [320, 390, 500, 1024]) {
    assert.equal(popupLayout({ coarsePointer: true, width }), 'compact');
  }
});

test('a mouse gets the roomy layout once there is room for it', () => {
  assert.equal(popupLayout({ coarsePointer: false, width: ROOMY_MIN_WIDTH_PX }), 'roomy');
  assert.equal(popupLayout({ coarsePointer: false, width: 420 }), 'roomy');
  // Narrower than the shell needs for a header and three tabs: fall back rather than overflow.
  assert.equal(popupLayout({ coarsePointer: false, width: ROOMY_MIN_WIDTH_PX - 1 }), 'compact');
  assert.equal(popupLayout({ coarsePointer: false, width: 0 }), 'compact');
});

test('a width the browser could not give us is compact, never a broken shell', () => {
  assert.equal(popupLayout({ coarsePointer: false, width: Number.NaN }), 'compact');
  assert.equal(popupLayout({ coarsePointer: false, width: Number.POSITIVE_INFINITY }), 'compact');
});
