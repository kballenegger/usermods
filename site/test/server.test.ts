import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import type { IncomingHttpHeaders, OutgoingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { submitPending } from "../src/indexnow.ts";
import { CWS_URL, indexableUrls, startServer } from "../src/server.ts";
import type { Running } from "../src/server.ts";

const FIXTURE = join(import.meta.dirname, "server-fixture");
const ORIGIN = "https://usermods.kennethballenegger.com";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const BROWSER = { "user-agent": CHROME, "sec-ch-ua": '"Chromium";v="142", "Google Chrome";v="142"',
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
const UMAMI = '<script defer src="https://analytics.example.test/script.js" data-website-id="site-123"></script>';

let srv: Running;
let dataDir: string;

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), "usermods-site-test-"));
  srv = await startServer({
    dist: FIXTURE,
    dataDir,
    port: 0,
    env: { ANALYTICS_WEBSITE_ID: "site-123", ANALYTICS_HOST: "analytics.example.test",
      GOOGLE_SITE_VERIFICATION: "g-token", BING_SITE_VERIFICATION: "b-token", INDEXNOW_KEY: "abcdef0123456789" },
  });
});

after(async () => {
  await srv.close();
  rmSync(dataDir, { recursive: true, force: true });
});

interface Res { status: number; headers: IncomingHttpHeaders; body: Buffer; text: string }

function get(path: string, headers: OutgoingHttpHeaders = {}, method = "GET"): Promise<Res> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port: srv.port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        ok({ status: res.statusCode ?? 0, headers: res.headers, body, text: body.toString("utf8") });
      });
    });
    req.on("error", fail);
    req.end();
  });
}

type LogRow = Record<string, string | number>;

// The log row is written on the response's "finish", which can land just after the client
// has read the body, so wait for it.
async function lastRow(path: string): Promise<LogRow> {
  for (let i = 0; i < 50; i++) {
    const row = srv.db.prepare("SELECT * FROM page_requests WHERE path = ? ORDER BY id DESC LIMIT 1").get(path);
    if (row) return row as LogRow;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`no log row for ${path}`);
}

function rowCount(path: string): number {
  return Number((srv.db.prepare("SELECT COUNT(*) AS n FROM page_requests WHERE path = ?").get(path) as LogRow).n);
}

test("HTML by default, markdown twin by Accept or .md, with canonical Link and Vary", async () => {
  const html = await get("/youtube/hide-shorts", BROWSER);
  assert.equal(html.status, 200);
  assert.equal(html.headers["content-type"], "text/html; charset=utf-8");
  assert.match(html.text, /<h1>Hide YouTube Shorts<\/h1>/);
  assert.equal(html.headers.vary, "Accept, Accept-Encoding");
  assert.equal(html.headers["cache-control"], "public, max-age=300");
  assert.equal(html.headers["last-modified"], "Tue, 17 Nov 2026 09:12:00 GMT");
  assert.equal(html.headers["x-robots-tag"], undefined);

  for (const [path, accept] of [["/youtube/hide-shorts", "text/markdown, text/html;q=0.5"], ["/youtube/hide-shorts.md", "*/*"]] as const) {
    const md = await get(path, { accept });
    assert.equal(md.status, 200, path);
    assert.equal(md.headers["content-type"], "text/markdown; charset=utf-8");
    assert.match(md.text, /^Checked: 17 November 2026/);
    assert.equal(md.headers.link, `<${ORIGIN}/youtube/hide-shorts>; rel="canonical"`);
    assert.equal(md.headers.vary, "Accept, Accept-Encoding");
  }
  const homeMd = await get("/index.md");
  assert.equal(homeMd.status, 200);
  assert.equal(homeMd.headers.link, `<${ORIGIN}/>; rel="canonical"`);
  assert.equal((await lastRow("/index.md")).fmt, "md");
});

test("conditional requests answer 304", async () => {
  const first = await get("/youtube/hide-shorts");
  const etag = String(first.headers.etag);
  assert.match(etag, /^"[A-Za-z0-9_-]+"$/);
  assert.equal((await get("/youtube/hide-shorts", { "if-none-match": etag })).status, 304);
  assert.equal((await get("/youtube/hide-shorts", { "if-none-match": '"other"' })).status, 200);
  assert.equal((await get("/youtube/hide-shorts", { "if-modified-since": "Tue, 17 Nov 2026 09:12:00 GMT" })).status, 304);
  assert.equal((await get("/youtube/hide-shorts", { "if-modified-since": "Tue, 17 Nov 2026 09:11:59 GMT" })).status, 200);
  const br = await get("/youtube/hide-shorts", { "accept-encoding": "br" });
  assert.equal((await get("/youtube/hide-shorts", { "if-none-match": String(br.headers.etag) })).status, 304);
  const js = await get("/youtube/hide-shorts.user.js");
  assert.equal((await get("/youtube/hide-shorts.user.js", { "if-none-match": String(js.headers.etag) })).status, 304);
});

test("gzip and br when accepted", async () => {
  const plain = await get("/youtube/hide-shorts");
  const br = await get("/youtube/hide-shorts", { "accept-encoding": "gzip, deflate, br" });
  assert.equal(br.headers["content-encoding"], "br");
  assert.equal(brotliDecompressSync(br.body).toString(), plain.text);
  const gz = await get("/youtube/hide-shorts", { "accept-encoding": "gzip" });
  assert.equal(gz.headers["content-encoding"], "gzip");
  assert.equal(gunzipSync(gz.body).toString(), plain.text);
  assert.notEqual(gz.headers.etag, plain.headers.etag);
});

test("canonical redirects keep the query; query strings alone never redirect", async () => {
  const cases: [string, string][] = [
    ["/youtube/hide-shorts/", "/youtube/hide-shorts"],
    ["/youtube/hide-shorts/index.html", "/youtube/hide-shorts"],
    ["/index.html", "/"],
    ["/youtube/", "/youtube"],
    ["/youtube/remove-shorts", "/youtube/hide-shorts"],
    ["/youtube/remove-shorts/?utm_source=chatgpt.com", "/youtube/remove-shorts?utm_source=chatgpt.com"],
    ["/youtube/remove-shorts.md", "/youtube/hide-shorts.md"],
    ["/a/..//evil.com/", "/evil.com"],
    ["/.//evil.com/index.html", "/evil.com"],
  ];
  for (const [from, to] of cases) {
    const res = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.location, to, from);
  }
});

test("a ChatGPT referral with ?utm_source=chatgpt.com is served and logged", async () => {
  const res = await get("/youtube/hide-shorts?utm_source=chatgpt.com", { ...BROWSER, referer: "https://chatgpt.com/",
    "accept-language": "de-DE,de;q=0.9", "cf-ipcountry": "de" });
  assert.equal(res.status, 200);
  const row = await lastRow("/youtube/hide-shorts");
  assert.equal(row.utm_source, "chatgpt.com");
  assert.equal(row.path, "/youtube/hide-shorts");
  assert.equal(row.kind, "task");
  assert.equal(row.fmt, "html");
  assert.equal(row.status, 200);
  assert.equal(row.referer_host, "chatgpt.com");
  assert.equal(row.lang, "de-DE");
  assert.equal(row.country, "DE");
  assert.equal(row.agent_class, "browser");
  assert.equal(row.client_hints, "Chromium;Google Chrome");
  assert.match(String(row.ts), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.equal(row.day, String(row.ts).slice(0, 10));
});

test("ChatGPT-User fetch of a twin is logged as ai", async () => {
  await get("/youtube.md", { "user-agent": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot" });
  const row = await lastRow("/youtube.md");
  assert.equal(row.agent_family, "chatgpt-user");
  assert.equal(row.agent_class, "ai");
  assert.equal(row.kind, "hub");
});

test("/install logs the click and 302s to the store with utm parameters", async () => {
  const res = await get("/install?from=/youtube/hide-shorts", BROWSER);
  assert.equal(res.status, 302);
  const loc = new URL(String(res.headers.location));
  assert.equal(loc.origin + loc.pathname, CWS_URL);
  assert.equal(loc.searchParams.get("utm_source"), "usermods.kennethballenegger.com");
  assert.equal(loc.searchParams.get("utm_medium"), "site");
  assert.equal(loc.searchParams.get("utm_campaign"), "/youtube/hide-shorts");
  const row = await lastRow("/install");
  assert.equal(row.fmt, "install");
  assert.equal(row.utm_campaign, "/youtube/hide-shorts");
  assert.equal(row.status, 302);
  assert.equal(row.agent_class, "browser");
});

test("analytics tag on every HTML page, verification metas on home only", async () => {
  const home = await get("/");
  assert.ok(home.text.includes(UMAMI + '<meta name="google-site-verification" content="g-token"><meta name="msvalidate.01" content="b-token"></head>'));
  for (const path of ["/youtube/hide-shorts", "/youtube", "/no-such-page"]) {
    const res = await get(path, { "user-agent": "klaw-deploy/1" });
    assert.ok(res.text.includes(UMAMI + "</head>"), path);
    assert.ok(!res.text.includes("google-site-verification"), path);
    assert.equal(res.text.split("</head>").length, 2, path);
  }
  assert.equal((await lastRow("/youtube")).agent_class, "smoke");
});

test("non-indexable page carries X-Robots-Tag on HTML and markdown", async () => {
  assert.equal((await get("/youtube")).headers["x-robots-tag"], "noindex, follow");
  assert.equal((await get("/youtube.md")).headers["x-robots-tag"], "noindex, follow");
  assert.equal((await get("/youtube/hide-shorts.md")).headers["x-robots-tag"], undefined);
});

test("healthz reports the manifest and is not logged", async () => {
  const res = await get("/healthz.json");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.text), { ok: true, commit: "fixture", builtAt: "2026-11-17T10:00:00Z", pages: 1, sites: 1 });
  await get("/");
  await lastRow("/");
  assert.equal(rowCount("/healthz.json"), 0);
});

test("robots, scripts and assets are served from the manifest; assets are not logged", async () => {
  const robots = await get("/robots.txt", { "user-agent": "Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)" });
  assert.equal(robots.status, 200);
  assert.equal(robots.headers["content-type"], "text/plain; charset=utf-8");
  assert.match(robots.text, /User-agent: GPTBot\nAllow: \/\nDisallow: \/install/);
  const row = await lastRow("/robots.txt");
  assert.equal(row.fmt, "txt");
  assert.equal(row.agent_family, "gptbot");

  const js = await get("/youtube/hide-shorts.user.js");
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  assert.match(js.text, /==UserScript==/);
  assert.equal((await lastRow("/youtube/hide-shorts.user.js")).fmt, "js");
  assert.equal((await lastRow("/llms.txt").catch(() => null)), null);
  await get("/llms.txt");
  assert.equal((await lastRow("/llms.txt")).fmt, "llms");

  assert.equal((await get("/assets/site.css")).status, 200);
  await get("/");
  await lastRow("/");
  assert.equal(rowCount("/assets/site.css"), 0);
});

test("binary assets answer byte ranges; compressible files ignore them", async () => {
  const full = await get("/assets/clip.mp4");
  assert.equal(full.status, 200);
  assert.equal(full.headers["content-type"], "video/mp4");
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.text, "0123456789abcdefghijklmnopqrstuvwxyz");

  const first = await get("/assets/clip.mp4", { range: "bytes=0-1" });
  assert.equal(first.status, 206);
  assert.equal(first.headers["content-range"], "bytes 0-1/36");
  assert.equal(first.headers["content-length"], "2");
  assert.equal(first.text, "01");

  const open = await get("/assets/clip.mp4", { range: "bytes=30-" });
  assert.equal(open.status, 206);
  assert.equal(open.text, "uvwxyz");
  assert.equal((await get("/assets/clip.mp4", { range: "bytes=-3" })).text, "xyz");
  assert.equal((await get("/assets/clip.mp4", { range: "bytes=10-999" })).headers["content-range"], "bytes 10-35/36");

  const past = await get("/assets/clip.mp4", { range: "bytes=36-" });
  assert.equal(past.status, 416);
  assert.equal(past.headers["content-range"], "bytes */36");

  // A stale If-Range or a multi-range request gets the whole file.
  assert.equal((await get("/assets/clip.mp4", { range: "bytes=0-1", "if-range": '"old"' })).status, 200);
  assert.equal((await get("/assets/clip.mp4", { range: "bytes=0-1,4-5" })).status, 200);
  const css = await get("/assets/site.css", { range: "bytes=0-1" });
  assert.equal(css.status, 200);
  assert.equal(css.headers["accept-ranges"], undefined);
});

test("unknown paths 404 with the HTML or markdown not-found page; HEAD has no body; POST is refused", async () => {
  const html = await get("/nope");
  assert.equal(html.status, 404);
  assert.match(html.text, /Not found/);
  const md = await get("/nope.md");
  assert.equal(md.status, 404);
  assert.equal(md.headers["content-type"], "text/markdown; charset=utf-8");
  const head = await get("/youtube/hide-shorts", {}, "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal((await get("/", {}, "POST")).status, 405);
});

test("IndexNow key file is served and pending URLs are submitted once", async () => {
  const key = await get("/abcdef0123456789.txt");
  assert.equal(key.status, 200);
  assert.equal(key.text, "abcdef0123456789");

  const pages = indexableUrls(srv.site);
  assert.deepEqual(pages.map((p) => p.url), [`${ORIGIN}/`, `${ORIGIN}/youtube/hide-shorts`]);
  const bodies: string[] = [];
  const post = async (_url: string, body: string) => { bodies.push(body); return 200; };
  assert.equal(await submitPending(srv.db, ORIGIN, "abcdef0123456789", pages, post), 2);
  assert.deepEqual(JSON.parse(bodies[0] ?? ""), { host: "usermods.kennethballenegger.com", key: "abcdef0123456789",
    keyLocation: `${ORIGIN}/abcdef0123456789.txt`, urlList: [`${ORIGIN}/`, `${ORIGIN}/youtube/hide-shorts`] });
  assert.equal(await submitPending(srv.db, ORIGIN, "abcdef0123456789", pages, post), 0);
  const newer = pages.map((p, i) => (i === 1 ? { ...p, lastmod: "2026-11-18T00:00:00Z" } : p));
  assert.equal(await submitPending(srv.db, ORIGIN, "abcdef0123456789", newer, async () => 500), 0);
  assert.equal(await submitPending(srv.db, ORIGIN, "abcdef0123456789", newer, post), 1);
  assert.deepEqual(JSON.parse(bodies[1] ?? "").urlList, [`${ORIGIN}/youtube/hide-shorts`]);
});
