// The YAML a .skill.md file is written in: a small subset, read by hand so a stranger's file meets no
// general YAML parser and the extension gains no dependency. Pure, tested under node (test/skills.test.ts).
//
// The grammar, all of it:
//
//   document   a block map, or a block list of maps
//   block map  `key: value` lines at one indent; a value is inline, or a deeper block on the next lines
//   block list `- value` lines at one indent; a list under a key may sit at the key's own indent
//   inline     a scalar, a flow map `{ a: 1, b: x }` or a flow list `[a, b]`, on one line
//   scalar     plain, 'single quoted' ('' for a quote) or "double quoted" (JSON's escapes, \xXX, \uXXXX)
//   comment    `#` at the start of a line or after a space, outside quotes
//
// A plain scalar reads as an integer when it is all digits with no leading zero, as true or false, as
// null when it is `null`, `~` or missing, and as a string otherwise. So `version: 1.0` is the string
// "1.0" here where full YAML says a float; writeYaml quotes anything that could read differently, so
// what it writes means the same to any YAML parser.
//
// Refused, with the line named: anchors, aliases, tags, merge keys, `|` and `>` blocks, `?` keys, a
// value running on over several lines, flow collections over several lines, tabs in indentation, a
// repeated key, and keys that would reach an object's prototype.

export type YamlValue = string | number | boolean | null | YamlValue[] | YamlMap;
export interface YamlMap {
  [key: string]: YamlValue;
}

export class YamlError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(message);
    this.line = line;
  }
}

export interface YamlDoc {
  value: YamlValue;
  /** The line each map key and list item is on, by path: `match/0`, `3/fill`. 1-based, in the file. */
  lines: Record<string, number>;
}

interface Line {
  /** 1-based, in the file. */
  no: number;
  indent: number;
  text: string;
}

const REFUSED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function toLines(text: string, firstLine: number): Line[] {
  const out: Line[] = [];
  text.split('\n').forEach((raw, i) => {
    const no = firstLine + i;
    const lead = /^[ \t]*/.exec(raw)![0];
    const rest = raw.slice(lead.length).replace(/\s+$/, '');
    if (!rest || rest.startsWith('#')) return;
    if (lead.includes('\t')) throw new YamlError(no, 'indented with a tab; YAML wants spaces');
    out.push({ no, indent: lead.length, text: rest });
  });
  return out;
}

/** Read a quoted scalar at `from`. Returns its value and where it ended. */
function readQuoted(s: string, from: number, no: number): { value: string; end: number } {
  const q = s[from]!;
  let out = '';
  let i = from + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (q === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
          continue;
        }
        return { value: out, end: i + 1 };
      }
      out += c;
      i++;
      continue;
    }
    if (c === '"') return { value: out, end: i + 1 };
    if (c !== '\\') {
      out += c;
      i++;
      continue;
    }
    const e = s[i + 1];
    const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '0': '\0', a: '\x07', e: '\x1b', v: '\v', ' ': ' ' };
    if (e && e in simple) {
      out += simple[e]!;
      i += 2;
      continue;
    }
    const width = e === 'x' ? 2 : e === 'u' ? 4 : 0;
    const hex = s.slice(i + 2, i + 2 + width);
    if (width && hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) {
      out += String.fromCharCode(parseInt(hex, 16));
      i += 2 + width;
      continue;
    }
    throw new YamlError(no, `a double-quoted string has an escape YAML does not know: \\${e ?? ''}`);
  }
  throw new YamlError(no, 'a quoted string is not closed on its line');
}

/** Nothing may follow a value but a comment. */
function expectEnd(s: string, from: number, no: number): void {
  const rest = s.slice(from);
  if (rest.trim() && !/^\s+#/.test(rest)) throw new YamlError(no, `unexpected text after the value: ${rest.trim().slice(0, 40)}`);
}

/** A plain scalar's text as a value. */
function plainValue(t: string, no: number): YamlValue {
  const c = t[0]!;
  if (c === '&' || c === '*') throw new YamlError(no, `anchors and aliases are not in this format; quote it if it is text: ${t.slice(0, 40)}`);
  if (c === '!') throw new YamlError(no, `tags are not in this format; quote it if it is text: ${t.slice(0, 40)}`);
  if (c === '|' || c === '>') throw new YamlError(no, 'block scalars are not in this format; keep the value on one line');
  if (c === '%' || c === '@' || c === '`') throw new YamlError(no, `a plain value cannot start with ${c}; quote it`);
  if ((c === '?' || c === '-' || c === ':') && (t.length === 1 || t[1] === ' ')) throw new YamlError(no, `a plain value cannot start with "${c} "; quote it`);
  if (t === 'null' || t === 'Null' || t === 'NULL' || t === '~') return null;
  if (t === 'true' || t === 'True' || t === 'TRUE') return true;
  if (t === 'false' || t === 'False' || t === 'FALSE') return false;
  if (/^-?(0|[1-9]\d*)$/.test(t) && Number.isSafeInteger(Number(t))) return Number(t);
  return t;
}

/** A plain scalar inside a flow collection ends at a comma, a closing bracket, or `: `. */
function readFlowPlain(s: string, from: number, no: number, asKey: boolean): { text: string; end: number } {
  let i = from;
  while (i < s.length) {
    const c = s[i]!;
    if (c === ',' || c === '}' || c === ']' || c === '{' || c === '[') break;
    if (c === ':' && (s[i + 1] === ' ' || s[i + 1] === undefined || (asKey && (s[i + 1] === ',' || s[i + 1] === '}')))) break;
    if (c === '#' && s[i - 1] === ' ') throw new YamlError(no, 'a comment inside a flow map; flow maps stay on one line');
    i++;
  }
  return { text: s.slice(from, i).trim(), end: i };
}

const skipSpaces = (s: string, i: number) => {
  while (s[i] === ' ') i++;
  return i;
};

function checkKey(key: string, no: number, into: object): void {
  if (REFUSED_KEYS.has(key)) throw new YamlError(no, `the key ${key} is not allowed`);
  if (key === '<<') throw new YamlError(no, 'merge keys are not in this format');
  if (Object.prototype.hasOwnProperty.call(into, key)) throw new YamlError(no, `the key ${key} appears twice`);
}

/** A flow collection or flow scalar starting at `from`. */
function readFlow(s: string, from: number, no: number): { value: YamlValue; end: number } {
  const c = s[from];
  if (c === '{') {
    const out: YamlMap = {};
    let i = skipSpaces(s, from + 1);
    while (i < s.length) {
      if (s[i] === '}') return { value: out, end: i + 1 };
      let key: string;
      if (s[i] === '"' || s[i] === "'") {
        const q = readQuoted(s, i, no);
        key = q.value;
        i = skipSpaces(s, q.end);
      } else {
        const p = readFlowPlain(s, i, no, true);
        key = p.text;
        i = p.end;
      }
      if (s[i] !== ':') throw new YamlError(no, `in a flow map, ${key || 'a key'} needs ": value"`);
      if (!key) throw new YamlError(no, 'a flow map has an empty key');
      checkKey(key, no, out);
      i = skipSpaces(s, i + 1);
      if (s[i] === ',' || s[i] === '}') out[key] = null;
      else {
        const v = readFlow(s, i, no);
        out[key] = v.value;
        i = skipSpaces(s, v.end);
      }
      if (s[i] === ',') i = skipSpaces(s, i + 1);
      else if (s[i] !== '}') throw new YamlError(no, 'a flow map must close on its own line');
    }
    throw new YamlError(no, 'a flow map must close on its own line');
  }
  if (c === '[') {
    const out: YamlValue[] = [];
    let i = skipSpaces(s, from + 1);
    while (i < s.length) {
      if (s[i] === ']') return { value: out, end: i + 1 };
      const v = readFlow(s, i, no);
      out.push(v.value);
      i = skipSpaces(s, v.end);
      if (s[i] === ',') i = skipSpaces(s, i + 1);
      else if (s[i] !== ']') throw new YamlError(no, 'a flow list must close on its own line');
    }
    throw new YamlError(no, 'a flow list must close on its own line');
  }
  if (c === '"' || c === "'") {
    const q = readQuoted(s, from, no);
    return { value: q.value, end: q.end };
  }
  const p = readFlowPlain(s, from, no, false);
  if (!p.text) throw new YamlError(no, 'a flow collection has an empty value');
  return { value: plainValue(p.text, no), end: p.end };
}

/** A value that is all on this line. */
function readInline(s: string, no: number): YamlValue {
  const c = s[0];
  if (c === '{' || c === '[' || c === '"' || c === "'") {
    const r = readFlow(s, 0, no);
    expectEnd(s, r.end, no);
    return r.value;
  }
  const hash = s.search(/\s#/);
  const text = hash >= 0 ? s.slice(0, hash).trim() : s;
  return plainValue(text, no);
}

/** Split `key: rest` off a line. Null when the line holds no key. */
function splitKey(s: string, no: number): { key: string; rest: string } | null {
  if (s[0] === '{' || s[0] === '[') return null;
  if (s[0] === '"' || s[0] === "'") {
    const q = readQuoted(s, 0, no);
    const after = s.slice(q.end).trimStart();
    if (after[0] !== ':' || (after[1] !== undefined && after[1] !== ' ')) return null;
    return { key: q.value, rest: after.slice(1).trim() };
  }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '#' && (i === 0 || s[i - 1] === ' ')) return null;
    if (c === ':' && (s[i + 1] === ' ' || s[i + 1] === undefined)) return { key: s.slice(0, i).trimEnd(), rest: s.slice(i + 1).trim() };
  }
  return null;
}

const isComment = (s: string) => s.startsWith('#');
const isItem = (s: string) => s === '-' || s.startsWith('- ');

class Reader {
  i = 0;
  lines: Line[];
  paths: Record<string, number>;
  constructor(lines: Line[], paths: Record<string, number>) {
    this.lines = lines;
    this.paths = paths;
  }

  /** A block of lines at exactly `indent`. */
  block(indent: number, path: string): YamlValue {
    const first = this.lines[this.i]!;
    if (isItem(first.text)) return this.list(indent, path);
    if (splitKey(first.text, first.no)) return this.map(indent, path);
    throw new YamlError(first.no, `expected "key: value" or "- item": ${first.text.slice(0, 40)}`);
  }

  /** A value on the lines after `key:` or a bare `-`, deeper than `parent`. */
  private nested(parent: number, path: string, allowSameIndentList: boolean): YamlValue {
    const next = this.lines[this.i];
    if (!next) return null;
    if (next.indent > parent) return this.block(next.indent, path);
    if (allowSameIndentList && next.indent === parent && isItem(next.text)) return this.list(parent, path);
    return null;
  }

  private map(indent: number, path: string): YamlMap {
    const out: YamlMap = {};
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(line.no, 'indented deeper than the lines around it');
      if (isItem(line.text)) break;
      const kv = splitKey(line.text, line.no);
      if (!kv) throw new YamlError(line.no, `expected "key: value": ${line.text.slice(0, 40)}`);
      if (!kv.key) throw new YamlError(line.no, 'a map has an empty key');
      checkKey(kv.key, line.no, out);
      if (kv.key[0] === '?' && kv.key[1] === ' ') throw new YamlError(line.no, 'complex keys are not in this format');
      const here = path ? `${path}/${kv.key}` : kv.key;
      this.paths[here] = line.no;
      this.i++;
      if (kv.rest && !isComment(kv.rest)) {
        out[kv.key] = readInline(kv.rest, line.no);
        const after = this.lines[this.i];
        if (after && after.indent > indent) throw new YamlError(after.no, `a value running on over several lines is not in this format (the value of ${kv.key} is on line ${line.no})`);
      } else {
        out[kv.key] = this.nested(indent, here, true);
      }
    }
    return out;
  }

  private list(indent: number, path: string): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.indent < indent) break;
      if (line.indent > indent) throw new YamlError(line.no, 'indented deeper than the lines around it');
      if (!isItem(line.text)) break;
      const here = path ? `${path}/${out.length}` : String(out.length);
      this.paths[here] = line.no;
      const rest = line.text.slice(1).trimStart();
      if (!rest || isComment(rest)) {
        this.i++;
        out.push(this.nested(indent, here, false));
        continue;
      }
      if (isItem(rest) || splitKey(rest, line.no)) {
        // The item's first line reads as if it started at the column of what follows the dash.
        const offset = line.text.length - rest.length;
        this.lines[this.i] = { no: line.no, indent: indent + offset, text: rest };
        out.push(this.block(indent + offset, here));
        continue;
      }
      this.i++;
      out.push(readInline(rest, line.no));
      const after = this.lines[this.i];
      if (after && after.indent > indent) throw new YamlError(after.no, `a value running on over several lines is not in this format (the item is on line ${line.no})`);
    }
    return out;
  }
}

/** Parse a document. Throws YamlError. `firstLine` is the file's line number of the text's first line. */
export function parseYaml(text: string, firstLine = 1): YamlDoc {
  const lines = toLines(text, firstLine);
  const paths: Record<string, number> = {};
  if (!lines.length) return { value: null, lines: paths };
  const reader = new Reader(lines, paths);
  const value = reader.block(lines[0]!.indent, '');
  if (reader.i < lines.length) throw new YamlError(lines[reader.i]!.no, `unexpected line: ${lines[reader.i]!.text.slice(0, 40)}`);
  return { value, lines: paths };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Anything another YAML reader, 1.1 or 1.2, could take for something other than a string. */
const READS_AS_OTHER = /^(?:~|null|true|false|yes|no|on|off|y|n|[-+]?(?:\d[\d_]*)?(?:\.\d*)?(?:[eE][-+]?\d+)?|[-+]?\.(?:inf|nan)|0x[0-9a-f]+|0o[0-7]+|\d{4}-\d{1,2}-\d{1,2}(?:[tT ].*)?)$/i;

/** Characters that have no business raw in a file, and are written as escapes. */
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff\ud800-\udfff]/;

function blockPlainOk(s: string): boolean {
  if (!s || s !== s.trim() || READS_AS_OTHER.test(s) || UNPRINTABLE.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  return !/:( |$)| #/.test(s);
}

/** Stricter inside braces, where commas and brackets mean something. */
function flowPlainOk(s: string): boolean {
  return blockPlainOk(s) && /^[\p{L}\p{N} _.$/-]+$/u.test(s) && !/^[-/.]/.test(s);
}

function quoted(s: string): string {
  if (s.includes('"') && !s.includes("'") && !UNPRINTABLE.test(s)) return `'${s}'`;
  return JSON.stringify(s).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** A scalar as written. Numbers, booleans and null are their own text. */
export function writeScalar(v: string | number | boolean | null, flow = false): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  return (flow ? flowPlainOk(v) : blockPlainOk(v)) ? v : quoted(v);
}

const writeKey = (k: string, flow: boolean) => {
  if (flow ? flowPlainOk(k) : blockPlainOk(k)) return k;
  return quoted(k);
};

/** A value on one line. */
export function writeFlow(v: YamlValue): string {
  if (Array.isArray(v)) return v.length ? `[${v.map(writeFlow).join(', ')}]` : '[]';
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    return keys.length ? `{ ${keys.map((k) => `${writeKey(k, true)}: ${writeFlow(v[k]!)}`).join(', ')} }` : '{}';
  }
  return writeScalar(v, true);
}

/**
 * A block map's lines. A nested map or list opens as a block unless `flowUnder` names its key: those
 * are the shapes the format writes on one line, such as `at` and `until`.
 */
export function writeMapLines(map: YamlMap, indent = '', flowUnder: (key: string, value: YamlValue) => boolean = () => false): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(map)) {
    const key = writeKey(k, false);
    if (v !== null && typeof v === 'object' && !flowUnder(k, v)) {
      const empty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
      if (empty) {
        out.push(`${indent}${key}: ${Array.isArray(v) ? '[]' : '{}'}`);
        continue;
      }
      out.push(`${indent}${key}:`);
      if (Array.isArray(v)) {
        for (const item of v) out.push(`${indent}  - ${writeFlowOrScalar(item)}`);
      } else {
        out.push(...writeMapLines(v, `${indent}  `, () => true));
      }
      continue;
    }
    out.push(`${indent}${key}: ${typeof v === 'object' && v !== null ? writeFlow(v) : writeScalar(v)}`);
  }
  return out;
}

const writeFlowOrScalar = (v: YamlValue) => (v !== null && typeof v === 'object' ? writeFlow(v) : writeScalar(v));
