// Finding 5: saving an edited mod source.
//
// The dashboard's source editor used to save through rpc 'mods.save', which is an upsert of a Mod
// the page built plus a re-register, and nothing else. The Mod it built carried the OLD @require
// and @resource bodies (or none at all, for a mod that had never had any), under a freshly parsed
// header that named new ones. The script was then re-registered with a dependency it did not have,
// so it threw ReferenceError at page load — with nothing on screen to say why, because the save
// itself reported success.
//
// The save now goes through the background's mods.saveSource, whose decisions are these two pure
// functions: reparseEditedSource (what survives an edit) and dependenciesChanged (whether the
// header's dependency lines actually moved, so an ordinary edit does not pay for a network round
// trip on every save).
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { dependenciesChanged, reparseEditedSource } from '../lib/install.ts';
import { modFromSource } from '../lib/mods.ts';
import type { Mod } from '../lib/types.ts';

const header = (over: { requires?: string[]; resources?: string[]; match?: string; name?: string } = {}) =>
  [
    '// ==UserScript==',
    `// @name        ${over.name ?? 'Test mod'}`,
    '// @version     1.0',
    `// @match       ${over.match ?? 'https://example.com/*'}`,
    ...(over.requires ?? []).map((u) => `// @require     ${u}`),
    ...(over.resources ?? []).map((r) => `// @resource    ${r}`),
    '// ==/UserScript==',
    '',
    'console.log("body");',
    '',
  ].join('\n');

/** A saved mod, with whatever dependency bodies a previous install fetched for it. */
function installed(source: string, over: Partial<Mod> = {}): Mod {
  return {
    ...modFromSource(source),
    id: 'mod-1',
    enabled: true,
    createdAt: 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// dependenciesChanged: the reason an edited mod threw ReferenceError
// ---------------------------------------------------------------------------

test('finding 5: adding an @require line to a mod that had none is a dependency change', () => {
  // The bug in one line. The old path saved this mod with requires: [] — jQuery was never fetched,
  // the registered code had no $ in it, and the script threw on the next page load.
  const before = installed(header());
  assert.equal(before.requires.length, 0);
  const after = header({ requires: ['https://code.jquery.com/jquery-3.7.1.min.js'] });
  assert.equal(dependenciesChanged(after, before), true, 'the new @require must be fetched before this is saved');
});

test('finding 5: changing an @require URL is a change, even to the same library', () => {
  const before = installed(header({ requires: ['https://cdn.example/lib-1.0.js'] }), {
    requires: [{ url: 'https://cdn.example/lib-1.0.js', code: 'var lib=1;' }],
  });
  const after = header({ requires: ['https://cdn.example/lib-2.0.js'] });
  assert.equal(dependenciesChanged(after, before), true, 'the stored body is 1.0, the header now says 2.0');
});

test('finding 5: removing an @require line is a change', () => {
  const before = installed(header({ requires: ['https://cdn.example/lib.js'] }), {
    requires: [{ url: 'https://cdn.example/lib.js', code: 'var lib=1;' }],
  });
  assert.equal(dependenciesChanged(header(), before), true, 'the body must stop being concatenated in');
});

test('finding 5: reordering two @require lines is a change, because load order is semantics', () => {
  const urls = ['https://cdn.example/jquery.js', 'https://cdn.example/plugin.js'];
  const before = installed(header({ requires: urls }), {
    requires: urls.map((url) => ({ url, code: `/* ${url} */` })),
  });
  const after = header({ requires: [...urls].reverse() });
  assert.equal(dependenciesChanged(after, before), true, 'a plugin loaded before jQuery is not the same script');
});

test('finding 5: an @resource line added, renamed or repointed is a change', () => {
  const plain = installed(header());
  assert.equal(dependenciesChanged(header({ resources: ['icons https://cdn.example/icons.css'] }), plain), true);

  const withRes = installed(header({ resources: ['icons https://cdn.example/icons.css'] }), {
    resources: [{ name: 'icons', url: 'https://cdn.example/icons.css', mime: 'text/css', text: 'a{}', base64: '' }],
  });
  assert.equal(
    dependenciesChanged(header({ resources: ['theme https://cdn.example/icons.css'] }), withRes),
    true,
    'the same bytes under a new name: GM_getResourceText("icons") would stop working',
  );
  assert.equal(
    dependenciesChanged(header({ resources: ['icons https://cdn.example/icons-v2.css'] }), withRes),
    true,
    'the same name pointing somewhere else: the stored bytes are the old file',
  );
});

test('finding 5: an edit that leaves the dependency lines alone refetches nothing', () => {
  // The other half of the rule. A one-character change to the body must not put a network round
  // trip in front of Save, and must not risk a save failing because a CDN is down.
  const requires = ['https://cdn.example/lib.js'];
  const resources = ['icons https://cdn.example/icons.css'];
  const before = installed(header({ requires, resources }), {
    requires: [{ url: 'https://cdn.example/lib.js', code: 'var lib=1;' }],
    resources: [{ name: 'icons', url: 'https://cdn.example/icons.css', mime: 'text/css', text: 'a{}', base64: '' }],
  });
  const edited = header({ requires, resources, name: 'Renamed by the editor', match: 'https://example.com/other/*' })
    .replace('console.log("body");', 'console.log("edited body");');
  assert.equal(dependenciesChanged(edited, before), false, 'the header renamed, re-matched and the body changed — the deps did not');
});

test('finding 5: a mod with no dependencies either side is unchanged', () => {
  assert.equal(dependenciesChanged(header({ name: 'after' }), installed(header({ name: 'before' }))), false);
});

// ---------------------------------------------------------------------------
// reparseEditedSource: what an edit may change, and what it may never touch
// ---------------------------------------------------------------------------

test('finding 5: an edit keeps the mod identity that its registration and GM store hang off', () => {
  const before = installed(header(), {
    id: 'keep-this-id',
    enabled: false,
    createdAt: 4242,
    downloadUrl: 'https://greasyfork.org/scripts/1.user.js',
  });
  const after = reparseEditedSource(before, header({ name: 'Renamed by the editor' }));
  assert.equal(after.id, 'keep-this-id', 'a new id would orphan the gm:<id> value store and double-register the script');
  assert.equal(after.enabled, false, 'editing a disabled mod must not switch it on');
  assert.equal(after.createdAt, 4242);
  assert.equal(after.downloadUrl, 'https://greasyfork.org/scripts/1.user.js', 'the Update button does not vanish because a comment line went');
  assert.equal(after.name, 'Renamed by the editor', 'and the header still decides everything it decides');
});

test('finding 5: an edit carries the already-fetched dependency bodies forward', () => {
  // When dependenciesChanged says no, these are the bodies the mod is re-registered with — so they
  // have to survive the reparse rather than being reset to [].
  const requires = [{ url: 'https://cdn.example/lib.js', code: 'var lib=1;' }];
  const before = installed(header({ requires: ['https://cdn.example/lib.js'] }), { requires });
  const after = reparseEditedSource(before, header({ requires: ['https://cdn.example/lib.js'], name: 'Edited' }));
  assert.deepEqual(after.requires, requires, 'dropping these would be the same ReferenceError by another route');
});

test('finding 5: deleting the last @match line really deletes it', () => {
  // modFromSource falls back to the existing mod's patterns when the new header has none, which is
  // right for an install and wrong for an edit: the user removing a @match is telling the mod to
  // stop running on that site, and falling back would keep it running there.
  const before = installed(header({ match: 'https://example.com/*' }));
  assert.deepEqual(before.matches, ['https://example.com/*']);
  const stripped = header().replace(/^\/\/ @match.*$\n/m, '');
  const after = reparseEditedSource(before, stripped);
  assert.deepEqual(after.matches, [], 'the background rejects this save rather than leaving the old patterns in place');
});

test('finding 5: an edit that changes the patterns follows the header', () => {
  const before = installed(header({ match: 'https://example.com/*' }));
  const after = reparseEditedSource(before, header({ match: 'https://other.example/*' }));
  assert.deepEqual(after.matches, ['https://other.example/*']);
});

test('finding 5: a @downloadURL added by the edit wins over the stored one', () => {
  const before = installed(header(), { downloadUrl: 'https://old.example/a.user.js' });
  const source = header().replace('// ==/UserScript==', '// @downloadURL https://new.example/a.user.js\n// ==/UserScript==');
  assert.equal(reparseEditedSource(before, source).downloadUrl, 'https://new.example/a.user.js');
});
