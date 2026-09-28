// The pre-share leak check (lib/leakscan.ts): what it catches, what it must not flag, and that its
// own warning never prints the secret whole. Pure: no network, no DOM.
//   npm test
import assert from 'node:assert/strict';
import test from 'node:test';
import { describeLeak, mask, scanForLeaks } from '../lib/leakscan.ts';

// Fake credentials, built at runtime so no scanner mistakes this file for a real leak.
const k = (...parts: string[]) => parts.join('');
const OPENAI = k('sk-', 'proj-', 'Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4z');
const ANTHROPIC = k('sk-', 'ant-', 'api03-', 'Zy9xWv8uTs7rQp6oNm5lKj4iHg3fEd2c');
const XAI = k('xai-', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6');
const AWS = k('AKIA', 'IOSFODNN7EXAMPLE');
const GHP = k('ghp_', '1234567890abcdefghijABCDEFGHIJ123456');
const PAT = k('github_pat_', '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz');
const JWT = k('eyJhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', '.', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U');

const kinds = (src: string) => scanForLeaks(src).map((l) => l.kind);

test('catches the key formats worth stopping a share for', () => {
  const src = [
    `const openai = '${OPENAI}';`,
    `const anthropic = "${ANTHROPIC}";`,
    `fetch(url, { headers: { 'x-api-key': '${XAI}' } });`,
    `const aws = '${AWS}';`,
    `const gh = '${GHP}';`,
    `const pat = '${PAT}';`,
    `const session = '${JWT}';`,
    `xhr.setRequestHeader('Authorization', 'Bearer abcdefghijklmnop1234567890');`,
    `const config = { apiKey: "q8Zr2vLm0pXs7TnW" };`,
    `const password = 'hunter2hunter2!';`,
  ].join('\n');
  assert.deepEqual(kinds(src), ['openai-key', 'anthropic-key', 'xai-key', 'aws-key', 'github-token', 'github-token', 'jwt', 'bearer', 'api-key', 'api-key']);
  // Each on its own line, reported with the line it is on.
  assert.deepEqual(
    scanForLeaks(src).map((l) => l.line),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
});

test('an Anthropic key is reported once, as Anthropic, not also as an OpenAI key', () => {
  assert.deepEqual(kinds(`x = '${ANTHROPIC}'`), ['anthropic-key']);
});

test('private addresses and hosts: tailnet, LAN, .local, .internal, localhost ports', () => {
  const src = [
    '// ==UserScript==',
    '// @name   Home',
    '// @connect  nas.local',
    '// @match  http://192.168.1.20/*',
    '// ==/UserScript==',
    "fetch('http://100.101.102.103:8080/api');",
    "fetch('https://grafana.internal/d/1');",
    "fetch('https://box.tail1234.ts.net/');",
    "fetch('http://10.0.0.5/');",
    "fetch('http://localhost:11434/api/tags');",
    "const u = 'http://172.20.3.4';",
  ].join('\n');
  const found = scanForLeaks(src);
  assert.deepEqual(
    found.map((l) => `${l.line}:${l.kind}`),
    ['3:private-host', '4:private-ip', '6:private-ip', '7:private-host', '8:private-host', '9:private-ip', '10:localhost', '11:private-ip'],
  );
  // Hosts are shown whole: they are the thing to find in the script, not a secret to hide.
  assert.equal(found.find((l) => l.kind === 'private-host')?.preview, 'nas.local');
});

test('ordinary code is not a leak', () => {
  const src = [
    '// ==UserScript==',
    '// @name         Wide Wiki',
    '// @version      10.2.3',
    '// @match        *://*.wikipedia.org/*',
    '// ==/UserScript==',
    "const key = 'Escape';",
    "headers.Authorization = `Bearer ${token}`;",
    "xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);",
    'const apiKey = localStorage.getItem("apiKey");',
    "const cfg = { apiKey: 'YOUR_API_KEY_HERE' };",
    "const password = 'xxxxxxxxxxxxxxxx';",
    'if (this.internal) window.localStorage.setItem("a", "b");',
    'document.location.href = "https://example.com/local/page";',
    "const skip = 'sk-short';",
    "const ip = '8.8.8.8'; const other = '100.200.1.1'; const cgnat_edge = '100.128.0.1';",
    'const version = "1.10.0.1";',
    "const url = 'http://example.com:8080/';",
  ].join('\n');
  assert.deepEqual(scanForLeaks(src), []);
});

test('the warning masks a secret rather than repeating it', () => {
  const [leak] = scanForLeaks(`const k = '${OPENAI}';`);
  assert.ok(leak);
  assert.ok(!leak.preview.includes(OPENAI.slice(8, 24)), 'the middle of the key is not shown');
  assert.equal(describeLeak(leak), `Line 1: an OpenAI-style API key (sk-…) · ${mask(OPENAI)}`);
  assert.equal(mask('abcdefgh'), 'ab…');
  assert.equal(mask('abcdefghijklmnopqrstuvwxyz'), 'abcdef…wxyz');
});

test('one finding per kind per line, and nothing but text is read', () => {
  const src = `const a = '${AWS}', b = '${AWS.replace('EXAMPLE', 'EXAMPL2')}';`;
  assert.equal(scanForLeaks(src).length, 1);
  assert.deepEqual(scanForLeaks(''), []);
});
