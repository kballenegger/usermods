// usermods site server. Loads the generator's dist through manifest.json into memory at
// startup and serves it: content negotiation to markdown twins, conditional requests,
// compression, redirects, the /install click counter, IndexNow and the request log.
// Start: node site/src/server.ts   (env: PORT, SITE_DIST, DATA_DIR, SITE_ENV, ANALYTICS_*,
// GOOGLE_SITE_VERIFICATION, BING_SITE_VERIFICATION, INDEXNOW_KEY)

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, constants as zlib, gzipSync } from "node:zlib";
import { KEY_RE, submitPending } from "./indexnow.ts";
import { openDb, recordRequest } from "./traffic.ts";

export const CWS_URL = "https://chromewebstore.google.com/detail/usermods/dhmdjekbeinhhnfhcgnkgdpgdafpboic";

export type PageKind = "task" | "hub" | "home" | "guide";

export interface Manifest {
  builtAt: string;
  commit: string;
  origin: string;
  counts: { pages: number; sites: number };
  pages: Record<string, { kind: PageKind; title: string; lastmod: string; indexable: boolean; html: string; md: string }>;
  files: Record<string, { file: string; type: string; lastmod: string; format: "js" | "llms" | "xml" | "txt" | "json" | "asset" }>;
  notFound: { html: string; md: string };
  redirects: Record<string, string>;
}

type Env = Record<string, string | undefined>;

interface Entry {
  body: Buffer;
  compress: boolean;
  gzip?: Buffer; // filled on the first request that accepts the encoding
  br?: Buffer;
  etag: string; // unquoted hash; variants add -gz / -br
  lastmod: number; // ms, truncated to the second
  type: string;
}

interface Page {
  path: string;
  kind: PageKind;
  indexable: boolean;
  html: Entry;
  md: Entry;
}

export interface Site {
  manifest: Manifest;
  pages: Map<string, Page>;
  files: Map<string, Entry & { format: string }>;
  notFound: { html: Entry; md: Entry };
  indexNowKey: string;
}

const HTML_TYPE = "text/html; charset=utf-8";
const MD_TYPE = "text/markdown; charset=utf-8";
const COMPRESSIBLE = /^text\/|json|xml|javascript|svg/;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function entry(body: Buffer, type: string, lastmod: string): Entry {
  const ms = Date.parse(lastmod);
  if (Number.isNaN(ms)) throw new Error(`manifest: bad lastmod ${JSON.stringify(lastmod)}`);
  return {
    body,
    compress: COMPRESSIBLE.test(type),
    etag: createHash("sha256").update(body).digest("base64url").slice(0, 27),
    lastmod: Math.floor(ms / 1000) * 1000,
    type,
  };
}

/** Insert the analytics tag (and on the home page the verification metas) before </head>. */
export function injectHead(html: string, file: string, env: Env, home: boolean): string {
  const parts = html.split("</head>");
  if (parts.length !== 2) throw new Error(`${file}: expected exactly one </head>, found ${parts.length - 1}`);
  let tags = "";
  const websiteId = env.ANALYTICS_WEBSITE_ID?.trim();
  if (websiteId) {
    const host = env.ANALYTICS_HOST?.trim() || "analytics.elusic.com";
    tags += `<script defer src="https://${escapeAttr(host)}/script.js" data-website-id="${escapeAttr(websiteId)}"></script>`;
  }
  if (home) {
    const google = env.GOOGLE_SITE_VERIFICATION?.trim();
    const bing = env.BING_SITE_VERIFICATION?.trim();
    if (google) tags += `<meta name="google-site-verification" content="${escapeAttr(google)}">`;
    if (bing) tags += `<meta name="msvalidate.01" content="${escapeAttr(bing)}">`;
  }
  return parts[0] + tags + "</head>" + parts[1];
}

export function loadSite(dist: string, env: Env): Site {
  const manifest = JSON.parse(readFileSync(join(dist, "manifest.json"), "utf8")) as Manifest;
  const read = (rel: string) => readFileSync(join(dist, rel));
  const html = (rel: string, lastmod: string, home: boolean) =>
    entry(Buffer.from(injectHead(read(rel).toString("utf8"), rel, env, home)), HTML_TYPE, lastmod);

  const pages = new Map<string, Page>();
  for (const [path, p] of Object.entries(manifest.pages)) {
    pages.set(path, {
      path,
      kind: p.kind,
      indexable: p.indexable,
      html: html(p.html, p.lastmod, p.kind === "home"),
      md: entry(read(p.md), MD_TYPE, p.lastmod),
    });
  }
  const files = new Map<string, Entry & { format: string }>();
  for (const [path, f] of Object.entries(manifest.files)) {
    files.set(path, { ...entry(read(f.file), f.type, f.lastmod), format: f.format });
  }
  const indexNowKey = env.INDEXNOW_KEY?.trim() ?? "";
  if (indexNowKey && !KEY_RE.test(indexNowKey)) throw new Error("INDEXNOW_KEY must be 8-128 characters of [A-Za-z0-9-]");
  return {
    manifest,
    pages,
    files,
    notFound: {
      html: html(manifest.notFound.html, manifest.builtAt, false),
      md: entry(read(manifest.notFound.md), MD_TYPE, manifest.builtAt),
    },
    indexNowKey,
  };
}

/** q-value of the best match for `type` in an Accept-style header (0 when absent). */
function quality(header: string | undefined, type: string): number {
  let best = 0;
  for (const part of (header ?? "").split(",")) {
    const [name = "", ...params] = part.split(";").map((s) => s.trim().toLowerCase());
    if (name !== type) continue;
    const q = params.find((p) => p.startsWith("q="));
    best = Math.max(best, q ? Number(q.slice(2)) || 0 : 1);
  }
  return best;
}

function wantsMarkdown(accept: string | undefined): boolean {
  const md = quality(accept, "text/markdown");
  return md > 0 && md >= quality(accept, "text/html");
}

function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  return header.split(",").some((t) => t.trim().replace(/^W\//, "").replace(/"/g, "").replace(/-(gz|br)$/, "") === etag);
}

/** The inclusive byte range a Range header asks for, null for the whole file. */
function byteRange(req: IncomingMessage, e: Entry): [number, number] | "unsatisfiable" | null {
  const header = req.headers.range;
  if (!header) return null;
  const ifRange = req.headers["if-range"] as string | undefined;
  if (ifRange !== undefined && ifRange.replace(/"/g, "") !== e.etag) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  const size = e.body.length;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
    if (start > end) return start >= size ? "unsatisfiable" : null;
  }
  return [start, end];
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  e: Entry,
  headers: Record<string, string>,
): void {
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader("Last-Modified", new Date(e.lastmod).toUTCString());
  if (status === 200) {
    const inm = req.headers["if-none-match"];
    const ims = req.headers["if-modified-since"];
    const fresh = inm !== undefined ? etagMatches(inm, e.etag) : ims !== undefined && Date.parse(ims) >= e.lastmod;
    if (fresh) {
      res.setHeader("ETag", `"${e.etag}"`);
      res.writeHead(304).end();
      return;
    }
  }
  const ae = req.headers["accept-encoding"];
  let body = e.body;
  let tag = e.etag;
  if (e.compress && quality(ae, "br") > 0) {
    body = e.br ??= brotliCompressSync(e.body, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5 } });
    tag += "-br";
    res.setHeader("Content-Encoding", "br");
  } else if (e.compress && quality(ae, "gzip") > 0) {
    body = e.gzip ??= gzipSync(e.body);
    tag += "-gz";
    res.setHeader("Content-Encoding", "gzip");
  }
  if (status === 200) res.setHeader("ETag", `"${tag}"`);
  res.setHeader("Content-Type", e.type);
  // Byte ranges for files sent as stored (video, images, fonts). Safari will not play a video
  // without them. A single range only; anything else gets the whole file, which RFC 9110 allows.
  if (status === 200 && !e.compress) {
    res.setHeader("Accept-Ranges", "bytes");
    const range = byteRange(req, e);
    if (range === "unsatisfiable") {
      res.setHeader("Content-Range", `bytes */${body.length}`);
      res.setHeader("Content-Length", 0);
      res.writeHead(416).end();
      return;
    }
    if (range) {
      const [start, end] = range;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
      res.setHeader("Content-Length", end - start + 1);
      res.writeHead(206);
      res.end(req.method === "HEAD" ? undefined : body.subarray(start, end + 1));
      return;
    }
  }
  res.setHeader("Content-Length", body.length);
  res.writeHead(status);
  res.end(req.method === "HEAD" ? undefined : body);
}

function redirect(res: ServerResponse, status: 301 | 302, location: string, cache: string): void {
  res.writeHead(status, { Location: location, "Cache-Control": cache, "Content-Length": 0 }).end();
}

interface LogInfo {
  kind: string;
  fmt: string;
  utmCampaign?: string;
}

export function handle(site: Site, db: DatabaseSync, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const search = url.search;
  const method = req.method ?? "GET";
  let log: LogInfo | null = null;
  res.on("finish", () => {
    if (!log) return;
    try {
      recordRequest(db, { method, path, kind: log.kind, fmt: log.fmt, status: res.statusCode, headers: req.headers,
        query: url.searchParams, utmCampaign: log.utmCampaign });
    } catch (err) {
      console.error(`request log: WRITE FAILED for ${path}: ${String(err)}`);
    }
  });

  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": 0 }).end();
    return;
  }
  const cache = { "Cache-Control": "public, max-age=300" };
  const pageVary = { ...cache, Vary: "Accept, Accept-Encoding" };
  const { manifest } = site;

  if (path === "/healthz.json") {
    const body = JSON.stringify({ ok: true, commit: manifest.commit, builtAt: manifest.builtAt,
      pages: manifest.counts.pages, sites: manifest.counts.sites });
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(method === "HEAD" ? undefined : body);
    return;
  }

  if (path === "/install") {
    const from = url.searchParams.get("from") ?? "";
    const target = new URL(CWS_URL);
    target.searchParams.set("utm_source", new URL(manifest.origin).host);
    target.searchParams.set("utm_medium", "site");
    target.searchParams.set("utm_campaign", from);
    log = { kind: "", fmt: "install", utmCampaign: from };
    redirect(res, 302, target.toString(), "no-store");
    return;
  }

  if (site.indexNowKey && path === `/${site.indexNowKey}.txt`) {
    log = { kind: "", fmt: "txt" };
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", ...cache });
    res.end(method === "HEAD" ? undefined : site.indexNowKey);
    return;
  }

  const page = site.pages.get(path);
  if (page) {
    const md = wantsMarkdown(req.headers.accept);
    log = { kind: page.kind, fmt: md ? "md" : "html" };
    sendPage(req, res, site, page, md, pageVary);
    return;
  }

  const file = site.files.get(path);
  if (file) {
    if (file.format !== "asset") log = { kind: "", fmt: file.format };
    send(req, res, 200, file, { ...cache, Vary: "Accept-Encoding" });
    return;
  }

  if (path.endsWith(".md")) {
    const base = path === "/index.md" ? "/" : path.slice(0, -3);
    const twin = site.pages.get(base);
    if (twin) {
      log = { kind: twin.kind, fmt: "md" };
      sendPage(req, res, site, twin, true, pageVary);
      return;
    }
    const moved = manifest.redirects[base];
    if (moved) {
      log = { kind: "", fmt: "md" };
      redirect(res, 301, (moved === "/" ? "/index" : moved) + ".md" + search, "public, max-age=300");
      return;
    }
  }

  const canonical = canonicalize(path);
  if (canonical !== path) {
    log = { kind: "", fmt: "html" };
    redirect(res, 301, canonical + search, "public, max-age=300");
    return;
  }
  const moved = manifest.redirects[path];
  if (moved) {
    log = { kind: "", fmt: "html" };
    redirect(res, 301, moved + search, "public, max-age=300");
    return;
  }

  const md = path.endsWith(".md") || wantsMarkdown(req.headers.accept);
  log = { kind: "", fmt: md ? "md" : "html" };
  send(req, res, 404, md ? site.notFound.md : site.notFound.html, { "Cache-Control": "no-store", Vary: "Accept, Accept-Encoding" });
}

/**
 * /a/b/ and /a/b/index.html -> /a/b; / and /index.html -> /. Repeated slashes
 * collapse so the result never starts with "//", which a browser would read as
 * an off-site Location.
 */
function canonicalize(path: string): string {
  let p = path.replace(/\/{2,}/g, "/");
  if (p.endsWith("/index.html")) p = p.slice(0, -"index.html".length);
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

function sendPage(
  req: IncomingMessage,
  res: ServerResponse,
  site: Site,
  page: Page,
  md: boolean,
  headers: Record<string, string>,
): void {
  const h: Record<string, string> = { ...headers };
  if (!page.indexable) h["X-Robots-Tag"] = "noindex, follow";
  if (md) h.Link = `<${site.manifest.origin}${page.path === "/" ? "/" : page.path}>; rel="canonical"`;
  send(req, res, 200, md ? page.md : page.html, h);
}

export interface Running {
  server: Server;
  db: DatabaseSync;
  site: Site;
  port: number;
  close(): Promise<void>;
}

export async function startServer(opts: { dist: string; dataDir: string; port: number; env: Env }): Promise<Running> {
  const site = loadSite(opts.dist, opts.env);
  const db = openDb(opts.dataDir);
  const server = createServer((req, res) => handle(site, db, req, res));
  await new Promise<void>((ok) => server.listen(opts.port, ok));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    db,
    site,
    port,
    close: () =>
      new Promise<void>((ok, fail) => server.close((err) => {
        db.close();
        if (err) fail(err);
        else ok();
      })),
  };
}

/** Every indexable page URL with its lastmod, for IndexNow. */
export function indexableUrls(site: Site): { url: string; lastmod: string }[] {
  return Object.entries(site.manifest.pages)
    .filter(([, p]) => p.indexable)
    .map(([path, p]) => ({ url: site.manifest.origin + path, lastmod: p.lastmod }));
}

async function main(): Promise<void> {
  const env = process.env;
  const running = await startServer({
    dist: resolve(env.SITE_DIST || "site/dist"),
    dataDir: resolve(env.DATA_DIR || "site/.data"),
    port: Number(env.PORT || 8080),
    env,
  });
  const { manifest } = running.site;
  console.log(`usermods-site ${manifest.commit} (built ${manifest.builtAt}) listening on :${running.port}, ` +
    `${manifest.counts.pages} pages, ${manifest.counts.sites} sites, analytics ${env.ANALYTICS_WEBSITE_ID ? "on" : "off"}`);
  if (env.SITE_ENV === "prod") {
    if (!running.site.indexNowKey) console.error("indexnow: SITE_ENV=prod but INDEXNOW_KEY is unset; nothing submitted");
    else await submitPending(running.db, manifest.origin, running.site.indexNowKey, indexableUrls(running.site));
  }
}

if (import.meta.main) await main();
