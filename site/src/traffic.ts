// Request log in SQLite (DATA_DIR/site.db) and the traffic report over it.
// No IP addresses or client tokens are stored, and nothing is pruned.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { IncomingHttpHeaders } from "node:http";
import { classify, clientHintBrands, primaryLanguage, refererHost, sanitizeUserAgent } from "./agents.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS page_requests (
  id INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  day TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  fmt TEXT NOT NULL,
  status INTEGER NOT NULL,
  country TEXT NOT NULL,
  lang TEXT NOT NULL,
  referer_host TEXT NOT NULL,
  utm_source TEXT NOT NULL,
  utm_medium TEXT NOT NULL,
  utm_campaign TEXT NOT NULL,
  user_agent TEXT NOT NULL,
  client_hints TEXT NOT NULL,
  agent_family TEXT NOT NULL,
  agent_class TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS page_requests_day ON page_requests(day);
CREATE TABLE IF NOT EXISTS indexnow_submissions (
  url TEXT PRIMARY KEY,
  lastmod TEXT NOT NULL,
  submitted_at TEXT NOT NULL,
  status INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_panel (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  day TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  cited INTEGER,
  rank INTEGER,
  our_urls TEXT NOT NULL,
  top_domains TEXT NOT NULL,
  error TEXT NOT NULL
);
`;

export function openDb(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(join(dataDir, "site.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const v = headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export interface RequestRow {
  method: string;
  path: string;
  kind: string;
  fmt: string;
  status: number;
  headers: IncomingHttpHeaders;
  query: URLSearchParams;
  // Install clicks carry the page they came from here instead of a utm_campaign query.
  utmCampaign?: string;
  now?: Date;
}

export function recordRequest(db: DatabaseSync, row: RequestRow): void {
  const ts = (row.now ?? new Date()).toISOString();
  const ua = sanitizeUserAgent(header(row.headers, "user-agent"));
  const hints = clientHintBrands(header(row.headers, "sec-ch-ua"));
  const [family, klass] = classify(ua, hints);
  const country = (header(row.headers, "cf-ipcountry") ?? "").trim().toUpperCase();
  db.prepare(
    `INSERT INTO page_requests (ts, day, method, path, kind, fmt, status, country, lang, referer_host,
       utm_source, utm_medium, utm_campaign, user_agent, client_hints, agent_family, agent_class)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    ts, ts.slice(0, 10), row.method.toUpperCase().slice(0, 8), row.path.slice(0, 200), row.kind, row.fmt, row.status,
    /^(?:[A-Z]{2}|T1|XX)$/.test(country) ? country : "",
    primaryLanguage(header(row.headers, "accept-language")),
    refererHost(header(row.headers, "referer")),
    (row.query.get("utm_source") ?? "").slice(0, 100),
    (row.query.get("utm_medium") ?? "").slice(0, 100),
    (row.utmCampaign ?? row.query.get("utm_campaign") ?? "").slice(0, 200),
    ua, hints, family, klass,
  );
}

// ── Report ────────────────────────────────────────────────────────────────

const CHATGPT_HOSTS = ["chatgpt.com", "chat.openai.com", "openai.com"];
const OTHER_AI_HOSTS = [
  "perplexity.ai", "www.perplexity.ai", "claude.ai", "gemini.google.com", "copilot.microsoft.com",
  "grok.com", "x.ai", "chat.mistral.ai", "you.com", "phind.com", "chat.deepseek.com", "kagi.com",
  "meta.ai", "www.meta.ai",
];

type Row = Record<string, string | number | null>;

export interface TrafficReport {
  since: string;
  days: number;
  byClass: Row[];
  byBot: Row[];
  chatgptUserPages: Row[];
  chatgptReferrals: { total: number; pages: Row[] };
  otherAiReferrals: Row[];
  installsByPage: Row[];
  humanLanding: Row[];
}

export function trafficReport(db: DatabaseSync, days: number, siteHost: string, now = new Date()): TrafficReport {
  const since = new Date(now.getTime() - days * 86_400_000).toISOString();
  const all = (sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).all(since, ...params) as Row[];
  const pagesOnly = "fmt NOT IN ('install')";
  const chatgptRef =
    `(utm_source = 'chatgpt.com' OR referer_host IN (${CHATGPT_HOSTS.map(() => "?").join(",")})` +
    ` OR referer_host LIKE '%.openai.com')`;
  const chatgptRows = all(
    `SELECT path, COUNT(*) AS n FROM page_requests WHERE ts >= ? AND ${pagesOnly} AND ${chatgptRef}
     GROUP BY path ORDER BY n DESC, path LIMIT 20`,
    ...CHATGPT_HOSTS,
  );
  const aiPlaceholders = OTHER_AI_HOSTS.map(() => "?").join(",");
  return {
    since,
    days,
    byClass: all(
      `SELECT agent_class, COUNT(*) AS n, COUNT(DISTINCT path) AS paths FROM page_requests
       WHERE ts >= ? AND ${pagesOnly} GROUP BY agent_class ORDER BY n DESC`,
    ),
    byBot: all(
      `SELECT agent_class, agent_family, COUNT(*) AS n, SUM(fmt = 'md') AS md, SUM(fmt = 'llms') AS llms
       FROM page_requests WHERE ts >= ? AND ${pagesOnly} AND agent_class NOT IN ('browser', 'unknown', 'smoke')
       GROUP BY agent_class, agent_family ORDER BY n DESC LIMIT 40`,
    ),
    chatgptUserPages: all(
      `SELECT path, fmt, COUNT(*) AS n FROM page_requests WHERE ts >= ? AND agent_family = 'chatgpt-user'
       GROUP BY path, fmt ORDER BY n DESC, path LIMIT 20`,
    ),
    chatgptReferrals: {
      total: Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM page_requests WHERE ts >= ? AND ${pagesOnly} AND ${chatgptRef}`)
          .get(since, ...CHATGPT_HOSTS) as Row).n,
      ),
      pages: chatgptRows,
    },
    otherAiReferrals: db.prepare(
      `SELECT CASE WHEN referer_host IN (${aiPlaceholders}) THEN referer_host ELSE 'utm:' || utm_source END AS source,
         path, COUNT(*) AS n FROM page_requests
       WHERE ts >= ? AND ${pagesOnly} AND (referer_host IN (${aiPlaceholders}) OR utm_source IN (${aiPlaceholders}))
       GROUP BY source, path ORDER BY n DESC LIMIT 30`,
    ).all(...OTHER_AI_HOSTS, since, ...OTHER_AI_HOSTS, ...OTHER_AI_HOSTS) as Row[],
    installsByPage: all(
      `SELECT utm_campaign AS page, COUNT(*) AS n FROM page_requests
       WHERE ts >= ? AND fmt = 'install' AND agent_class = 'browser' GROUP BY utm_campaign ORDER BY n DESC LIMIT 30`,
    ),
    humanLanding: all(
      `SELECT path, COUNT(*) AS n FROM page_requests
       WHERE ts >= ? AND agent_class = 'browser' AND fmt = 'html' AND status = 200 AND referer_host != ?
       GROUP BY path ORDER BY n DESC LIMIT 20`,
      siteHost,
    ),
  };
}

export function renderReport(r: TrafficReport): string {
  const out: string[] = [`Traffic since ${r.since} (${r.days} days)`, ""];
  const table = (title: string, rows: Row[], cols: string[]) => {
    out.push(title);
    if (rows.length === 0) out.push("  (none)");
    for (const row of rows) out.push("  " + cols.map((c) => String(row[c] ?? "")).join("  "));
    out.push("");
  };
  table("Requests by agent class (class  n  distinct paths)", r.byClass, ["agent_class", "n", "paths"]);
  table("Bots (class  family  n  md  llms)", r.byBot, ["agent_class", "agent_family", "n", "md", "llms"]);
  table("ChatGPT-User fetches (path  fmt  n)", r.chatgptUserPages, ["path", "fmt", "n"]);
  table(`ChatGPT referrals: ${r.chatgptReferrals.total} (path  n)`, r.chatgptReferrals.pages, ["path", "n"]);
  table("Other AI referrals (source  path  n)", r.otherAiReferrals, ["source", "path", "n"]);
  table("Install clicks by page, browsers only (page  n)", r.installsByPage, ["page", "n"]);
  table("Top human landing pages (path  n)", r.humanLanding, ["path", "n"]);
  return out.join("\n");
}
