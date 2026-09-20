// The wire between the mod runner and the background, driven with the messages a hostile sender
// would actually send.
//
// Under the content-script engine this traffic shares runtime.onMessage with the panel, the
// dashboard and every content script, so parsing IS the security boundary. The property that matters
// most is negative: there is no modId on this wire, so no message can put one there.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { EXEC_TAG, execKind, gmMessageFor, parseBlocked, parseClaim, parseGm } from '../lib/exec/protocol.ts';

test('only the three known kinds are recognised', () => {
  assert.equal(execKind({ [EXEC_TAG]: 'claim' }), 'claim');
  assert.equal(execKind({ [EXEC_TAG]: 'gm' }), 'gm');
  assert.equal(execKind({ [EXEC_TAG]: 'blocked' }), 'blocked');
  for (const bogus of [null, undefined, 'claim', 42, {}, { [EXEC_TAG]: 'run-once' }, { type: 'gm' }]) {
    assert.equal(execKind(bogus), null, `${JSON.stringify(bogus)} must not be an exec message`);
  }
});

test('a GM request carries no modId, however hard the sender tries', () => {
  const req = parseGm({
    [EXEC_TAG]: 'gm',
    token: 'tok',
    call: 'gm.setValue',
    key: 'k',
    value: 1,
    // Everything below is what an attacker would add. None of it survives the parse.
    modId: 'someone-else',
    __usermods: true,
    grant: { modId: 'someone-else' },
    proto: '__proto__',
  });
  assert.ok(req);
  assert.equal('modId' in req, false);
  assert.equal((req as unknown as Record<string, unknown>).__usermods, undefined);
  assert.equal((req as unknown as Record<string, unknown>).grant, undefined);
  assert.deepEqual(Object.keys(req).sort(), ['call', 'key', 'token', 'value']);
});

test('the modId is the grant, written last, and the request has nothing to overwrite it with', () => {
  const req = parseGm({ [EXEC_TAG]: 'gm', token: 'tok', call: 'gm.xhr', modId: 'someone-else' })!;
  const msg = gmMessageFor(req, { modId: 'mod-a' });
  assert.equal(msg.modId, 'mod-a');
  assert.equal(msg.type, 'gm.xhr');
  assert.equal(msg.__usermods, true);
});

test('an unknown GM call is refused rather than passed through', () => {
  for (const call of ['gm.deleteAll', 'gm.eval', 'chrome.tabs.create', '', 'GM.setValue', 'gm.setvalue', 42, null]) {
    assert.equal(parseGm({ [EXEC_TAG]: 'gm', token: 'tok', call }), null, `${JSON.stringify(call)} must be refused`);
  }
  for (const call of ['gm.setValue', 'gm.deleteValue', 'gm.xhr', 'gm.openInTab', 'gm.log']) {
    assert.ok(parseGm({ [EXEC_TAG]: 'gm', token: 'tok', call }), `${call} must be allowed`);
  }
});

test('a GM request with no token is refused: there is nothing to resolve', () => {
  assert.equal(parseGm({ [EXEC_TAG]: 'gm', call: 'gm.log' }), null);
  assert.equal(parseGm({ [EXEC_TAG]: 'gm', token: '', call: 'gm.log' }), null);
  assert.equal(parseGm({ [EXEC_TAG]: 'gm', token: 123, call: 'gm.log' }), null);
  assert.equal(parseGm({ [EXEC_TAG]: 'gm', token: { toString: () => 'tok' }, call: 'gm.log' }), null);
});

test('xhr details are copied field by field, so an invented one cannot ride along', () => {
  const req = parseGm({
    [EXEC_TAG]: 'gm',
    token: 'tok',
    call: 'gm.xhr',
    details: { url: 'https://example.com/', method: 'POST', headers: { a: 'b' }, data: 'x', evil: 1, credentials: 'include' },
  })!;
  assert.deepEqual(Object.keys(req.details!).sort(), ['data', 'headers', 'method', 'responseType', 'timeout', 'url']);
  assert.equal((req.details as Record<string, unknown>).evil, undefined);
  assert.equal((req.details as Record<string, unknown>).credentials, undefined);
});

test('details with no url are dropped whole', () => {
  const req = parseGm({ [EXEC_TAG]: 'gm', token: 'tok', call: 'gm.xhr', details: { method: 'GET' } })!;
  assert.equal(req.details, undefined);
  assert.equal(parseGm({ [EXEC_TAG]: 'gm', token: 'tok', call: 'gm.xhr', details: 'https://example.com' })!.details, undefined);
});

test('a claim needs a document key and a url, and the key is length-bounded', () => {
  assert.ok(parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd1', url: 'https://example.com/' }));
  assert.equal(parseClaim({ [EXEC_TAG]: 'claim', url: 'https://example.com/' }), null);
  assert.equal(parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd1' }), null);
  // The key is generated page-side and only ever used as a Map key, but an unbounded one is an
  // unbounded allocation in the background's own memory.
  assert.equal(parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd'.repeat(101), url: 'https://e.com/' }), null);
  assert.ok(parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd'.repeat(100), url: 'https://e.com/' }));
});

test('a claim defaults to the cautious reading of its own optional fields', () => {
  const c = parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd1', url: 'https://e.com/' })!;
  // topFrame must be asserted, not assumed: it is what a mod's allFrames:false is honoured by.
  assert.equal(c.topFrame, false);
  assert.equal(c.readyState, 'loading');
  assert.equal(parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd', url: 'https://e.com/', topFrame: 'yes' })!.topFrame, false);
  assert.equal(parseClaim({ [EXEC_TAG]: 'claim', docKey: 'd', url: 'https://e.com/', topFrame: true })!.topFrame, true);
});

test('a blocked report is trimmed and its world is one of two values', () => {
  const r = parseBlocked({ [EXEC_TAG]: 'blocked', modId: 'mod-a', reason: 'x'.repeat(900), world: 'MAIN' })!;
  assert.equal(r.reason.length, 500);
  assert.equal(r.world, 'MAIN');
  // Anything but the literal 'MAIN' reads as the isolated world, which is the safer default: it is
  // the world that does not need the page's permission.
  assert.equal(parseBlocked({ [EXEC_TAG]: 'blocked', modId: 'm', reason: 'r', world: 'PAGE' })!.world, 'USER_SCRIPT');
  assert.equal(parseBlocked({ [EXEC_TAG]: 'blocked', modId: 'm', reason: '' }), null);
  assert.equal(parseBlocked({ [EXEC_TAG]: 'blocked', reason: 'r' }), null);
});
