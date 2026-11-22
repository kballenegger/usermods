import assert from "node:assert/strict";
import { test } from "node:test";
import { classify, clientHintBrands, primaryLanguage, refererHost } from "../src/agents.ts";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const HINTS = clientHintBrands('"Chromium";v="142", "Not_A Brand";v="99", "Google Chrome";v="142"');

test("AI fetchers and crawlers are classed ai, own needle before the embedded one", () => {
  assert.deepEqual(classify("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"), ["chatgpt-user", "ai"]);
  assert.deepEqual(classify("Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)"), ["oai-searchbot", "ai"]);
  assert.deepEqual(classify("Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)"), ["claude-user", "ai"]);
  assert.deepEqual(classify("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"), ["claudebot", "ai"]);
  assert.deepEqual(classify("Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)"), ["perplexitybot", "ai"]);
});

test("search, social, tools", () => {
  assert.deepEqual(classify("Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), ["googlebot", "search"]);
  assert.deepEqual(classify("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), ["bingbot", "search"]);
  assert.deepEqual(classify("Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)"), ["slack", "social"]);
  assert.deepEqual(classify("curl/8.7.1"), ["curl", "tool"]);
  assert.deepEqual(classify("Mozilla/5.0 (compatible; SomeNewThing/1.0; +https://example.com/about)"), ["other-bot", "tool"]);
  assert.deepEqual(classify("FooCrawler 2.0"), ["other-bot", "tool"]);
});

test("Sec-CH-UA rules: HeadlessChrome in hints, Chrome UA without hints", () => {
  assert.equal(HINTS, "Chromium;Google Chrome");
  assert.deepEqual(classify(CHROME, HINTS), ["chrome", "browser"]);
  assert.deepEqual(classify(CHROME, ""), ["chrome-no-hints", "headless"]);
  assert.deepEqual(classify(CHROME, clientHintBrands('"Chromium";v="142", "HeadlessChrome";v="142"')), ["headless-chrome", "headless"]);
  assert.deepEqual(classify(CHROME.replace("Chrome/", "HeadlessChrome/"), HINTS), ["headless-chrome", "headless"]);
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  assert.deepEqual(classify(safari), ["safari", "browser"]);
  assert.deepEqual(classify("Mozilla/5.0 (Macintosh; rv:133.0) Gecko/20100101 Firefox/133.0"), ["firefox", "browser"]);
});

test("deploy smoke, empty and opaque agents", () => {
  assert.deepEqual(classify("klaw-deploy/1"), ["smoke-test", "smoke"]);
  assert.deepEqual(classify(""), ["unknown", "unknown"]);
  assert.deepEqual(classify("SomethingOdd"), ["unknown", "unknown"]);
});

test("header helpers", () => {
  assert.equal(primaryLanguage("zh-CN,zh;q=0.9"), "zh-CN");
  assert.equal(primaryLanguage("<script>"), "");
  assert.equal(refererHost("https://user@ChatGPT.com:443/c/abc?x=1"), "chatgpt.com");
  assert.equal(refererHost("android-app://com.google"), "com.google");
  assert.equal(refererHost("not a url"), "");
});
