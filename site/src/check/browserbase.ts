// Browserbase session for sites that wall Gimel's headless Chrome. Created with residential
// proxies (Browserbase solves Google's /sorry/ captcha on them); released when the run ends.
// The key comes from env BROWSERBASE_API_KEY. The connect URL embeds it: never print it.

const API = 'https://api.browserbase.com/v1';

export interface BrowserbaseSession {
  id: string;
  connectUrl: string;
}

function headers(key: string): Record<string, string> {
  return { 'x-bb-api-key': key, 'content-type': 'application/json' };
}

export async function createSession(key: string, projectId: string | undefined, timeoutSec: number): Promise<BrowserbaseSession> {
  const res = await fetch(`${API}/sessions`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({ proxies: true, timeout: timeoutSec, ...(projectId ? { projectId } : {}) }),
  });
  if (!res.ok) throw new Error(`Browserbase session create: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const s = (await res.json()) as { id?: string; connectUrl?: string };
  if (!s.id || !s.connectUrl) throw new Error('Browserbase session response lacks id/connectUrl');
  return { id: s.id, connectUrl: s.connectUrl };
}

export async function releaseSession(key: string, projectId: string | undefined, id: string): Promise<void> {
  const res = await fetch(`${API}/sessions/${id}`, {
    method: 'POST',
    headers: headers(key),
    body: JSON.stringify({ status: 'REQUEST_RELEASE', ...(projectId ? { projectId } : {}) }),
  });
  if (!res.ok) throw new Error(`Browserbase session ${id} release: HTTP ${res.status}`);
}
