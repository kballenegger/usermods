// AI visibility panel: ask an answer engine with live web search each prompt in
// site/data/panel-prompts.json and record whether our site is among the cited sources.
// Usage: node site/bin/ai-panel.ts [--engine grok|openai] [--model <id>] [--json] [--host <site host>]
// grok: env XAI_API_KEY, model XAI_MODEL (default grok-4.6, as travel-signal's ai-panel.py).
// openai: env OPENAI_API_KEY, model --model or OPENAI_MODEL (required). Rows go to table ai_panel
// in DATA_DIR/site.db. A failed prompt is recorded with its error and makes the exit code 1.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { openDb } from "../src/traffic.ts";

const ENGINES = {
  grok: { url: "https://api.x.ai/v1/responses", keyEnv: "XAI_API_KEY", modelEnv: "XAI_MODEL", defaultModel: "grok-4.6" },
  openai: { url: "https://api.openai.com/v1/responses", keyEnv: "OPENAI_API_KEY", modelEnv: "OPENAI_MODEL", defaultModel: "" },
} as const;

interface PanelResult {
  prompt: string;
  cited: boolean;
  rank: number | null;
  ourUrls: string[];
  topDomains: string[];
}

/** Cited URLs from a Responses API answer: top-level `citations` (xAI) and url annotations (both). */
export function citedUrls(data: unknown): string[] {
  const d = data as { citations?: unknown[]; output?: { content?: { annotations?: { url?: string }[] }[] }[] };
  const urls: string[] = [];
  for (const c of d.citations ?? []) {
    const u = typeof c === "string" ? c : (c as { url?: string }).url;
    if (u) urls.push(u);
  }
  for (const item of d.output ?? []) {
    for (const c of item.content ?? []) {
      for (const a of c.annotations ?? []) if (a.url) urls.push(a.url);
    }
  }
  return urls;
}

export function scoreUrls(prompt: string, urls: string[], ourHost: string): PanelResult {
  const hosts: string[] = [];
  for (const u of urls) {
    const h = URL.canParse(u) ? new URL(u).host.replace(/^www\./, "") : "";
    if (h && !hosts.includes(h)) hosts.push(h);
  }
  const ourUrls = [...new Set(urls.filter((u) => URL.canParse(u) && new URL(u).host === ourHost))];
  const idx = hosts.indexOf(ourHost);
  return { prompt, cited: ourUrls.length > 0, rank: idx >= 0 ? idx + 1 : null, ourUrls, topDomains: hosts.slice(0, 8) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      engine: { type: "string", default: "grok" },
      model: { type: "string" },
      json: { type: "boolean", default: false },
      host: { type: "string", default: "usermods.kennethballenegger.com" },
    },
  });
  const engineName = values.engine as keyof typeof ENGINES;
  const engine = ENGINES[engineName];
  if (!engine) throw new Error(`--engine must be grok or openai, got ${values.engine}`);
  const key = process.env[engine.keyEnv];
  if (!key) throw new Error(`${engine.keyEnv} is not set`);
  const model = values.model || process.env[engine.modelEnv] || engine.defaultModel;
  if (!model) throw new Error(`no model: pass --model or set ${engine.modelEnv}`);

  const prompts = JSON.parse(readFileSync(resolve(import.meta.dirname, "../data/panel-prompts.json"), "utf8")) as string[];
  const db = openDb(resolve(process.env.DATA_DIR || "site/.data"));
  const insert = db.prepare(
    `INSERT INTO ai_panel (at, day, engine, model, prompt, cited, rank, our_urls, top_domains, error)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  );
  const results: (PanelResult & { error: string })[] = [];
  for (const prompt of prompts) {
    const at = new Date().toISOString();
    let result: PanelResult & { error: string };
    try {
      const res = await fetch(engine.url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model, input: [{ role: "user", content: prompt }], tools: [{ type: "web_search" }] }),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
      result = { ...scoreUrls(prompt, citedUrls(JSON.parse(text)), values.host), error: "" };
    } catch (err) {
      console.error(`FAILED ${prompt}: ${String(err)}`);
      result = { prompt, cited: false, rank: null, ourUrls: [], topDomains: [], error: String(err).slice(0, 500) };
    }
    insert.run(at, at.slice(0, 10), engineName, model, prompt, result.error ? null : Number(result.cited),
      result.rank, result.ourUrls.join(" "), result.topDomains.join(" "), result.error);
    results.push(result);
    if (!values.json) {
      const mark = result.error ? "ERR" : result.cited ? `YES #${result.rank}` : "no ";
      console.log(`${mark} ${prompt} | ${result.topDomains.slice(0, 6).join(" ")}`);
    }
  }
  db.close();
  const ok = results.filter((r) => !r.error);
  const cited = ok.filter((r) => r.cited).length;
  if (values.json) console.log(JSON.stringify({ engine: engineName, model, results }, null, 2));
  else console.log(`\n${engineName} ${model}: cited in ${cited}/${ok.length} answered prompts, ${results.length - ok.length} errors`);
  if (ok.length !== results.length) process.exitCode = 1;
}

if (import.meta.main) await main();
