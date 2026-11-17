// User-Agent classification for the request log, ported from The Travel Signal's
// app/traffic.py (AGENTS table and classify) and app/audience.py (browser hints,
// UA sanitizing). The one change: a UA containing "klaw-deploy/" is the deploy smoke.

export type AgentClass =
  | "browser" | "headless" | "ai" | "search" | "seo" | "social" | "monitor" | "tool" | "smoke" | "unknown";

export const CLASSES: readonly AgentClass[] = [
  "browser", "headless", "ai", "search", "seo", "social", "monitor", "tool", "smoke", "unknown",
];

// [needle in the lowercased User-Agent, family, class]. The first match wins, so a
// product that embeds another's name (Claude-User vs ClaudeBot) lists its own needle first.
export const AGENTS: readonly (readonly [string, string, AgentClass])[] = [
  ["oai-searchbot", "oai-searchbot", "ai"],
  ["chatgpt-user", "chatgpt-user", "ai"],
  ["gptbot", "gptbot", "ai"],
  ["claude-searchbot", "claude-searchbot", "ai"],
  ["claude-user", "claude-user", "ai"],
  ["claudebot", "claudebot", "ai"],
  ["anthropic-ai", "anthropic-ai", "ai"],
  ["perplexity-user", "perplexity-user", "ai"],
  ["perplexitybot", "perplexitybot", "ai"],
  ["google-extended", "google-extended", "ai"],
  ["googleother", "googleother", "ai"],
  ["gemini-deep-research", "gemini", "ai"],
  ["duckassistbot", "duckassistbot", "ai"],
  ["meta-externalagent", "meta-externalagent", "ai"],
  ["meta-externalfetcher", "meta-externalfetcher", "ai"],
  ["amazonbot", "amazonbot", "ai"],
  ["applebot-extended", "applebot-extended", "ai"],
  ["bytespider", "bytespider", "ai"],
  ["mistralai-user", "mistral", "ai"],
  ["cohere-ai", "cohere", "ai"],
  ["youbot", "youbot", "ai"],
  ["ccbot", "ccbot", "ai"],
  ["diffbot", "diffbot", "ai"],
  ["ai2bot", "ai2bot", "ai"],
  ["omgili", "omgili", "ai"],
  ["timpibot", "timpibot", "ai"],
  ["imagesiftbot", "imagesiftbot", "ai"],
  ["petalbot", "petalbot", "ai"],
  ["exasearchbot", "exa", "ai"],
  ["exafreshnesseval", "exa", "ai"],
  ["kimi-searchbot", "kimi", "ai"],
  ["kimibot", "kimi", "ai"],
  ["moonshotbot", "kimi", "ai"],
  ["grokbot", "grokbot", "ai"],
  ["deepseekbot", "deepseekbot", "ai"],
  ["chatglm-spider", "chatglm", "ai"],
  ["qwenbot", "qwenbot", "ai"],
  ["oai-adsbot", "oai-adsbot", "ai"],
  ["hunyuan", "hunyuan", "ai"],
  ["meta-webindexer", "meta-webindexer", "search"],
  ["bravebot", "bravebot", "search"],
  ["googlebot", "googlebot", "search"],
  ["bingbot", "bingbot", "search"],
  ["msnbot", "bingbot", "search"],
  ["applebot", "applebot", "search"],
  ["duckduckbot", "duckduckbot", "search"],
  ["yandexbot", "yandexbot", "search"],
  ["baiduspider", "baiduspider", "search"],
  ["yeti/", "naver", "search"],
  ["naverbot", "naver", "search"],
  ["seznambot", "seznambot", "search"],
  ["sogou", "sogou", "search"],
  ["qwantify", "qwant", "search"],
  ["yacybot", "yacy", "search"],
  ["mojeekbot", "mojeek", "search"],
  ["startmebot", "startme", "search"],
  ["ahrefsbot", "ahrefsbot", "seo"],
  ["semrushbot", "semrushbot", "seo"],
  ["mj12bot", "mj12bot", "seo"],
  ["dotbot", "dotbot", "seo"],
  ["dataforseobot", "dataforseobot", "seo"],
  ["screaming frog", "screaming-frog", "seo"],
  ["serpstatbot", "serpstatbot", "seo"],
  ["blexbot", "blexbot", "seo"],
  ["seokicks", "seokicks", "seo"],
  ["barkrowler", "barkrowler", "seo"],
  ["siteauditbot", "siteauditbot", "seo"],
  ["facebookexternalhit", "facebook", "social"],
  ["facebookcatalog", "facebook", "social"],
  ["twitterbot", "twitter", "social"],
  ["linkedinbot", "linkedin", "social"],
  ["slackbot", "slack", "social"],
  ["slack-imgproxy", "slack", "social"],
  ["discordbot", "discord", "social"],
  ["telegrambot", "telegram", "social"],
  ["whatsapp", "whatsapp", "social"],
  ["mastodon", "mastodon", "social"],
  ["bluesky cardyb", "bluesky", "social"],
  ["pinterestbot", "pinterest", "social"],
  ["skypeuripreview", "skype", "social"],
  ["embedly", "embedly", "social"],
  ["iframely", "iframely", "social"],
  ["redditbot", "reddit", "social"],
  ["snapchat", "snapchat", "social"],
  ["applenewsbot", "apple-news", "social"],
  ["feedly", "feedly", "social"],
  ["buttondown", "buttondown", "social"],
  ["uptimerobot", "uptimerobot", "monitor"],
  ["pingdom", "pingdom", "monitor"],
  ["site24x7", "site24x7", "monitor"],
  ["betteruptime", "betteruptime", "monitor"],
  ["better uptime", "betteruptime", "monitor"],
  ["statuscake", "statuscake", "monitor"],
  ["checkly", "checkly", "monitor"],
  ["hetrixtools", "hetrixtools", "monitor"],
  ["headlesschrome", "headless-chrome", "headless"],
  ["phantomjs", "phantomjs", "headless"],
  ["puppeteer", "puppeteer", "headless"],
  ["playwright", "playwright", "headless"],
  ["selenium", "selenium", "headless"],
  ["curl/", "curl", "tool"],
  ["wget/", "wget", "tool"],
  ["python-requests", "python-requests", "tool"],
  ["python-urllib", "python-urllib", "tool"],
  ["python-httpx", "httpx", "tool"],
  ["aiohttp", "aiohttp", "tool"],
  ["go-http-client", "go-http-client", "tool"],
  ["node-fetch", "node-fetch", "tool"],
  ["undici", "undici", "tool"],
  ["axios/", "axios", "tool"],
  ["okhttp", "okhttp", "tool"],
  ["java/", "java", "tool"],
  ["libwww-perl", "libwww-perl", "tool"],
  ["scrapy", "scrapy", "tool"],
  ["httpclient", "httpclient", "tool"],
  ["postmanruntime", "postman", "tool"],
  ["insomnia", "insomnia", "tool"],
  ["restsharp", "restsharp", "tool"],
  ["guzzlehttp", "guzzle", "tool"],
  ["ruby", "ruby", "tool"],
  ["bun/", "bun", "tool"],
  ["deno/", "deno", "tool"],
  ["censys", "censys", "tool"],
  ["expanse", "expanse", "tool"],
  ["zgrab", "zgrab", "tool"],
  ["masscan", "masscan", "tool"],
  ["nmap", "nmap", "tool"],
];

const SMOKE_TOKEN = "klaw-deploy/";
const UA_MAX_CHARS = 300;
const HINTS_MAX_CHARS = 120;
const LANG_MAX_CHARS = 16;
const REFERER_MAX_CHARS = 100;

const GENERIC_BOT = /(bot|crawler|spider|scraper|fetcher)(?![a-z])/i;
// "(compatible; Name/1.0; +https://example.com/about)" is the shape every
// self-declaring robot uses, whatever it calls itself.
const CALLING_CARD = /compatible;\s*[^;)]+;\s*\+(?:https?:\/\/|[\w.-]+@)/i;
// Sec-CH-UA looks like: "Chromium";v="129", "Not=A?Brand";v="8", "Google Chrome";v="129"
const HINT_BRAND = /"([^"]+)"\s*;\s*v\s*=\s*"[^"]*"/g;
const NOISE_BRAND = /not.?a.?brand|not.brand/i;
const BROWSER_HINTS = ["mozilla/", "safari/", "chrome/", "firefox/", "edge/"];
const CHROME_FAMILY_HINTS = ["chrome/", "crios/", "edg/", "edga/", "edgios/", "opr/", "samsungbrowser/", "yabrowser/"];

/** Bounded, control-character-free User-Agent. */
export function sanitizeUserAgent(raw: string | undefined): string {
  if (!raw) return "";
  return raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim().slice(0, UA_MAX_CHARS);
}

/** Collapse a Sec-CH-UA header to its brand names, noise removed: "Chromium;Google Chrome". */
export function clientHintBrands(raw: string | undefined): string {
  if (!raw) return "";
  const brands: string[] = [];
  for (const m of raw.matchAll(HINT_BRAND)) {
    const brand = (m[1] ?? "").trim();
    if (!brand || NOISE_BRAND.test(brand)) continue;
    brands.push(brand);
  }
  return brands.join(";").slice(0, HINTS_MAX_CHARS);
}

/** First tag of Accept-Language ("zh-CN,zh;q=0.9" -> "zh-CN"). */
export function primaryLanguage(raw: string | undefined): string {
  if (!raw) return "";
  const first = (raw.split(",", 1)[0] ?? "").split(";", 1)[0]?.trim() ?? "";
  if (!/^(?:[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*|\*)$/.test(first)) return "";
  return first.slice(0, LANG_MAX_CHARS);
}

/** Host part of a Referer, lowercased; empty when absent or opaque. */
export function refererHost(raw: string | undefined): string {
  if (!raw) return "";
  const m = /^\s*[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(raw);
  if (!m) return "";
  let host = (m[1] ?? "").toLowerCase();
  host = host.slice(host.lastIndexOf("@") + 1);
  host = host.split(":", 1)[0] ?? "";
  if (!/^[a-z0-9.-]{1,253}$/.test(host)) return "";
  return host.slice(0, REFERER_MAX_CHARS);
}

/**
 * [family, class] for a sanitized User-Agent. `hints` is the collapsed Sec-CH-UA brand
 * list. A browser that announces HeadlessChrome there is headless whatever its UA says;
 * a Chrome-family UA with no hints at all is a script wearing a costume, not Chrome.
 */
export function classify(userAgent: string, hints = ""): [string, AgentClass] {
  const low = (userAgent || "").toLowerCase();
  if (!low) return ["unknown", "unknown"];
  if (low.includes(SMOKE_TOKEN)) return ["smoke-test", "smoke"];
  if (hints.toLowerCase().includes("headlesschrome")) return ["headless-chrome", "headless"];
  for (const [needle, family, klass] of AGENTS) {
    if (low.includes(needle)) return [family, klass];
  }
  if (GENERIC_BOT.test(userAgent) || CALLING_CARD.test(userAgent)) return ["other-bot", "tool"];
  if (!BROWSER_HINTS.some((h) => low.includes(h))) return ["unknown", "unknown"];
  // Every Chromium build since 2021 sends Sec-CH-UA on navigations.
  // Its absence with a Chrome User-Agent means a non-browser client.
  if (CHROME_FAMILY_HINTS.some((h) => low.includes(h)) && !hints) return ["chrome-no-hints", "headless"];
  return [browserFamily(low), "browser"];
}

function browserFamily(low: string): string {
  if (low.includes("edg/") || low.includes("edga/") || low.includes("edgios/")) return "edge";
  if (low.includes("opr/")) return "opera";
  if (low.includes("samsungbrowser/")) return "samsung";
  if (low.includes("firefox/") || low.includes("fxios/")) return "firefox";
  if (low.includes("crios/") || low.includes("chrome/")) return "chrome";
  if (low.includes("safari/")) return "safari";
  return "browser";
}
