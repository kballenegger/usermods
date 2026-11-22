// IndexNow: tell Bing, Yandex, Seznam, Naver and the other participating engines which
// URLs changed. The key is served at /<key>.txt; on a prod startup every indexable URL
// whose lastmod is newer than the one recorded in indexnow_submissions goes out in one POST.

import type { DatabaseSync } from "node:sqlite";

export const ENDPOINT = "https://api.indexnow.org/indexnow";
export const KEY_RE = /^[A-Za-z0-9-]{8,128}$/;

export interface IndexablePage {
  url: string;
  lastmod: string;
}

/** URLs never submitted, or submitted with an older lastmod. */
export function pendingUrls(db: DatabaseSync, pages: IndexablePage[]): IndexablePage[] {
  const get = db.prepare("SELECT lastmod FROM indexnow_submissions WHERE url = ?");
  return pages.filter((p) => {
    const row = get.get(p.url) as { lastmod: string } | undefined;
    return !row || Date.parse(p.lastmod) > Date.parse(row.lastmod);
  });
}

export type Post = (url: string, body: string) => Promise<number>;

const fetchPost: Post = async (url, body) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body,
  });
  return res.status;
};

/**
 * Submit pending URLs once. Returns the number submitted. A non-2xx answer or a
 * network error is logged loudly and nothing is recorded, so the next startup tries again.
 */
export async function submitPending(
  db: DatabaseSync,
  origin: string,
  key: string,
  pages: IndexablePage[],
  post: Post = fetchPost,
): Promise<number> {
  const pending = pendingUrls(db, pages);
  if (pending.length === 0) {
    console.log("indexnow: nothing new to submit");
    return 0;
  }
  const host = new URL(origin).host;
  const body = JSON.stringify({
    host,
    key,
    keyLocation: `${origin}/${key}.txt`,
    urlList: pending.map((p) => p.url),
  });
  let status: number;
  try {
    status = await post(ENDPOINT, body);
  } catch (err) {
    console.error(`indexnow: SUBMISSION FAILED for ${pending.length} URLs: ${String(err)}`);
    return 0;
  }
  if (status < 200 || status >= 300) {
    console.error(`indexnow: SUBMISSION FAILED for ${pending.length} URLs: HTTP ${status}`);
    return 0;
  }
  const now = new Date().toISOString();
  const put = db.prepare(
    `INSERT INTO indexnow_submissions (url, lastmod, submitted_at, status) VALUES (?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET lastmod = excluded.lastmod, submitted_at = excluded.submitted_at,
       status = excluded.status`,
  );
  for (const p of pending) put.run(p.url, p.lastmod, now, status);
  console.log(`indexnow: submitted ${pending.length} URLs (HTTP ${status})`);
  return pending.length;
}
