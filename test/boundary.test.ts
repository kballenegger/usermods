// The site a run stays on (lib/agent/boundary.ts), the note (lib/agent/note.ts), who may say what to
// the background (lib/agent/senders.ts).
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { hostOf, placeName, sharesSite, siteHosts } from '../lib/agent/boundary.ts';
import { changeNote, NOTE_MAX_CHARS, noteBlock } from '../lib/agent/note.ts';
import { fromExtensionPage } from '../lib/agent/senders.ts';

test('a host, without www., and nothing for what has none', () => {
  assert.equal(hostOf('https://WWW.Example.com/a?b'), 'example.com');
  assert.equal(hostOf('not a url'), '');
  assert.equal(hostOf('file:///tmp/a.html'), '');
});

test('siblings share their last two labels, and nothing else is a sibling', () => {
  assert.equal(sharesSite('www.example.com', 'account.example.com'), true);
  assert.equal(sharesSite('shop.example.com', 'shop.example.org'), false);
  assert.equal(sharesSite('example.com', 'badexample.com'), false, 'a suffix is not a label');
  assert.equal(sharesSite('localhost', 'other'), false);
  assert.equal(sharesSite('10.0.0.1', '192.168.0.1'), false, 'addresses are not names');
  assert.equal(sharesSite('10.0.0.1', '10.0.0.1'), true, 'but a host is its own site');
  assert.equal(sharesSite('', ''), true);
  assert.equal(sharesSite('', 'example.com'), false);
});

test('a run holds its own host and the siblings the chat continued onto, never other hosts it allowed', () => {
  assert.deepEqual(siteHosts('shop.example.com', ['account.example.com', 'other.test', 'shop.example.com']), ['shop.example.com', 'account.example.com']);
});

test('the place a page went to is named even when it has no host', () => {
  assert.equal(placeName('https://evil.test/x'), 'evil.test');
  assert.equal(placeName('chrome://settings/'), 'a browser page');
  assert.equal(placeName('about:blank'), 'a browser page');
});

test('the note sets, appends and refuses what is neither', () => {
  assert.equal(changeNote('', {}).ok, false);
  assert.equal(changeNote('', { set: 4 }).ok, false);
  const set = changeNote('old', { set: 'new' });
  assert.ok(set.ok);
  assert.equal(set.note, 'new');
  const added = changeNote('a', { append: 'b' });
  assert.ok(added.ok);
  assert.equal(added.note, 'a\nb');
  const both = changeNote('old', { set: 'x', append: 'y' });
  assert.ok(both.ok);
  assert.equal(both.note, 'x\ny');
});

test('a note past its limit loses its oldest text and says so', () => {
  const r = changeNote('', { set: `old${'x'.repeat(NOTE_MAX_CHARS)}` });
  assert.ok(r.ok);
  assert.equal(r.note.length, NOTE_MAX_CHARS);
  assert.ok(!r.note.startsWith('old'));
  assert.match(r.text, /oldest text was dropped/);
});

test('an empty note rides on nothing; a real one is marked as the model’s own', () => {
  assert.equal(noteBlock('  '), '');
  assert.match(noteBlock('12 orders'), /12 orders/);
  assert.match(noteBlock('12 orders'), /not the user's words/);
});

test('only the extension’s own pages count as its pages', () => {
  const id = 'abc';
  const root = 'chrome-extension://abc/';
  assert.equal(fromExtensionPage({ id, url: 'chrome-extension://abc/sidepanel.html' }, id, root), true);
  assert.equal(fromExtensionPage({ id, url: 'chrome-extension://abc/dashboard.html' }, id, root), true, 'a tab, but ours');
  assert.equal(fromExtensionPage({ id, url: 'https://evil.test/' }, id, root), false, 'a content script on a page');
  assert.equal(fromExtensionPage({ id }, id, root), false, 'no address is no proof');
  assert.equal(fromExtensionPage({ id: 'other', url: 'chrome-extension://abc/sidepanel.html' }, id, root), false, 'another extension');
  assert.equal(fromExtensionPage({ id, url: 'https://evil.test/chrome-extension://abc/' }, id, root), false);
  assert.equal(fromExtensionPage(undefined, id, root), false);
});
