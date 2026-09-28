// The background's half of update checks (the pure half is lib/updates.ts).
//
// Checks fetch; they never install. The only path that changes an installed mod is `apply`, which
// the review screen calls when the user presses "Install update", and which installs exactly the
// text that screen showed (matched by hash).
import { fetchBinary } from './install';
import { parseHeader } from './mods';
import { loadSettings } from './settings';
import {
  CHECK_BYTE_BUDGET,
  CHECK_CONCURRENCY,
  UPDATES_KEY,
  buildReviewPrompt,
  checkUrls,
  clearAvailable,
  dueForCheck,
  isHeaderOnly,
  compareRemote,
  offeredUpdate,
  parseReview,
  recordCheck,
  reviewKey,
  skipVersion,
  type UpdateMap,
  type UpdateRecord,
  type UpdateReview,
} from './updates';
import type { Mod } from './types';

export interface UpdateDeps {
  loadMods(): Promise<Mod[]>;
  /** Install `source` over `mod`: same id, values and enabled flag; dependencies refetched. */
  install(mod: Mod, source: string): Promise<void>;
  /** One tool-free model call with the user's chosen model; throws with a readable reason. */
  complete(system: string, user: string): Promise<{ text: string; model: string }>;
  /** Is there a model to ask at all? The reason is shown on the disabled button. */
  modelAvailable(): Promise<{ ok: true; model: string } | { ok: false; reason: string }>;
}

async function readMap(): Promise<UpdateMap> {
  const r = await chrome.storage.local.get(UPDATES_KEY);
  return (r[UPDATES_KEY] as UpdateMap | undefined) ?? {};
}

/** Read-modify-write one mod's record, re-reading right before the write. */
async function writeRecord(modId: string, fn: (r: UpdateRecord | undefined) => UpdateRecord | undefined): Promise<void> {
  const map = await readMap();
  const next = fn(map[modId]);
  if (next) map[modId] = next;
  else delete map[modId];
  await chrome.storage.local.set({ [UPDATES_KEY]: map });
}

/** A fetch refused for lack of access (Safari per-site grants) or the network is "could not check". */
function quietReason(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (/HTTP (\d+)/.test(m)) return `could not check (${m.match(/HTTP \d+[^:]*/)?.[0] ?? 'HTTP error'})`;
  if (/Timed out/i.test(m)) return 'could not check (timed out)';
  if (/exceeds the 5 MB/i.test(m)) return 'could not check (too large)';
  return 'could not check';
}

export function createUpdateController(deps: UpdateDeps) {
  let running: Promise<{ checked: number; offered: number }> | null = null;

  /** Fetch one mod's newest version and record what it says. Never touches the mod. */
  async function checkOne(mod: Mod, budget: { left: number }): Promise<void> {
    const urls = checkUrls(mod);
    if (!urls) return;
    const now = Date.now();
    try {
      let got = await fetchBinary(urls.check);
      budget.left -= got.bytes.byteLength;
      let source = got.text;
      let url = urls.check;
      if (!/\/\/\s*==UserScript==/.test(source)) throw new Error('not a userscript');
      // A .meta.js answer is a header: only when it says "newer" is the full script worth fetching.
      if (isHeaderOnly(source)) {
        if (compareRemote(mod.version, parseHeader(source).version) !== 'newer' || urls.download === urls.check) {
          await writeRecord(mod.id, (r) => recordCheck(r, mod, { ok: true, source: mod.source, url }, now));
          return;
        }
        if (budget.left <= 0) return;
        got = await fetchBinary(urls.download);
        budget.left -= got.bytes.byteLength;
        source = got.text;
        url = urls.download;
        if (!/\/\/\s*==UserScript==/.test(source)) throw new Error('not a userscript');
      }
      await writeRecord(mod.id, (r) => recordCheck(r, mod, { ok: true, source, url }, now));
    } catch (e) {
      await writeRecord(mod.id, (r) => recordCheck(r, mod, { ok: false, error: quietReason(e) }, now));
    }
  }

  /**
   * One round of checks: every mod due one (or just `onlyId`, forced), at most CHECK_CONCURRENCY at
   * a time and CHECK_BYTE_BUDGET in total. Off entirely when the setting is off, unless forced by
   * the user's own click on a mod.
   */
  async function check(opts: { force?: boolean; onlyId?: string } = {}): Promise<{ checked: number; offered: number }> {
    if (running && !opts.onlyId) return running;
    const work = (async () => {
      if (!opts.force && (await loadSettings()).checkUpdates === false) return { checked: 0, offered: 0 };
      const mods = await deps.loadMods();
      const map = await readMap();
      const now = Date.now();
      const due = mods.filter((m) => (opts.onlyId ? m.id === opts.onlyId : true) && (opts.force ? !!checkUrls(m) : dueForCheck(m, map[m.id], now)));
      const budget = { left: CHECK_BYTE_BUDGET };
      let i = 0;
      const worker = async () => {
        while (i < due.length && budget.left > 0) await checkOne(due[i++]!, budget);
      };
      await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, due.length) }, worker));
      const after = await readMap();
      return { checked: due.length, offered: mods.filter((m) => offeredUpdate(m, after[m.id])).length };
    })();
    if (!opts.onlyId) running = work.finally(() => (running = null));
    return work;
  }

  /** What the panel and dashboard rows need: no sources, just the offer and any quiet error. */
  async function summary(): Promise<Record<string, { available?: string; error?: string; lastChecked?: number }>> {
    const [mods, map] = await Promise.all([deps.loadMods(), readMap()]);
    const out: Record<string, { available?: string; error?: string; lastChecked?: number }> = {};
    for (const m of mods) {
      const rec = map[m.id];
      if (!rec) continue;
      const offer = offeredUpdate(m, rec);
      out[m.id] = { ...(offer ? { available: offer.version } : {}), ...(rec.error ? { error: rec.error } : {}), ...(rec.lastChecked ? { lastChecked: rec.lastChecked } : {}) };
    }
    return out;
  }

  async function get(modId: string) {
    const [mods, map] = await Promise.all([deps.loadMods(), readMap()]);
    const mod = mods.find((m) => m.id === modId);
    if (!mod) throw new Error('That mod no longer exists.');
    const offer = offeredUpdate(mod, map[modId]);
    const cached = offer ? ((await chrome.storage.local.get(reviewKey(modId, offer.hash)))[reviewKey(modId, offer.hash)] as UpdateReview | undefined) : undefined;
    return { mod, update: offer, review: cached ?? null, reviewer: await deps.modelAvailable() };
  }

  async function skip(modId: string, version: string): Promise<void> {
    await writeRecord(modId, (r) => skipVersion(r, version));
  }

  /** "Install update": exactly the text the screen showed, or nothing. */
  async function apply(modId: string, hash: string): Promise<{ version: string }> {
    const [mods, map] = await Promise.all([deps.loadMods(), readMap()]);
    const mod = mods.find((m) => m.id === modId);
    const offer = mod ? offeredUpdate(mod, map[modId]) : null;
    if (!mod || !offer) throw new Error('There is no update waiting for this mod.');
    if (offer.hash !== hash) throw new Error('The update changed since you opened it. Reload this page to review the new text.');
    await deps.install(mod, offer.source);
    await writeRecord(modId, (r) => clearAvailable(r));
    return { version: offer.version };
  }

  /**
   * "Check with the agent first": the two sources and the computed header changes, nothing else,
   * to the user's chosen model. Cached per (mod, new version's hash), so asking twice costs once and
   * closing the page does not lose the answer.
   */
  async function review(modId: string, hash: string): Promise<UpdateReview> {
    const [mods, map] = await Promise.all([deps.loadMods(), readMap()]);
    const mod = mods.find((m) => m.id === modId);
    const offer = mod ? offeredUpdate(mod, map[modId]) : null;
    if (!mod || !offer || offer.hash !== hash) throw new Error('There is no such update to review.');
    const key = reviewKey(modId, hash);
    const cached = (await chrome.storage.local.get(key))[key] as UpdateReview | undefined;
    if (cached) return cached;
    const prompt = buildReviewPrompt({ name: mod.name, oldSource: mod.source, newSource: offer.source, nonce: crypto.randomUUID().replace(/-/g, '') });
    const { text, model } = await deps.complete(prompt.system, prompt.user);
    const parsed = parseReview(text);
    if (!parsed.ok) throw new Error(`${parsed.error} Try again, or review the diff yourself.`);
    const result: UpdateReview = { ...parsed.review, model, at: Date.now() };
    await chrome.storage.local.set({ [key]: result });
    return result;
  }

  return { check, summary, get, skip, apply, review };
}
